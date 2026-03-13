import { create } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError } from "@connectrpc/connect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getMemoreSyncRuntimeStatus,
  MEMORE_SYNC_RUNTIME_STATUS_STORAGE_KEY,
  normalizeMemoreRemoteServerUrl,
  resetMemoreSyncMetadata,
  runMemoreSyncTaskWithLock,
  syncMemoreLocalMemosToRemote,
  syncMemoreRemoteMemosToLocal,
} from "../src/lib/memore-sync";
import { State } from "../src/types/proto/api/v1/common_pb";
import { MemoSchema, Visibility } from "../src/types/proto/api/v1/memo_service_pb";

const { mockAttachmentServiceClient, mockMemoServiceClient } = vi.hoisted(() => ({
  mockAttachmentServiceClient: {
    createAttachment: vi.fn(),
  },
  mockMemoServiceClient: {
    listMemos: vi.fn(),
    getMemo: vi.fn(),
    updateMemo: vi.fn(),
    createMemo: vi.fn(),
    deleteMemo: vi.fn(),
  },
}));

vi.mock("@/connect", () => ({
  attachmentServiceClient: mockAttachmentServiceClient,
  memoServiceClient: mockMemoServiceClient,
}));

const IMPORTED_KEY = "memore-sync-imported-remote-memo-names";
const BINDING_KEY = "memore-sync-remote-memo-bindings";
const CURSOR_KEY = "memore-sync-remote-pull-cursor";

const serverUrl = "https://sync.example.com";
const serverKey = normalizeMemoreRemoteServerUrl(serverUrl);

const readStorageMap = <T>(key: string): Record<string, T> => {
  const raw = localStorage.getItem(key);
  if (!raw) {
    return {};
  }
  return JSON.parse(raw) as Record<string, T>;
};

const jsonResponse = (status: number, payload: Record<string, unknown>) => {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json",
    },
  });
};

const createLocalMemo = (name: string, updateTimeRaw: string, content: string) => {
  const updateTime = timestampFromDate(new Date(updateTimeRaw));
  return create(MemoSchema, {
    name,
    state: State.NORMAL,
    creator: "users/u1",
    content,
    visibility: Visibility.PRIVATE,
    pinned: false,
    createTime: updateTime,
    updateTime,
  });
};

beforeEach(() => {
  mockAttachmentServiceClient.createAttachment.mockReset();
  mockMemoServiceClient.listMemos.mockReset();
  mockMemoServiceClient.getMemo.mockReset();
  mockMemoServiceClient.updateMemo.mockReset();
  mockMemoServiceClient.createMemo.mockReset();
  mockMemoServiceClient.deleteMemo.mockReset();
});

