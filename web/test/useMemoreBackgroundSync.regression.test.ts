import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  cleanupCallbacks,
  mockInvalidateQueries,
  mockRunMemoreSyncTaskWithLock,
  mockSyncMemoreLocalMemosToRemote,
  mockSyncMemoreRemoteMemosToLocal,
  mockUpdateMemoreSyncBackgroundRuntimeStatus,
  mockUseMemoreSyncPreferences,
  mockUseQueryClient,
} = vi.hoisted(() => {
  const cleanupCallbacks: Array<() => void> = [];

  return {
    cleanupCallbacks,
    mockInvalidateQueries: vi.fn(),
    mockRunMemoreSyncTaskWithLock: vi.fn(),
    mockSyncMemoreLocalMemosToRemote: vi.fn(),
    mockSyncMemoreRemoteMemosToLocal: vi.fn(),
    mockUpdateMemoreSyncBackgroundRuntimeStatus: vi.fn(),
    mockUseMemoreSyncPreferences: vi.fn(),
    mockUseQueryClient: vi.fn(),
  };
});

vi.mock("react", () => ({
  useEffect: (effect: () => void | (() => void)) => {
    const cleanup = effect();
    if (typeof cleanup === "function") {
      cleanupCallbacks.push(cleanup);
    }
  },
  useRef: (initialValue: unknown) => ({ current: initialValue }),
}));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: mockUseQueryClient,
}));

vi.mock("@/hooks/useMemoreSyncPreferences", () => ({
  useMemoreSyncPreferences: mockUseMemoreSyncPreferences,
}));

vi.mock("@/hooks/useMemoQueries", () => ({
  memoKeys: {
    lists: () => ["memo", "lists"],
  },
}));

vi.mock("@/hooks/useUserQueries", () => ({
  userKeys: {
    stats: () => ["user", "stats"],
  },
}));

vi.mock("@/lib/memore-sync", () => ({
  runMemoreSyncTaskWithLock: mockRunMemoreSyncTaskWithLock,
  syncMemoreLocalMemosToRemote: mockSyncMemoreLocalMemosToRemote,
  syncMemoreRemoteMemosToLocal: mockSyncMemoreRemoteMemosToLocal,
  updateMemoreSyncBackgroundRuntimeStatus: mockUpdateMemoreSyncBackgroundRuntimeStatus,
}));

import { useMemoreBackgroundSync } from "../src/hooks/useMemoreBackgroundSync";

const successPushResult = {
  ok: true,
  totalLocalMemoCount: 1,
  pushedPages: 1,
  createdCount: 0,
  updatedCount: 0,
  deletedCount: 0,
  skippedCount: 0,
  failedCount: 0,
} as const;

const successPullResult = {
  ok: true,
  totalMemoCount: 1,
  pulledPages: 1,
  importedCount: 0,
  updatedCount: 0,
  deletedCount: 0,
  conflictCount: 0,
  skippedCount: 0,
  failedCount: 0,
} as const;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  vi.stubGlobal("window", globalThis);

  mockInvalidateQueries.mockReset();
  mockRunMemoreSyncTaskWithLock.mockReset();
  mockSyncMemoreLocalMemosToRemote.mockReset();
  mockSyncMemoreRemoteMemosToLocal.mockReset();
  mockUpdateMemoreSyncBackgroundRuntimeStatus.mockReset();
  mockUseMemoreSyncPreferences.mockReset();
  mockUseQueryClient.mockReset();

  mockInvalidateQueries.mockResolvedValue(undefined);
  mockUseQueryClient.mockReturnValue({
    invalidateQueries: mockInvalidateQueries,
  });
  mockUseMemoreSyncPreferences.mockReturnValue({
    syncPreferences: {
      enableRemoteSync: true,
      remoteServerUrl: "https://sync.example.com",
      remoteAccessToken: "token",
      autoSyncOnStartup: true,
    },
  });
  mockRunMemoreSyncTaskWithLock.mockImplementation(async (_serverUrl: string, task: () => Promise<unknown>) => {
    const value = await task();
    return {
      ok: true,
      value,
    };
  });
  mockSyncMemoreLocalMemosToRemote.mockResolvedValue(successPushResult);
  mockSyncMemoreRemoteMemosToLocal.mockResolvedValue(successPullResult);
});