describe("memore sync regression", () => {
  it("resetMemoreSyncMetadata should clear imported/binding/cursor and runtime status", () => {
    const otherServer = "https://other.example.com";
    const otherServerKey = normalizeMemoreRemoteServerUrl(otherServer);

    localStorage.setItem(
      IMPORTED_KEY,
      JSON.stringify({
        [serverKey]: ["memos/1"],
        [otherServerKey]: ["memos/2"],
      }),
    );
    localStorage.setItem(
      BINDING_KEY,
      JSON.stringify({
        [serverKey]: {
          "memos/1": {
            localMemoName: "memos/local-1",
          },
        },
        [otherServerKey]: {
          "memos/2": {
            localMemoName: "memos/local-2",
          },
        },
      }),
    );
    localStorage.setItem(
      CURSOR_KEY,
      JSON.stringify({
        [serverKey]: "2024-01-01T00:00:00.000Z",
        [otherServerKey]: "2024-02-01T00:00:00.000Z",
      }),
    );
    localStorage.setItem(
      MEMORE_SYNC_RUNTIME_STATUS_STORAGE_KEY,
      JSON.stringify({
        [serverKey]: {
          lastPushAt: "2024-01-01T00:00:00.000Z",
        },
        [otherServerKey]: {
          lastPullAt: "2024-02-01T00:00:00.000Z",
        },
      }),
    );

    resetMemoreSyncMetadata(`${serverUrl}/`);

    const importedMap = readStorageMap<string[]>(IMPORTED_KEY);
    const bindingMap = readStorageMap<Record<string, unknown>>(BINDING_KEY);
    const cursorMap = readStorageMap<string>(CURSOR_KEY);
    const runtimeMap = readStorageMap<Record<string, unknown>>(MEMORE_SYNC_RUNTIME_STATUS_STORAGE_KEY);

    expect(importedMap[serverKey]).toBeUndefined();
    expect(bindingMap[serverKey]).toBeUndefined();
    expect(cursorMap[serverKey]).toBeUndefined();
    expect(runtimeMap[serverKey]).toEqual({});

    expect(importedMap[otherServerKey]).toEqual(["memos/2"]);
    expect(bindingMap[otherServerKey]).toBeDefined();
    expect(cursorMap[otherServerKey]).toBe("2024-02-01T00:00:00.000Z");
    expect(runtimeMap[otherServerKey]?.lastPullAt).toBe("2024-02-01T00:00:00.000Z");
  });

  it("syncMemoreRemoteMemosToLocal should keep local memo on LWW conflict and record conflict log", async () => {
    localStorage.setItem(
      IMPORTED_KEY,
      JSON.stringify({
        [serverKey]: ["memos/100"],
      }),
    );
    localStorage.setItem(
      BINDING_KEY,
      JSON.stringify({
        [serverKey]: {
          "memos/100": {
            localMemoName: "memos/local-1",
            remoteUpdateTime: "2024-01-01T00:00:00.000Z",
            localUpdateTime: "2024-01-01T00:00:00.000Z",
          },
        },
      }),
    );

    const fetchMock = vi.mocked(globalThis.fetch);
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        memos: [
          {
            name: "memos/100",
            content: "remote content",
            visibility: "PRIVATE",
            pinned: false,
            createTime: "2024-01-01T00:00:00.000Z",
            updateTime: "2024-01-02T00:00:00.000Z",
          },
        ],
        nextPageToken: "",
      }),
    );

    mockMemoServiceClient.getMemo.mockResolvedValueOnce(createLocalMemo("memos/local-1", "2024-01-03T00:00:00.000Z", "local content"));

    const result = await syncMemoreRemoteMemosToLocal({
      serverUrl,
      accessToken: "token",
      pageSize: 50,
      maxPages: 5,
    });

    expect(result.ok).toBe(true);
    expect(result.conflictCount).toBe(1);
    expect(result.skippedCount).toBe(1);
    expect(result.updatedCount).toBe(0);
    expect(mockMemoServiceClient.updateMemo).not.toHaveBeenCalled();

    const runtimeStatus = getMemoreSyncRuntimeStatus(serverKey);
    expect(runtimeStatus.lastPullConflictLogs).toHaveLength(1);
    expect(runtimeStatus.lastPullConflictLogs?.[0]).toMatchObject({
      remoteMemoName: "memos/100",
      localMemoName: "memos/local-1",
      remoteUpdateTime: "2024-01-02T00:00:00.000Z",
      localUpdateTime: "2024-01-03T00:00:00.000Z",
    });

    const cursorMap = readStorageMap<string>(CURSOR_KEY);
    expect(cursorMap[serverKey]).toBe("2024-01-02T00:00:00.000Z");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("syncMemoreRemoteMemosToLocal should still run deletion sweep after cursor short-circuit", async () => {
    localStorage.setItem(
      CURSOR_KEY,
      JSON.stringify({
        [serverKey]: "2024-01-05T00:00:00.000Z",
      }),
    );
    localStorage.setItem(
      IMPORTED_KEY,
      JSON.stringify({
        [serverKey]: ["memos/deleted"],
      }),
    );
    localStorage.setItem(
      BINDING_KEY,
      JSON.stringify({
        [serverKey]: {
          "memos/deleted": {
            localMemoName: "memos/local-deleted",
            remoteUpdateTime: "2024-01-01T00:00:00.000Z",
            localUpdateTime: "2024-01-01T00:00:00.000Z",
          },
        },
      }),
    );

    const fetchMock = vi.mocked(globalThis.fetch);
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(200, {
          memos: [
            {
              name: "memos/cursor-hit",
              content: "known memo",
              visibility: "PRIVATE",
              pinned: false,
              createTime: "2024-01-05T00:00:00.000Z",
              updateTime: "2024-01-05T00:00:00.000Z",
            },
          ],
          nextPageToken: "next-page-token",
        }),
      )
      .mockResolvedValueOnce(jsonResponse(404, { message: "not found" }));

    mockMemoServiceClient.deleteMemo.mockResolvedValue(undefined);

    const result = await syncMemoreRemoteMemosToLocal({
      serverUrl,
      accessToken: "token",
      pageSize: 50,
      maxPages: 5,
    });

    expect(result.ok).toBe(true);
    expect(result.deletedCount).toBe(1);
    expect(mockMemoServiceClient.deleteMemo).toHaveBeenCalledWith({
      name: "memos/local-deleted",
      force: true,
    });

    const importedMap = readStorageMap<string[]>(IMPORTED_KEY);
    const bindingMap = readStorageMap<Record<string, unknown>>(BINDING_KEY);
    expect(importedMap[serverKey] ?? []).not.toContain("memos/deleted");
    expect(bindingMap[serverKey]?.["memos/deleted"]).toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("syncMemoreRemoteMemosToLocal should download remote attachment content even when externalLink is present", async () => {
    const fetchMock = vi.mocked(globalThis.fetch);
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(200, {
          memos: [
            {
              name: "memos/attachment-remote",
              content: "remote memo with attachment",
              visibility: "PRIVATE",
              pinned: false,
              createTime: "2024-01-01T00:00:00.000Z",
              updateTime: "2024-01-02T00:00:00.000Z",
              attachments: [
                {
                  name: "attachments/remote-att-1",
                  filename: "cloud.zip",
                  type: "application/zip",
                  size: "4",
                  externalLink: "s3://bucket/path/cloud.zip",
                },
              ],
            },
          ],
          nextPageToken: "",
        }),
      )
      .mockResolvedValueOnce(
        new Response(new Uint8Array([1, 2, 3, 4]), {
          status: 200,
          headers: {
            "Content-Type": "application/octet-stream",
          },
        }),
      );

    mockAttachmentServiceClient.createAttachment.mockResolvedValueOnce({
      name: "attachments/remote-att-1",
    });
    mockMemoServiceClient.createMemo.mockResolvedValueOnce(
      createLocalMemo("memos/local-remote-1", "2024-01-02T00:00:00.000Z", "remote memo with attachment"),
    );

    const result = await syncMemoreRemoteMemosToLocal({
      serverUrl,
      accessToken: "token",
      pageSize: 50,
      maxPages: 5,
    });

    expect(result.ok).toBe(true);
    expect(result.importedCount).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("/file/attachments/remote-att-1/cloud.zip");

    const createAttachmentArg = mockAttachmentServiceClient.createAttachment.mock.calls[0]?.[0] as {
      attachmentId?: string;
      attachment?: { filename?: string; content?: Uint8Array };
    };
    expect(createAttachmentArg.attachmentId).toBe("remote-att-1");
    expect(createAttachmentArg.attachment?.filename).toBe("cloud.zip");
    expect(Array.from(createAttachmentArg.attachment?.content ?? [])).toEqual([1, 2, 3, 4]);

    const createMemoArg = mockMemoServiceClient.createMemo.mock.calls[0]?.[0] as {
      memo?: { attachments?: Array<{ name?: string }> };
    };
    expect(createMemoArg.memo?.attachments?.[0]?.name).toBe("attachments/remote-att-1");
  });

  it("syncMemoreLocalMemosToRemote should delete remote memo when local binding target is already deleted", async () => {
    localStorage.setItem(
      IMPORTED_KEY,
      JSON.stringify({
        [serverKey]: ["memos/remote-deleted"],
      }),
    );
    localStorage.setItem(
      BINDING_KEY,
      JSON.stringify({
        [serverKey]: {
          "memos/remote-deleted": {
            localMemoName: "memos/local-missing",
            remoteUpdateTime: "2024-01-01T00:00:00.000Z",
            localUpdateTime: "2024-01-01T00:00:00.000Z",
          },
        },
      }),
    );

    mockMemoServiceClient.listMemos.mockResolvedValueOnce({
      memos: [],
      nextPageToken: "",
    });
    mockMemoServiceClient.getMemo.mockRejectedValueOnce(new ConnectError("not found", Code.NotFound));

    const fetchMock = vi.mocked(globalThis.fetch);
    fetchMock.mockResolvedValueOnce(jsonResponse(200, {}));

    const result = await syncMemoreLocalMemosToRemote({
      serverUrl,
      accessToken: "token",
      pageSize: 50,
      maxPages: 5,
    });

    expect(result.ok).toBe(true);
    expect(result.deletedCount).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toContain("/api/v1/memos/remote-deleted");

    const importedMap = readStorageMap<string[]>(IMPORTED_KEY);
    const bindingMap = readStorageMap<Record<string, unknown>>(BINDING_KEY);
    expect(importedMap[serverKey] ?? []).not.toContain("memos/remote-deleted");
    expect(bindingMap[serverKey]?.["memos/remote-deleted"]).toBeUndefined();
  });

  it("runMemoreSyncTaskWithLock should block concurrent runs for the same server", async () => {
    let releaseFirstTask: ((value: string) => void) | undefined;

    const firstRunPromise = runMemoreSyncTaskWithLock(serverUrl, async () => {
      return await new Promise<string>((resolve) => {
        releaseFirstTask = resolve;
      });
    });

    const secondRunResult = await runMemoreSyncTaskWithLock(serverUrl, async () => {
      return "second";
    });

    expect(secondRunResult).toEqual({
      ok: false,
      reason: "LOCKED",
    });

    releaseFirstTask?.("first");
    const firstRunResult = await firstRunPromise;

    expect(firstRunResult).toEqual({
      ok: true,
      value: "first",
    });

    const thirdRunResult = await runMemoreSyncTaskWithLock(serverUrl, async () => {
      return "third";
    });

    expect(thirdRunResult).toEqual({
      ok: true,
      value: "third",
    });
  });
});