afterEach(() => {
  while (cleanupCallbacks.length > 0) {
    const cleanup = cleanupCallbacks.pop();
    cleanup?.();
  }
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("useMemoreBackgroundSync regression", () => {
  it("should apply exponential backoff after push phase failure", async () => {
    const setTimeoutSpy = vi.spyOn(window, "setTimeout");

    mockSyncMemoreLocalMemosToRemote.mockResolvedValueOnce({
      ok: false,
      errorCode: "NETWORK",
    });

    useMemoreBackgroundSync(true);

    await vi.advanceTimersByTimeAsync(60 * 1000);

    const delayCalls = setTimeoutSpy.mock.calls.map((call) => Number(call[1]));
    expect(delayCalls).toContain(60 * 1000);
    expect(delayCalls).toContain(30 * 1000);

    const states = mockUpdateMemoreSyncBackgroundRuntimeStatus.mock.calls
      .map((call) => call[1]?.backgroundSyncState)
      .filter(Boolean);
    expect(states).toContain("running");
    expect(states).toContain("backoff");

    expect(mockUpdateMemoreSyncBackgroundRuntimeStatus).toHaveBeenCalledWith(
      "https://sync.example.com",
      expect.objectContaining({
        backgroundSyncState: "backoff",
        backgroundRetryCount: 1,
      }),
    );
  });

  it("should keep interval scheduling on lock conflict without backoff", async () => {
    const setTimeoutSpy = vi.spyOn(window, "setTimeout");

    mockRunMemoreSyncTaskWithLock.mockResolvedValueOnce({
      ok: false,
      reason: "LOCKED",
    });

    useMemoreBackgroundSync(true);

    await vi.advanceTimersByTimeAsync(60 * 1000);

    const delayCalls = setTimeoutSpy.mock.calls.map((call) => Number(call[1]));
    expect(delayCalls).toContain(60 * 1000);
    expect(delayCalls).toContain(5 * 60 * 1000);
    expect(mockSyncMemoreLocalMemosToRemote).not.toHaveBeenCalled();

    const states = mockUpdateMemoreSyncBackgroundRuntimeStatus.mock.calls
      .map((call) => call[1]?.backgroundSyncState)
      .filter(Boolean);
    expect(states).toContain("locked");
    expect(states).toContain("waiting");
    expect(states).not.toContain("backoff");
  });

  it("should reset retry count and invalidate queries after successful recovery", async () => {
    const setTimeoutSpy = vi.spyOn(window, "setTimeout");

    mockSyncMemoreLocalMemosToRemote
      .mockResolvedValueOnce({
        ok: false,
        errorCode: "NETWORK",
      })
      .mockResolvedValueOnce({
        ok: true,
        totalLocalMemoCount: 2,
        pushedPages: 1,
        createdCount: 1,
        updatedCount: 0,
        deletedCount: 0,
        skippedCount: 0,
        failedCount: 0,
      });
    mockSyncMemoreRemoteMemosToLocal.mockResolvedValueOnce({
      ok: true,
      totalMemoCount: 2,
      pulledPages: 1,
      importedCount: 1,
      updatedCount: 0,
      deletedCount: 0,
      conflictCount: 0,
      skippedCount: 0,
      failedCount: 0,
    });

    useMemoreBackgroundSync(true);

    await vi.advanceTimersByTimeAsync(60 * 1000);
    await vi.advanceTimersByTimeAsync(30 * 1000);

    expect(mockInvalidateQueries).toHaveBeenCalledTimes(2);
    expect(mockUpdateMemoreSyncBackgroundRuntimeStatus).toHaveBeenCalledWith(
      "https://sync.example.com",
      expect.objectContaining({
        backgroundRetryCount: 0,
      }),
    );

    const delayCalls = setTimeoutSpy.mock.calls.map((call) => Number(call[1]));
    expect(delayCalls).toContain(30 * 1000);
    expect(delayCalls).toContain(5 * 60 * 1000);
  });
});
