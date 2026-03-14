/**
 * Memore 同步核心模块
 *
 * 负责 Memore 本地实例与远端 Memos 服务器之间的数据同步。
 *
 * 主要功能：
 * - 远端连接测试（testMemoreRemoteConnection）
 * - 本地笔记推送到远端（syncMemoreLocalMemosToRemote / Push）
 * - 远端笔记拉取到本地（syncMemoreRemoteMemosToLocal / Pull）
 * - 附件双向同步（ensureLocalAttachmentForRemoteMemo / syncLocalMemoAttachmentsToRemote）
 * - 同步元数据管理（binding 映射、importedNames、pullCursor）
 * - 运行时状态追踪（syncing / success / error）
 * - 标签页锁机制（防止多窗口同时同步）
 * - 内容指纹去重（防止重复创建笔记）
 * - 元数据导出/导入（备份与恢复）
 *
 * 冲突策略：Last-Writer-Wins（LWW），根据 updateTime 判断
 *
 * 依赖：
 * - @bufbuild/protobuf：protobuf 消息构造
 * - @connectrpc/connect：RPC 客户端（本地 API 调用）
 * - fetch API：远端 REST API 调用
 */
import { create } from "@bufbuild/protobuf";
import { FieldMaskSchema, timestampDate, timestampFromDate } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-web";
import { getAccessToken } from "@/auth-state";
import { attachmentServiceClient, memoServiceClient } from "@/connect";
import { buildMemosApiUrl, getMemosApiBaseUrl } from "@/lib/memos-api-base-url";
import { type Attachment, AttachmentSchema, AttachmentService } from "@/types/proto/api/v1/attachment_service_pb";
import { State } from "@/types/proto/api/v1/common_pb";
import { ListMemosRequestSchema, type Memo, MemoSchema, Visibility } from "@/types/proto/api/v1/memo_service_pb";

// 获取本地 Memore API 基础 URL（代理请求发到本地后端）
const getLocalApiBaseUrl = (): string => getMemosApiBaseUrl();

// 获取本地用户的 Authorization 头（用于代理端点鉴权）
const getLocalAuthHeader = (): string => {
  const token = getAccessToken();
  return token ? `Bearer ${token}` : "";
};

// 内容指纹：用内容前 200 字符 + createTime 生成简单哈希，用于去重检测
const computeContentFingerprint = (content: string, createTimeIso?: string): string => {
  const normalized = content.trim().slice(0, 200);
  const timeStr = createTimeIso ?? "";
  let hash = 0;
  const combined = `${normalized}|${timeStr}`;
  for (let i = 0; i < combined.length; i++) {
    hash = ((hash << 5) - hash + combined.charCodeAt(i)) | 0;
  }
  return `fp_${hash.toString(36)}`;
};

export type MemoreRemoteConnectionTestErrorCode =
  | "INVALID_URL"
  | "MISSING_TOKEN"
  | "NETWORK"
  | "PROFILE_REQUEST_FAILED"
  | "AUTH_REQUEST_FAILED"
  | "MEMO_LIST_FAILED";

export interface MemoreRemoteConnectionTestInput {
  serverUrl: string;
  accessToken: string;
}

export interface MemoreRemoteConnectionTestResult {
  ok: boolean;
  errorCode?: MemoreRemoteConnectionTestErrorCode;
  serverMessage?: string;
  username?: string;
  userResourceName?: string;
  instanceUrl?: string;
}

export interface MemoreRemotePullInput {
  serverUrl: string;
  accessToken: string;
  pageSize?: number;
  maxPages?: number;
  /** Dry Run 模式：只扫描和统计，不执行实际的创建/更新/删除操作 */
  dryRun?: boolean;
  /** 跳过删除安全检查（用户已确认大量删除） */
  confirmDeletions?: boolean;
  /** 同步置顶状态（双向） */
  syncPinned?: boolean;
  /** 同步归档状态（双向） */
  syncArchived?: boolean;
}

/** 同步安全检查：超过此阈值的删除操作需要用户手动确认 */
const SYNC_DELETION_CONFIRM_THRESHOLD = 2;

export interface MemoreRemotePullResult {
  ok: boolean;
  errorCode?: MemoreRemoteConnectionTestErrorCode;
  serverMessage?: string;
  totalMemoCount?: number;
  pulledPages?: number;
  importedCount?: number;
  updatedCount?: number;
  deletedCount?: number;
  conflictCount?: number;
  skippedCount?: number;
  failedCount?: number;
  /** 是否为 Dry Run（预览模式，未实际写入） */
  dryRun?: boolean;
  /** 当待删除数量超过阈值且未确认时，设为 true 并中止 */
  needsDeletionConfirmation?: boolean;
  /** 待确认的删除数量 */
  pendingDeletionCount?: number;
}

export interface MemoreLocalPushResult {
  ok: boolean;
  errorCode?: MemoreRemoteConnectionTestErrorCode;
  serverMessage?: string;
  totalLocalMemoCount?: number;
  pushedPages?: number;
  createdCount?: number;
  updatedCount?: number;
  deletedCount?: number;
  skippedCount?: number;
  failedCount?: number;
  /** 是否为 Dry Run（预览模式，未实际写入） */
  dryRun?: boolean;
  /** 当待删除数量超过阈值且未确认时，设为 true 并中止 */
  needsDeletionConfirmation?: boolean;
  /** 待确认的删除数量 */
  pendingDeletionCount?: number;
}

export interface MemoreSyncConflictLog {
  remoteMemoName: string;
  localMemoName: string;
  localUpdateTime?: string;
  remoteUpdateTime?: string;
  recordedAt: string;
}

export type MemoreSyncBackgroundState = "idle" | "waiting" | "running" | "backoff" | "locked";

export interface MemoreSyncRuntimeStatus {
  lastPushAt?: string;
  lastPullAt?: string;
  lastPushSummary?: {
    totalLocalMemoCount?: number;
    pushedPages?: number;
    createdCount?: number;
    updatedCount?: number;
    deletedCount?: number;
    skippedCount?: number;
    failedCount?: number;
  };
  lastPullSummary?: {
    totalMemoCount?: number;
    pulledPages?: number;
    importedCount?: number;
    updatedCount?: number;
    deletedCount?: number;
    conflictCount?: number;
    skippedCount?: number;
    failedCount?: number;
  };
  lastPullConflictLogs?: MemoreSyncConflictLog[];
  backgroundSyncState?: MemoreSyncBackgroundState;
  backgroundLastAttemptAt?: string;
  backgroundLastSuccessAt?: string;
  backgroundNextRunAt?: string;
  backgroundRetryCount?: number;
  lastErrorAt?: string;
  lastErrorPhase?: "push" | "pull" | "connection";
  lastErrorMessage?: string;
}

export interface MemoreSyncBackgroundRuntimeStatusPatch {
  backgroundSyncState?: MemoreSyncBackgroundState;
  backgroundLastAttemptAt?: string;
  backgroundLastSuccessAt?: string;
  backgroundNextRunAt?: string;
  backgroundRetryCount?: number;
}

export interface MemoreSyncRuntimeStatusEventDetail {
  serverUrl: string;
  status: MemoreSyncRuntimeStatus;
}

export type MemoreSyncTaskLockResult<T> = { ok: true; value: T } | { ok: false; reason: "LOCKED" | "IN_PROGRESS" };

const MEMORE_IMPORTED_REMOTE_MEMO_STORAGE_KEY = "memore-sync-imported-remote-memo-names";
const MEMORE_REMOTE_MEMO_BINDING_STORAGE_KEY = "memore-sync-remote-memo-bindings";
const MEMORE_REMOTE_PULL_CURSOR_STORAGE_KEY = "memore-sync-remote-pull-cursor";
const MAX_MEMORE_SYNC_CONFLICT_LOGS = 50;
const MEMORE_SYNC_TAB_LOCK_STORAGE_KEY = "memore-sync-tab-locks";
const MEMORE_SYNC_TAB_LOCK_TTL_MS = 3 * 60 * 1000;
const MEMORE_SYNC_TAB_LOCK_RENEW_INTERVAL_MS = 30 * 1000;
export const MEMORE_SYNC_RUNTIME_STATUS_STORAGE_KEY = "memore-sync-runtime-status";
export const MEMORE_SYNC_RUNTIME_STATUS_EVENT = "memore-sync-runtime-status-updated";

type ImportedRemoteMemoMap = Record<string, string[]>;
type MemoreRemotePullCursorMap = Record<string, string>;
type MemoreSyncRuntimeStatusMap = Record<string, MemoreSyncRuntimeStatus>;

interface MemoreSyncTabLock {
  ownerId: string;
  lockId: string;
  expiresAt: number;
}

type MemoreSyncTabLockMap = Record<string, MemoreSyncTabLock>;

interface RemoteMemoBinding {
  localMemoName: string;
  remoteUpdateTime?: string;
  localUpdateTime?: string;
}

type RemoteMemoBindingMap = Record<string, Record<string, RemoteMemoBinding>>;

const createMemoreSyncTabId = (): string => {
  try {
    if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
      return crypto.randomUUID();
    }
  } catch {
    // ignore
  }

  return `memore-sync-tab-${Date.now()}-${Math.random().toString(36).slice(2)}`;
};

const createMemoreSyncTaskLockId = (): string => {
  try {
    if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
      return crypto.randomUUID();
    }
  } catch {
    // ignore
  }

  return `memore-sync-lock-${Date.now()}-${Math.random().toString(36).slice(2)}`;
};

const MEMORE_SYNC_TAB_ID = createMemoreSyncTabId();

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null;
};

const readString = (value: unknown, key: string): string | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }

  const candidate = value[key];
  return typeof candidate === "string" ? candidate : undefined;
};

const readBoolean = (value: unknown, key: string): boolean | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }

  const candidate = value[key];
  return typeof candidate === "boolean" ? candidate : undefined;
};

const readNumber = (value: unknown, key: string): number | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }

  const candidate = value[key];
  return typeof candidate === "number" ? candidate : undefined;
};

const readBigInt = (value: unknown, key: string): bigint | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }

  const candidate = value[key];
  if (typeof candidate === "bigint") {
    return candidate;
  }
  if (typeof candidate === "number" && Number.isFinite(candidate)) {
    return BigInt(Math.trunc(candidate));
  }
  if (typeof candidate === "string") {
    try {
      return BigInt(candidate);
    } catch {
      return undefined;
    }
  }

  return undefined;
};

const parseMemoreSyncConflictLog = (value: unknown): MemoreSyncConflictLog | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }

  const remoteMemoName = readString(value, "remoteMemoName");
  const localMemoName = readString(value, "localMemoName");
  const recordedAt = readString(value, "recordedAt");
  if (!remoteMemoName || !localMemoName || !recordedAt) {
    return undefined;
  }

  return {
    remoteMemoName,
    localMemoName,
    localUpdateTime: readString(value, "localUpdateTime"),
    remoteUpdateTime: readString(value, "remoteUpdateTime"),
    recordedAt,
  };
};

const parseMemoreSyncBackgroundState = (value: unknown): MemoreSyncBackgroundState | undefined => {
  if (typeof value !== "string") {
    return undefined;
  }

  if (value === "idle" || value === "waiting" || value === "running" || value === "backoff" || value === "locked") {
    return value;
  }

  return undefined;
};

const loadMemoreSyncTabLockMap = (): MemoreSyncTabLockMap => {
  try {
    const rawValue = localStorage.getItem(MEMORE_SYNC_TAB_LOCK_STORAGE_KEY);
    if (!rawValue) {
      return {};
    }

    const parsed = JSON.parse(rawValue) as unknown;
    if (!isRecord(parsed)) {
      return {};
    }

    const now = Date.now();
    const map: MemoreSyncTabLockMap = {};
    for (const [serverKey, rawLock] of Object.entries(parsed)) {
      if (!isRecord(rawLock)) {
        continue;
      }

      const ownerId = readString(rawLock, "ownerId");
      const lockId = readString(rawLock, "lockId");
      const expiresAt = readNumber(rawLock, "expiresAt");
      if (!ownerId || !lockId || expiresAt === undefined || expiresAt <= now) {
        continue;
      }

      map[serverKey] = {
        ownerId,
        lockId,
        expiresAt,
      };
    }

    return map;
  } catch {
    return {};
  }
};

const persistMemoreSyncTabLockMap = (map: MemoreSyncTabLockMap) => {
  try {
    localStorage.setItem(MEMORE_SYNC_TAB_LOCK_STORAGE_KEY, JSON.stringify(map));
  } catch {
    // 忽略 localStorage 异常（隐私模式、配额超限等）
  }
};

const tryAcquireMemoreSyncTabLock = (remoteServerKey: string, lockId: string): boolean => {
  if (!remoteServerKey) {
    return true;
  }

  const map = loadMemoreSyncTabLockMap();
  if (map[remoteServerKey]) {
    return false;
  }

  map[remoteServerKey] = {
    ownerId: MEMORE_SYNC_TAB_ID,
    lockId,
    expiresAt: Date.now() + MEMORE_SYNC_TAB_LOCK_TTL_MS,
  };
  persistMemoreSyncTabLockMap(map);

  const verificationMap = loadMemoreSyncTabLockMap();
  return verificationMap[remoteServerKey]?.ownerId === MEMORE_SYNC_TAB_ID && verificationMap[remoteServerKey]?.lockId === lockId;
};

const renewMemoreSyncTabLock = (remoteServerKey: string, lockId: string): boolean => {
  if (!remoteServerKey) {
    return true;
  }

  const map = loadMemoreSyncTabLockMap();
  const lock = map[remoteServerKey];
  if (!lock || lock.ownerId !== MEMORE_SYNC_TAB_ID || lock.lockId !== lockId) {
    return false;
  }

  map[remoteServerKey] = {
    ...lock,
    expiresAt: Date.now() + MEMORE_SYNC_TAB_LOCK_TTL_MS,
  };
  persistMemoreSyncTabLockMap(map);

  const verificationMap = loadMemoreSyncTabLockMap();
  const verifiedLock = verificationMap[remoteServerKey];
  return !!verifiedLock && verifiedLock.ownerId === MEMORE_SYNC_TAB_ID && verifiedLock.lockId === lockId;
};

const releaseMemoreSyncTabLock = (remoteServerKey: string, lockId: string) => {
  if (!remoteServerKey) {
    return;
  }

  const map = loadMemoreSyncTabLockMap();
  const lock = map[remoteServerKey];
  if (!lock || lock.ownerId !== MEMORE_SYNC_TAB_ID || lock.lockId !== lockId) {
    return;
  }

  delete map[remoteServerKey];
  persistMemoreSyncTabLockMap(map);
};

const forceReleaseMemoreSyncTabLock = (remoteServerKey: string) => {
  if (!remoteServerKey) {
    return;
  }

  const map = loadMemoreSyncTabLockMap();
  if (map[remoteServerKey]) {
    delete map[remoteServerKey];
    persistMemoreSyncTabLockMap(map);
  }
};

const releaseAllOwnedLocks = () => {
  const map = loadMemoreSyncTabLockMap();
  let changed = false;
  for (const [key, lock] of Object.entries(map)) {
    if (lock.ownerId === MEMORE_SYNC_TAB_ID) {
      delete map[key];
      changed = true;
    }
  }
  if (changed) {
    persistMemoreSyncTabLockMap(map);
  }
};

if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", releaseAllOwnedLocks);
}

// 模块级同步任务进行中追踪：用于区分"当前标签页正在同步"与"其他标签页正在同步"
const inProgressSyncServerKeys = new Set<string>();

export const runMemoreSyncTaskWithLock = async <T>(
  remoteServerUrl: string,
  task: () => Promise<T>,
): Promise<MemoreSyncTaskLockResult<T>> => {
  const remoteServerKey = normalizeMemoreRemoteServerUrl(remoteServerUrl);
  if (!remoteServerKey) {
    const value = await task();
    return { ok: true, value };
  }

  if (inProgressSyncServerKeys.has(remoteServerKey)) {
    return { ok: false, reason: "IN_PROGRESS" };
  }

  const lockId = createMemoreSyncTaskLockId();
  const acquired = tryAcquireMemoreSyncTabLock(remoteServerKey, lockId);
  if (!acquired) {
    return {
      ok: false,
      reason: "LOCKED",
    };
  }

  inProgressSyncServerKeys.add(remoteServerKey);

  let lockRenewTimer: number | undefined;
  const startLockRenewal = () => {
    if (typeof window === "undefined") {
      return;
    }

    lockRenewTimer = window.setInterval(() => {
      renewMemoreSyncTabLock(remoteServerKey, lockId);
    }, MEMORE_SYNC_TAB_LOCK_RENEW_INTERVAL_MS);
  };

  const stopLockRenewal = () => {
    if (lockRenewTimer === undefined || typeof window === "undefined") {
      return;
    }

    window.clearInterval(lockRenewTimer);
    lockRenewTimer = undefined;
  };

  startLockRenewal();

  try {
    const value = await task();
    return {
      ok: true,
      value,
    };
  } finally {
    stopLockRenewal();
    inProgressSyncServerKeys.delete(remoteServerKey);
    releaseMemoreSyncTabLock(remoteServerKey, lockId);
  }
};

const parseRemoteDate = (value: unknown): Date | undefined => {
  if (typeof value !== "string") {
    return undefined;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
};

const toMemoStateString = (state: State): "NORMAL" | "ARCHIVED" => {
  return state === State.ARCHIVED ? "ARCHIVED" : "NORMAL";
};

const toVisibilityString = (visibility: Visibility): "PRIVATE" | "PROTECTED" | "PUBLIC" => {
  switch (visibility) {
    case Visibility.PUBLIC:
      return "PUBLIC";
    case Visibility.PROTECTED:
      return "PROTECTED";
    case Visibility.PRIVATE:
    default:
      return "PRIVATE";
  }
};

const extractMemoIdFromName = (memoName: string): string => {
  if (memoName.startsWith("memos/")) {
    return memoName.slice("memos/".length);
  }
  return memoName;
};

const timestampToDate = (timestamp: Memo["updateTime"] | Memo["createTime"] | Memo["displayTime"]): Date | undefined => {
  if (!timestamp) {
    return undefined;
  }

  try {
    return timestampDate(timestamp);
  } catch {
    return undefined;
  }
};

const toIsoString = (date?: Date): string | undefined => {
  return date ? date.toISOString() : undefined;
};

const getMemoUpdateTimeRaw = (memo: Memo): string | undefined => {
  return toIsoString(timestampToDate(memo.updateTime)) ?? toIsoString(timestampToDate(memo.createTime));
};

const parseIsoTimestampToMs = (rawTime?: string): number | undefined => {
  if (!rawTime) {
    return undefined;
  }

  const parsed = new Date(rawTime);
  const ms = parsed.getTime();
  return Number.isNaN(ms) ? undefined : ms;
};

const isLaterTimestamp = (leftRawTime?: string, rightRawTime?: string): boolean => {
  const leftMs = parseIsoTimestampToMs(leftRawTime);
  const rightMs = parseIsoTimestampToMs(rightRawTime);

  if (leftMs === undefined || rightMs === undefined) {
    return false;
  }

  return leftMs > rightMs;
};

const isConnectNotFoundError = (error: unknown): boolean => {
  return error instanceof ConnectError && error.code === Code.NotFound;
};

const toVisibility = (rawVisibility: unknown): Visibility => {
  switch (rawVisibility) {
    case "PUBLIC":
      return Visibility.PUBLIC;
    case "PROTECTED":
      return Visibility.PROTECTED;
    case "PRIVATE":
    default:
      return Visibility.PRIVATE;
  }
};

const parseAttachment = (value: unknown): Attachment | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }

  const name = readString(value, "name");
  const filename = readString(value, "filename");
  if (!name || !filename) {
    return undefined;
  }

  return create(AttachmentSchema, {
    name,
    filename,
    type: readString(value, "type") ?? "application/octet-stream",
    externalLink: readString(value, "externalLink") ?? "",
    size: readBigInt(value, "size") ?? BigInt(0),
  });
};

const parseAttachments = (value: unknown): Attachment[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map((item) => parseAttachment(item)).filter((item): item is Attachment => !!item);
};

const toAttachmentReference = (attachment: Attachment): Attachment => {
  return create(AttachmentSchema, {
    name: attachment.name,
  });
};

const extractAttachmentIdFromName = (attachmentName: string): string => {
  if (attachmentName.startsWith("attachments/")) {
    return attachmentName.slice("attachments/".length);
  }
  return attachmentName;
};

const createRemoteAttachmentClient = (normalizedServerUrl: string, accessToken: string) => {
  const transport = createConnectTransport({
    baseUrl: normalizedServerUrl,
    useBinaryFormat: true,
    fetch: (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set("Authorization", `Bearer ${accessToken}`);
      return globalThis.fetch(input, {
        ...init,
        headers,
      });
    },
    interceptors: [],
  });

  return createClient(AttachmentService, transport);
};

type RemoteAttachmentClient = ReturnType<typeof createRemoteAttachmentClient>;

const ensureRemoteAttachmentForLocalMemo = async (
  remoteAttachmentClient: RemoteAttachmentClient,
  localAttachment: Attachment,
): Promise<Attachment | undefined> => {
  if (!localAttachment.name || !localAttachment.filename) {
    return undefined;
  }

  const attachmentId = extractAttachmentIdFromName(localAttachment.name);
  if (!attachmentId) {
    return undefined;
  }

  try {
    const localAuthToken = getLocalAuthHeader();
    const localFileResponse = await fetch(
      buildMemosApiUrl(`/file/attachments/${encodeURIComponent(attachmentId)}/${encodeURIComponent(localAttachment.filename)}`),
      {
        credentials: "include",
        headers: localAuthToken ? { Authorization: localAuthToken } : {},
      },
    );
    if (!localFileResponse.ok) {
      console.warn(`[memore-sync] 本地附件读取失败: ${localAttachment.filename} (uid=${attachmentId}), status=${localFileResponse.status}`);
      return undefined;
    }
    const content = new Uint8Array(await localFileResponse.arrayBuffer());

    const remoteAttachment = await remoteAttachmentClient.createAttachment({
      attachmentId,
      attachment: create(AttachmentSchema, {
        filename: localAttachment.filename,
        type: localAttachment.type,
        size: localAttachment.size,
        externalLink: localAttachment.externalLink,
        content,
      }),
    });

    return toAttachmentReference(remoteAttachment);
  } catch (error) {
    if (error instanceof ConnectError && (error.code === Code.AlreadyExists || error.code === Code.Internal)) {
      // AlreadyExists: attachment UID already on remote (Memore backend).
      // Internal: may also indicate a UID unique-constraint violation on
      // upstream Memos servers that don't map the error to AlreadyExists.
      // In both cases the attachment data is already present on the remote,
      // so we return a valid reference instead of treating it as a failure.
      try {
        const existing = await remoteAttachmentClient.getAttachment({ name: `attachments/${attachmentId}` });
        if (existing) {
          return toAttachmentReference(existing);
        }
      } catch {
        // GET failed — for AlreadyExists we can still build the reference
        // from the known UID; for Internal the attachment might genuinely
        // not exist, so we fall through to the warning below.
        if (error instanceof ConnectError && error.code === Code.AlreadyExists) {
          return create(AttachmentSchema, { name: `attachments/${attachmentId}` });
        }
      }
    }
    console.warn(`[memore-sync] 附件推送到远端失败: ${localAttachment.filename} (uid=${attachmentId})`, error);
    return undefined;
  }
};

// 通过本地后端代理下载远端附件文件内容。
// 远端 Memos 的 /file/attachments/* 路由没有 CORS 头，浏览器会拦截跨域请求，
// 因此必须通过本地 Go 后端中转（POST /api/v1/memore/proxy-attachment）。
const fetchRemoteAttachmentContent = async (
  normalizedServerUrl: string,
  accessToken: string,
  remoteAttachment: Attachment,
): Promise<Uint8Array | undefined> => {
  const attachmentUid = extractAttachmentIdFromName(remoteAttachment.name);
  if (!attachmentUid || !remoteAttachment.filename) {
    return undefined;
  }

  try {
    const proxyUrl = `${getLocalApiBaseUrl()}/api/v1/memore/proxy-attachment`;
    const response = await fetch(proxyUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: getLocalAuthHeader(),
      },
      body: JSON.stringify({
        serverUrl: normalizedServerUrl,
        attachmentUid,
        filename: remoteAttachment.filename,
        accessToken,
        externalLink: remoteAttachment.externalLink || "",
      }),
    });

    if (response.ok) {
      return new Uint8Array(await response.arrayBuffer());
    }

    console.warn(`[memore-sync] 代理下载附件失败: ${remoteAttachment.filename} (uid=${attachmentUid}), status=${response.status}`);
  } catch (error) {
    console.warn(`[memore-sync] 代理下载附件网络错误: ${remoteAttachment.filename}`, error);
  }

  return undefined;
};

// 带重试的远端附件下载，指数退避
const fetchRemoteAttachmentWithRetry = async (
  normalizedServerUrl: string,
  accessToken: string,
  remoteAttachment: Attachment,
  maxRetries = 2,
): Promise<Uint8Array | undefined> => {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const content = await fetchRemoteAttachmentContent(normalizedServerUrl, accessToken, remoteAttachment);
    if (content) return content;

    if (attempt < maxRetries) {
      await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
    }
  }
  return undefined;
};

const ensureLocalAttachmentForRemoteMemo = async (
  normalizedServerUrl: string,
  accessToken: string,
  remoteAttachment: Attachment,
): Promise<Attachment | undefined> => {
  if (!remoteAttachment.name || !remoteAttachment.filename) {
    return undefined;
  }

  const attachmentId = extractAttachmentIdFromName(remoteAttachment.name);
  if (!attachmentId) {
    return undefined;
  }

  // Fast path: check if this attachment already exists locally before downloading.
  try {
    const existing = await attachmentServiceClient.getAttachment({ name: `attachments/${attachmentId}` });
    if (existing) {
      return toAttachmentReference(existing);
    }
  } catch {
    // Not found locally — proceed with download & create.
  }

  try {
    const content = await fetchRemoteAttachmentWithRetry(normalizedServerUrl, accessToken, remoteAttachment);
    if (!content) {
      console.warn(`[memore-sync] 附件下载失败: ${remoteAttachment.filename} (id=${attachmentId}, size=${remoteAttachment.size})`);
      return undefined;
    }

    const localAttachment = await attachmentServiceClient.createAttachment({
      attachmentId,
      attachment: create(AttachmentSchema, {
        filename: remoteAttachment.filename,
        type: remoteAttachment.type,
        size: remoteAttachment.size,
        externalLink: remoteAttachment.externalLink,
        content,
      }),
    });

    return toAttachmentReference(localAttachment);
  } catch (error) {
    if (error instanceof ConnectError && (error.code === Code.AlreadyExists || error.code === Code.Internal)) {
      // The attachment UID already exists locally — return a valid reference.
      return create(AttachmentSchema, {
        name: `attachments/${attachmentId}`,
      });
    }
    console.warn(`[memore-sync] 附件创建失败: ${remoteAttachment.filename} (id=${attachmentId})`, error);
    return undefined;
  }
};

const ATTACHMENT_SYNC_CONCURRENCY = 3;

const runWithConcurrency = async <T>(tasks: (() => Promise<T>)[], concurrency: number): Promise<T[]> => {
  const results: T[] = [];
  let idx = 0;
  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
    while (idx < tasks.length) {
      const currentIdx = idx++;
      results[currentIdx] = await tasks[currentIdx]();
    }
  });
  await Promise.all(workers);
  return results;
};

const syncLocalMemoAttachmentsToRemote = async (
  localMemo: Memo,
  getRemoteAttachmentClient: () => RemoteAttachmentClient,
): Promise<{ attachmentReferences: Attachment[]; failedCount: number }> => {
  if (localMemo.attachments.length === 0) return { attachmentReferences: [], failedCount: 0 };

  const tasks = localMemo.attachments.map(
    (localAttachment) => () => ensureRemoteAttachmentForLocalMemo(getRemoteAttachmentClient(), localAttachment),
  );
  const results = await runWithConcurrency(tasks, ATTACHMENT_SYNC_CONCURRENCY);

  const attachmentReferences: Attachment[] = [];
  let failedCount = 0;
  for (const result of results) {
    if (!result) {
      failedCount += 1;
    } else {
      attachmentReferences.push(result);
    }
  }

  return { attachmentReferences, failedCount };
};

interface AttachmentSyncFailure {
  filename: string;
  attachmentId: string | undefined;
  reason: string;
}

const syncRemoteMemoAttachmentsToLocal = async (
  normalizedServerUrl: string,
  accessToken: string,
  remoteAttachments: Attachment[],
): Promise<{ attachmentReferences: Attachment[]; failedCount: number; failures: AttachmentSyncFailure[] }> => {
  if (remoteAttachments.length === 0) return { attachmentReferences: [], failedCount: 0, failures: [] };

  const tasks = remoteAttachments.map(
    (remoteAttachment) => async () => ({
      result: await ensureLocalAttachmentForRemoteMemo(normalizedServerUrl, accessToken, remoteAttachment),
      remoteAttachment,
    }),
  );
  const results = await runWithConcurrency(tasks, ATTACHMENT_SYNC_CONCURRENCY);

  const attachmentReferences: Attachment[] = [];
  let failedCount = 0;
  const failures: AttachmentSyncFailure[] = [];
  for (const { result, remoteAttachment } of results) {
    if (!result) {
      failedCount += 1;
      const aid = remoteAttachment.name ? extractAttachmentIdFromName(remoteAttachment.name) : undefined;
      failures.push({
        filename: remoteAttachment.filename || "unknown",
        attachmentId: aid ?? undefined,
        reason: remoteAttachment.externalLink ? "下载失败(含externalLink回退)" : "下载失败",
      });
    } else {
      attachmentReferences.push(result);
    }
  }

  return { attachmentReferences, failedCount, failures };
};

const loadImportedRemoteMemoMap = (): ImportedRemoteMemoMap => {
  try {
    const rawValue = localStorage.getItem(MEMORE_IMPORTED_REMOTE_MEMO_STORAGE_KEY);
    if (!rawValue) {
      return {};
    }

    const parsed = JSON.parse(rawValue) as unknown;
    if (!isRecord(parsed)) {
      return {};
    }

    const map: ImportedRemoteMemoMap = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (!Array.isArray(value)) {
        continue;
      }

      const names = value.filter((item): item is string => typeof item === "string");
      map[key] = names;
    }

    return map;
  } catch {
    return {};
  }
};

const persistImportedRemoteMemoMap = (map: ImportedRemoteMemoMap) => {
  try {
    localStorage.setItem(MEMORE_IMPORTED_REMOTE_MEMO_STORAGE_KEY, JSON.stringify(map));
  } catch {
    // 忽略 localStorage 异常（隐私模式、配额超限等）
  }
};

const getImportedRemoteMemoNameSet = (remoteServerKey: string): Set<string> => {
  const map = loadImportedRemoteMemoMap();
  return new Set(map[remoteServerKey] ?? []);
};

const setImportedRemoteMemoNameSet = (remoteServerKey: string, names: Set<string>) => {
  const map = loadImportedRemoteMemoMap();
  map[remoteServerKey] = Array.from(names);
  persistImportedRemoteMemoMap(map);
};

const loadRemoteMemoBindingMap = (): RemoteMemoBindingMap => {
  try {
    const rawValue = localStorage.getItem(MEMORE_REMOTE_MEMO_BINDING_STORAGE_KEY);
    if (!rawValue) {
      return {};
    }

    const parsed = JSON.parse(rawValue) as unknown;
    if (!isRecord(parsed)) {
      return {};
    }

    const map: RemoteMemoBindingMap = {};
    for (const [serverKey, candidateBindings] of Object.entries(parsed)) {
      if (!isRecord(candidateBindings)) {
        continue;
      }

      const bindings: Record<string, RemoteMemoBinding> = {};
      for (const [remoteMemoName, candidateBinding] of Object.entries(candidateBindings)) {
        if (!isRecord(candidateBinding)) {
          continue;
        }

        const localMemoName = readString(candidateBinding, "localMemoName");
        if (!localMemoName) {
          continue;
        }

        bindings[remoteMemoName] = {
          localMemoName,
          remoteUpdateTime: readString(candidateBinding, "remoteUpdateTime"),
          localUpdateTime: readString(candidateBinding, "localUpdateTime"),
        };
      }

      map[serverKey] = bindings;
    }

    return map;
  } catch {
    return {};
  }
};

const persistRemoteMemoBindingMap = (map: RemoteMemoBindingMap) => {
  try {
    localStorage.setItem(MEMORE_REMOTE_MEMO_BINDING_STORAGE_KEY, JSON.stringify(map));
  } catch {
    // 忽略 localStorage 异常（隐私模式、配额超限等）
  }
};

const getRemoteMemoBindings = (remoteServerKey: string): Record<string, RemoteMemoBinding> => {
  const map = loadRemoteMemoBindingMap();
  return map[remoteServerKey] ?? {};
};

const setRemoteMemoBindings = (remoteServerKey: string, bindings: Record<string, RemoteMemoBinding>) => {
  const map = loadRemoteMemoBindingMap();
  map[remoteServerKey] = bindings;
  persistRemoteMemoBindingMap(map);
};

/**
 * 根据本地 memo name 反查对应的远端 memo name。
 * 返回 remoteMemoName（如 "memos/42"），未找到时返回 undefined。
 */
export const findRemoteMemoNameByLocal = (remoteServerUrl: string, localMemoName: string): string | undefined => {
  const normalizedUrl = normalizeMemoreRemoteServerUrl(remoteServerUrl);
  if (!normalizedUrl) return undefined;

  const bindings = getRemoteMemoBindings(normalizedUrl);
  for (const [remoteMemoName, binding] of Object.entries(bindings)) {
    if (binding.localMemoName === localMemoName) {
      return remoteMemoName;
    }
  }

  return undefined;
};

const loadMemoreRemotePullCursorMap = (): MemoreRemotePullCursorMap => {
  try {
    const rawValue = localStorage.getItem(MEMORE_REMOTE_PULL_CURSOR_STORAGE_KEY);
    if (!rawValue) {
      return {};
    }

    const parsed = JSON.parse(rawValue) as unknown;
    if (!isRecord(parsed)) {
      return {};
    }

    const map: MemoreRemotePullCursorMap = {};
    for (const [serverKey, rawCursor] of Object.entries(parsed)) {
      if (typeof rawCursor !== "string") {
        continue;
      }

      map[serverKey] = rawCursor;
    }

    return map;
  } catch {
    return {};
  }
};

const persistMemoreRemotePullCursorMap = (map: MemoreRemotePullCursorMap) => {
  try {
    localStorage.setItem(MEMORE_REMOTE_PULL_CURSOR_STORAGE_KEY, JSON.stringify(map));
  } catch {
    // 忽略 localStorage 异常（隐私模式、配额超限等）
  }
};

const getMemoreRemotePullCursor = (remoteServerKey: string): string | undefined => {
  if (!remoteServerKey) {
    return undefined;
  }

  const map = loadMemoreRemotePullCursorMap();
  return map[remoteServerKey];
};

const setMemoreRemotePullCursor = (remoteServerKey: string, cursorRawTime?: string) => {
  if (!remoteServerKey) {
    return;
  }

  const map = loadMemoreRemotePullCursorMap();
  if (!cursorRawTime) {
    delete map[remoteServerKey];
  } else {
    map[remoteServerKey] = cursorRawTime;
  }
  persistMemoreRemotePullCursorMap(map);
};

const loadMemoreSyncRuntimeStatusMap = (): MemoreSyncRuntimeStatusMap => {
  try {
    const rawValue = localStorage.getItem(MEMORE_SYNC_RUNTIME_STATUS_STORAGE_KEY);
    if (!rawValue) {
      return {};
    }

    const parsed = JSON.parse(rawValue) as unknown;
    if (!isRecord(parsed)) {
      return {};
    }

    const map: MemoreSyncRuntimeStatusMap = {};
    for (const [serverKey, candidateStatus] of Object.entries(parsed)) {
      if (!isRecord(candidateStatus)) {
        continue;
      }

      map[serverKey] = {
        lastPushAt: readString(candidateStatus, "lastPushAt"),
        lastPullAt: readString(candidateStatus, "lastPullAt"),
        lastPushSummary: isRecord(candidateStatus.lastPushSummary)
          ? {
              totalLocalMemoCount: readNumber(candidateStatus.lastPushSummary, "totalLocalMemoCount"),
              pushedPages: readNumber(candidateStatus.lastPushSummary, "pushedPages"),
              createdCount: readNumber(candidateStatus.lastPushSummary, "createdCount"),
              updatedCount: readNumber(candidateStatus.lastPushSummary, "updatedCount"),
              deletedCount: readNumber(candidateStatus.lastPushSummary, "deletedCount"),
              skippedCount: readNumber(candidateStatus.lastPushSummary, "skippedCount"),
              failedCount: readNumber(candidateStatus.lastPushSummary, "failedCount"),
            }
          : undefined,
        lastPullSummary: isRecord(candidateStatus.lastPullSummary)
          ? {
              totalMemoCount: readNumber(candidateStatus.lastPullSummary, "totalMemoCount"),
              pulledPages: readNumber(candidateStatus.lastPullSummary, "pulledPages"),
              importedCount: readNumber(candidateStatus.lastPullSummary, "importedCount"),
              updatedCount: readNumber(candidateStatus.lastPullSummary, "updatedCount"),
              deletedCount: readNumber(candidateStatus.lastPullSummary, "deletedCount"),
              conflictCount: readNumber(candidateStatus.lastPullSummary, "conflictCount"),
              skippedCount: readNumber(candidateStatus.lastPullSummary, "skippedCount"),
              failedCount: readNumber(candidateStatus.lastPullSummary, "failedCount"),
            }
          : undefined,
        lastPullConflictLogs: Array.isArray(candidateStatus.lastPullConflictLogs)
          ? candidateStatus.lastPullConflictLogs
              .map((item) => parseMemoreSyncConflictLog(item))
              .filter((item): item is MemoreSyncConflictLog => !!item)
          : undefined,
        backgroundSyncState: parseMemoreSyncBackgroundState(readString(candidateStatus, "backgroundSyncState")),
        backgroundLastAttemptAt: readString(candidateStatus, "backgroundLastAttemptAt"),
        backgroundLastSuccessAt: readString(candidateStatus, "backgroundLastSuccessAt"),
        backgroundNextRunAt: readString(candidateStatus, "backgroundNextRunAt"),
        backgroundRetryCount: readNumber(candidateStatus, "backgroundRetryCount"),
        lastErrorAt: readString(candidateStatus, "lastErrorAt"),
        lastErrorPhase:
          readString(candidateStatus, "lastErrorPhase") === "push" ||
          readString(candidateStatus, "lastErrorPhase") === "pull" ||
          readString(candidateStatus, "lastErrorPhase") === "connection"
            ? (readString(candidateStatus, "lastErrorPhase") as MemoreSyncRuntimeStatus["lastErrorPhase"])
            : undefined,
        lastErrorMessage: readString(candidateStatus, "lastErrorMessage"),
      };
    }

    return map;
  } catch {
    return {};
  }
};

const persistMemoreSyncRuntimeStatusMap = (map: MemoreSyncRuntimeStatusMap) => {
  try {
    localStorage.setItem(MEMORE_SYNC_RUNTIME_STATUS_STORAGE_KEY, JSON.stringify(map));
  } catch {
    // 忽略 localStorage 异常（隐私模式、配额超限等）
  }
};

export const getMemoreSyncRuntimeStatus = (remoteServerKey: string): MemoreSyncRuntimeStatus => {
  if (!remoteServerKey) {
    return {};
  }

  const map = loadMemoreSyncRuntimeStatusMap();
  return map[remoteServerKey] ?? {};
};

export const clearMemoreSyncRuntimeStatus = (remoteServerUrl: string) => {
  const remoteServerKey = normalizeMemoreRemoteServerUrl(remoteServerUrl);
  if (!remoteServerKey) {
    return;
  }

  forceReleaseMemoreSyncTabLock(remoteServerKey);

  const map = loadMemoreSyncRuntimeStatusMap();
  map[remoteServerKey] = {};
  persistMemoreSyncRuntimeStatusMap(map);

  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent<MemoreSyncRuntimeStatusEventDetail>(MEMORE_SYNC_RUNTIME_STATUS_EVENT, {
        detail: {
          serverUrl: remoteServerKey,
          status: {},
        },
      }),
    );
  }
};

export const resetMemoreSyncMetadata = (remoteServerUrl: string) => {
  const remoteServerKey = normalizeMemoreRemoteServerUrl(remoteServerUrl);
  if (!remoteServerKey) {
    return;
  }

  forceReleaseMemoreSyncTabLock(remoteServerKey);

  const importedMap = loadImportedRemoteMemoMap();
  delete importedMap[remoteServerKey];
  persistImportedRemoteMemoMap(importedMap);

  const bindingMap = loadRemoteMemoBindingMap();
  delete bindingMap[remoteServerKey];
  persistRemoteMemoBindingMap(bindingMap);

  const pullCursorMap = loadMemoreRemotePullCursorMap();
  delete pullCursorMap[remoteServerKey];
  persistMemoreRemotePullCursorMap(pullCursorMap);

  clearMemoreSyncRuntimeStatus(remoteServerKey);
};

// 同步元数据导出：将所有元数据打包为 JSON 字符串，供用户下载备份
export const exportMemoreSyncMetadata = (remoteServerUrl: string): string | null => {
  const remoteServerKey = normalizeMemoreRemoteServerUrl(remoteServerUrl);
  if (!remoteServerKey) return null;

  const importedMap = loadImportedRemoteMemoMap();
  const bindingMap = loadRemoteMemoBindingMap();
  const pullCursorMap = loadMemoreRemotePullCursorMap();

  const exportData = {
    version: 1,
    exportedAt: new Date().toISOString(),
    serverUrl: remoteServerKey,
    importedNames: importedMap[remoteServerKey] ?? [],
    bindings: bindingMap[remoteServerKey] ?? {},
    pullCursor: pullCursorMap[remoteServerKey] ?? null,
  };

  return JSON.stringify(exportData, null, 2);
};

// 同步元数据导入：从导出的 JSON 恢复元数据
export const importMemoreSyncMetadata = (remoteServerUrl: string, jsonData: string): boolean => {
  const remoteServerKey = normalizeMemoreRemoteServerUrl(remoteServerUrl);
  if (!remoteServerKey) return false;

  try {
    const data = JSON.parse(jsonData) as Record<string, unknown>;
    if (!data || data.version !== 1) return false;

    if (Array.isArray(data.importedNames)) {
      const importedMap = loadImportedRemoteMemoMap();
      importedMap[remoteServerKey] = data.importedNames as string[];
      persistImportedRemoteMemoMap(importedMap);
    }

    if (isRecord(data.bindings)) {
      const bindingMap = loadRemoteMemoBindingMap();
      bindingMap[remoteServerKey] = data.bindings as Record<string, RemoteMemoBinding>;
      persistRemoteMemoBindingMap(bindingMap);
    }

    if (typeof data.pullCursor === "string") {
      const pullCursorMap = loadMemoreRemotePullCursorMap();
      pullCursorMap[remoteServerKey] = data.pullCursor;
      persistMemoreRemotePullCursorMap(pullCursorMap);
    }

    return true;
  } catch {
    return false;
  }
};

const updateMemoreSyncRuntimeStatus = (
  remoteServerKey: string,
  updater: (previous: MemoreSyncRuntimeStatus) => MemoreSyncRuntimeStatus,
) => {
  if (!remoteServerKey) {
    return;
  }

  const map = loadMemoreSyncRuntimeStatusMap();
  const previous = map[remoteServerKey] ?? {};
  const next = updater(previous);
  map[remoteServerKey] = next;
  persistMemoreSyncRuntimeStatusMap(map);

  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent<MemoreSyncRuntimeStatusEventDetail>(MEMORE_SYNC_RUNTIME_STATUS_EVENT, {
        detail: {
          serverUrl: remoteServerKey,
          status: next,
        },
      }),
    );
  }
};

export const updateMemoreSyncBackgroundRuntimeStatus = (remoteServerUrl: string, patch: MemoreSyncBackgroundRuntimeStatusPatch) => {
  const remoteServerKey = normalizeMemoreRemoteServerUrl(remoteServerUrl);
  if (!remoteServerKey) {
    return;
  }

  const hasOwn = Object.prototype.hasOwnProperty;
  updateMemoreSyncRuntimeStatus(remoteServerKey, (previous) => {
    const next: MemoreSyncRuntimeStatus = {
      ...previous,
    };

    if (hasOwn.call(patch, "backgroundSyncState")) {
      next.backgroundSyncState = patch.backgroundSyncState;
    }
    if (hasOwn.call(patch, "backgroundLastAttemptAt")) {
      next.backgroundLastAttemptAt = patch.backgroundLastAttemptAt;
    }
    if (hasOwn.call(patch, "backgroundLastSuccessAt")) {
      next.backgroundLastSuccessAt = patch.backgroundLastSuccessAt;
    }
    if (hasOwn.call(patch, "backgroundNextRunAt")) {
      next.backgroundNextRunAt = patch.backgroundNextRunAt;
    }
    if (hasOwn.call(patch, "backgroundRetryCount")) {
      next.backgroundRetryCount = patch.backgroundRetryCount;
    }

    return next;
  });
};

const resolveSyncErrorMessage = (errorCode?: MemoreRemoteConnectionTestErrorCode, serverMessage?: string): string => {
  return serverMessage ?? errorCode ?? "UNKNOWN_ERROR";
};

const markSyncErrorStatus = (
  remoteServerKey: string,
  phase: "push" | "pull" | "connection",
  errorCode?: MemoreRemoteConnectionTestErrorCode,
  serverMessage?: string,
) => {
  const now = new Date().toISOString();
  updateMemoreSyncRuntimeStatus(remoteServerKey, (previous) => ({
    ...previous,
    lastErrorAt: now,
    lastErrorPhase: phase,
    lastErrorMessage: resolveSyncErrorMessage(errorCode, serverMessage),
  }));
};

const markPushSuccessStatus = (remoteServerKey: string, summary: NonNullable<MemoreSyncRuntimeStatus["lastPushSummary"]>) => {
  const now = new Date().toISOString();
  updateMemoreSyncRuntimeStatus(remoteServerKey, (previous) => ({
    ...previous,
    lastPushAt: now,
    lastPushSummary: summary,
    ...(previous.lastErrorPhase === "push"
      ? {
          lastErrorAt: undefined,
          lastErrorPhase: undefined,
          lastErrorMessage: undefined,
        }
      : {}),
  }));
};

const markPullSuccessStatus = (
  remoteServerKey: string,
  summary: NonNullable<MemoreSyncRuntimeStatus["lastPullSummary"]>,
  conflictLogs: MemoreSyncConflictLog[],
) => {
  const now = new Date().toISOString();
  updateMemoreSyncRuntimeStatus(remoteServerKey, (previous) => ({
    ...previous,
    lastPullAt: now,
    lastPullSummary: summary,
    lastPullConflictLogs: conflictLogs.slice(0, MAX_MEMORE_SYNC_CONFLICT_LOGS),
    ...(previous.lastErrorPhase === "pull"
      ? {
          lastErrorAt: undefined,
          lastErrorPhase: undefined,
          lastErrorMessage: undefined,
        }
      : {}),
  }));
};

const clearConnectionErrorStatus = (remoteServerKey: string) => {
  updateMemoreSyncRuntimeStatus(remoteServerKey, (previous) => ({
    ...previous,
    ...(previous.lastErrorPhase === "connection"
      ? {
          lastErrorAt: undefined,
          lastErrorPhase: undefined,
          lastErrorMessage: undefined,
        }
      : {}),
  }));
};

interface RemoteMemoForImport {
  name: string;
  content: string;
  visibility: Visibility;
  pinned: boolean;
  state: "NORMAL" | "ARCHIVED";
  attachments: Attachment[];
  updateTimeRaw?: string;
  createTime?: Date;
  updateTime?: Date;
  displayTime?: Date;
}

const parseRemoteMemoForImport = (value: unknown): RemoteMemoForImport | null => {
  if (!isRecord(value)) {
    return null;
  }

  const name = readString(value, "name");
  const content = readString(value, "content") ?? "";
  const attachments = parseAttachments(value.attachments);
  const updateTimeRaw = readString(value, "updateTime");
  if (!name || (!content.trim() && attachments.length === 0)) {
    return null;
  }

  const rawState = readString(value, "state");
  const state: "NORMAL" | "ARCHIVED" = rawState === "ARCHIVED" ? "ARCHIVED" : "NORMAL";

  return {
    name,
    content,
    visibility: toVisibility(readString(value, "visibility")),
    pinned: readBoolean(value, "pinned") ?? false,
    state,
    attachments,
    updateTimeRaw,
    createTime: parseRemoteDate(value.createTime),
    updateTime: parseRemoteDate(updateTimeRaw),
    displayTime: parseRemoteDate(value.displayTime),
  };
};

interface LocalMemoPushBinding {
  remoteMemoName: string;
  remoteUpdateTime?: string;
  localUpdateTime?: string;
}

const buildLocalMemoPushBindingLookup = (remoteMemoBindings: Record<string, RemoteMemoBinding>): Record<string, LocalMemoPushBinding> => {
  const lookup: Record<string, LocalMemoPushBinding> = {};

  for (const [remoteMemoName, binding] of Object.entries(remoteMemoBindings)) {
    lookup[binding.localMemoName] = {
      remoteMemoName,
      remoteUpdateTime: binding.remoteUpdateTime,
      localUpdateTime: binding.localUpdateTime,
    };
  }

  return lookup;
};

interface RemoteMemoPayloadConfig {
  includePinned?: boolean;
  includeState?: boolean;
}

const buildRemoteMemoPayloadFromLocal = (
  localMemo: Memo,
  attachmentReferences?: Attachment[],
  config?: RemoteMemoPayloadConfig,
): Record<string, unknown> => {
  const payload: Record<string, unknown> = {
    content: localMemo.content,
    visibility: toVisibilityString(localMemo.visibility),
    attachments: (attachmentReferences ?? localMemo.attachments).map((attachment) => ({ name: attachment.name })),
  };
  if (config?.includePinned !== false) {
    payload.pinned = localMemo.pinned;
  }
  if (config?.includeState !== false) {
    payload.state = toMemoStateString(localMemo.state);
  }

  const displayTime = toIsoString(timestampToDate(localMemo.displayTime));
  if (displayTime) {
    payload.displayTime = displayTime;
  }

  const createTime = toIsoString(timestampToDate(localMemo.createTime));
  if (createTime) {
    payload.createTime = createTime;
  }

  const updateTime = getMemoUpdateTimeRaw(localMemo);
  if (updateTime) {
    payload.updateTime = updateTime;
  }

  return payload;
};

const createRemoteMemoFromLocal = async (
  normalizedServerUrl: string,
  accessToken: string,
  localMemo: Memo,
  attachmentReferences?: Attachment[],
  payloadConfig?: RemoteMemoPayloadConfig,
): Promise<
  { ok: true; remoteMemoName: string; remoteUpdateTime?: string; localUpdateTime?: string } | { ok: false; serverMessage?: string }
> => {
  const response = await fetch(`${normalizedServerUrl}/api/v1/memos`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(buildRemoteMemoPayloadFromLocal(localMemo, attachmentReferences, payloadConfig)),
  });
  const payload = await parseJsonIfPossible(response);

  if (!response.ok) {
    return {
      ok: false,
      serverMessage: extractStatusMessage(payload),
    };
  }

  const remoteMemoName = readString(payload, "name");
  if (!remoteMemoName) {
    return {
      ok: false,
      serverMessage: "Remote memo name missing in response.",
    };
  }

  if (payloadConfig?.includeState !== false && localMemo.state === State.ARCHIVED) {
    const remoteMemoId = extractMemoIdFromName(remoteMemoName);
    try {
      await fetch(
        `${normalizedServerUrl}/api/v1/memos/${encodeURIComponent(remoteMemoId)}?${new URLSearchParams({ updateMask: "state" }).toString()}`,
        {
          method: "PATCH",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify({ state: "ARCHIVED" }),
        },
      );
    } catch {
      console.warn(`[memore-sync] 远端 memo 归档状态设置失败: ${remoteMemoName}`);
    }
  }

  return {
    ok: true,
    remoteMemoName,
    remoteUpdateTime: readString(payload, "updateTime"),
    localUpdateTime: getMemoUpdateTimeRaw(localMemo),
  };
};

const deleteRemoteMemoByName = async (
  normalizedServerUrl: string,
  accessToken: string,
  remoteMemoName: string,
): Promise<{ ok: true } | { ok: false; authFailed?: boolean; serverMessage?: string }> => {
  const remoteMemoId = extractMemoIdFromName(remoteMemoName);
  const response = await fetch(
    `${normalizedServerUrl}/api/v1/memos/${encodeURIComponent(remoteMemoId)}?${new URLSearchParams({ force: "true" }).toString()}`,
    {
      method: "DELETE",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
    },
  );
  const payload = await parseJsonIfPossible(response);

  if (response.ok || response.status === 404) {
    return { ok: true };
  }

  if (response.status === 401 || response.status === 403) {
    return {
      ok: false,
      authFailed: true,
      serverMessage: extractStatusMessage(payload),
    };
  }

  return {
    ok: false,
    serverMessage: extractStatusMessage(payload),
  };
};

const checkRemoteMemoByName = async (
  normalizedServerUrl: string,
  accessToken: string,
  remoteMemoName: string,
): Promise<{ ok: true; exists: boolean; remoteUpdateTime?: string } | { ok: false; authFailed?: boolean; serverMessage?: string }> => {
  const remoteMemoId = extractMemoIdFromName(remoteMemoName);
  const response = await fetch(`${normalizedServerUrl}/api/v1/memos/${encodeURIComponent(remoteMemoId)}`, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
  });
  const payload = await parseJsonIfPossible(response);

  if (response.ok) {
    return {
      ok: true,
      exists: true,
      remoteUpdateTime: readString(payload, "updateTime"),
    };
  }

  if (response.status === 404) {
    return {
      ok: true,
      exists: false,
    };
  }

  if (response.status === 401 || response.status === 403) {
    return {
      ok: false,
      authFailed: true,
      serverMessage: extractStatusMessage(payload),
    };
  }

  return {
    ok: false,
    serverMessage: extractStatusMessage(payload),
  };
};

export const syncMemoreLocalMemosToRemote = async (input: MemoreRemotePullInput): Promise<MemoreLocalPushResult> => {
  const normalizedServerUrl = normalizeMemoreRemoteServerUrl(input.serverUrl);
  if (!normalizedServerUrl) {
    return {
      ok: false,
      errorCode: "INVALID_URL",
    };
  }

  const accessToken = input.accessToken.trim();
  if (!accessToken) {
    return {
      ok: false,
      errorCode: "MISSING_TOKEN",
    };
  }

  const dryRun = input.dryRun ?? false;
  const syncPinned = input.syncPinned ?? false;
  const syncArchived = input.syncArchived ?? false;
  const payloadConfig: RemoteMemoPayloadConfig = {
    includePinned: syncPinned,
    includeState: syncArchived,
  };

  const pageSize = Math.max(1, Math.min(500, input.pageSize ?? 200));
  const maxPages = Math.max(1, Math.min(50, input.maxPages ?? 20));
  let pageToken = "";
  let pushedPages = 0;
  let totalLocalMemoCount = 0;
  let createdCount = 0;
  let updatedCount = 0;
  let deletedCount = 0;
  let skippedCount = 0;
  let failedCount = 0;

  const importedRemoteMemoNames = getImportedRemoteMemoNameSet(normalizedServerUrl);
  const remoteMemoBindings = getRemoteMemoBindings(normalizedServerUrl);
  const localMemoBindingLookup = buildLocalMemoPushBindingLookup(remoteMemoBindings);
  const seenLocalMemoNames = new Set<string>();
  let remoteAttachmentClient: RemoteAttachmentClient | undefined;

  const getRemoteAttachmentClient = () => {
    if (!remoteAttachmentClient) {
      remoteAttachmentClient = createRemoteAttachmentClient(normalizedServerUrl, accessToken);
    }
    return remoteAttachmentClient;
  };

  try {
    while (pushedPages < maxPages) {
      const localList = await memoServiceClient.listMemos(
        create(ListMemosRequestSchema, {
          pageSize,
          pageToken,
          state: State.STATE_UNSPECIFIED,
          orderBy: "update_time desc",
        } as Record<string, unknown>),
      );

      const localMemos = localList.memos;
      totalLocalMemoCount += localMemos.length;
      pushedPages += 1;
      pageToken = localList.nextPageToken;

      for (const localMemo of localMemos) {
        seenLocalMemoNames.add(localMemo.name);

        if (!localMemo.content.trim() && localMemo.attachments.length === 0) {
          skippedCount += 1;
          continue;
        }

        const localUpdateTimeRaw = getMemoUpdateTimeRaw(localMemo);
        const existingBinding = localMemoBindingLookup[localMemo.name];

        if (existingBinding) {
          const shouldSkip =
            !!existingBinding.localUpdateTime && !!localUpdateTimeRaw && existingBinding.localUpdateTime === localUpdateTimeRaw;
          if (shouldSkip) {
            skippedCount += 1;
            continue;
          }

          if (dryRun) {
            updatedCount += 1;
            continue;
          }

          const attachmentSyncResult = await syncLocalMemoAttachmentsToRemote(localMemo, getRemoteAttachmentClient);
          failedCount += attachmentSyncResult.failedCount;

          const remoteMemoId = extractMemoIdFromName(existingBinding.remoteMemoName);
          const remotePayload = buildRemoteMemoPayloadFromLocal(localMemo, attachmentSyncResult.attachmentReferences, payloadConfig);
          const updateMask = ["content", "visibility", "attachments"];
          if (syncPinned) updateMask.push("pinned");
          if (syncArchived) updateMask.push("state");
          if ("displayTime" in remotePayload) {
            updateMask.push("display_time");
          }
          if ("createTime" in remotePayload) {
            updateMask.push("create_time");
          }
          if ("updateTime" in remotePayload) {
            updateMask.push("update_time");
          }
          const response = await fetch(
            `${normalizedServerUrl}/api/v1/memos/${encodeURIComponent(remoteMemoId)}?${new URLSearchParams({ updateMask: updateMask.join(",") }).toString()}`,
            {
              method: "PATCH",
              headers: {
                Accept: "application/json",
                "Content-Type": "application/json",
                Authorization: `Bearer ${accessToken}`,
              },
              body: JSON.stringify({
                ...remotePayload,
                name: existingBinding.remoteMemoName,
              }),
            },
          );
          const payload = await parseJsonIfPossible(response);

          if (!response.ok) {
            if (response.status === 404) {
              delete remoteMemoBindings[existingBinding.remoteMemoName];
              delete localMemoBindingLookup[localMemo.name];

              const createResult = await createRemoteMemoFromLocal(
                normalizedServerUrl,
                accessToken,
                localMemo,
                attachmentSyncResult.attachmentReferences,
                payloadConfig,
              );
              if (!createResult.ok) {
                failedCount += 1;
                continue;
              }

              remoteMemoBindings[createResult.remoteMemoName] = {
                localMemoName: localMemo.name,
                remoteUpdateTime: createResult.remoteUpdateTime,
                localUpdateTime: createResult.localUpdateTime,
              };
              localMemoBindingLookup[localMemo.name] = {
                remoteMemoName: createResult.remoteMemoName,
                remoteUpdateTime: createResult.remoteUpdateTime,
                localUpdateTime: createResult.localUpdateTime,
              };
              importedRemoteMemoNames.add(createResult.remoteMemoName);
              createdCount += 1;
              continue;
            }

            const isAuthFailed = response.status === 401 || response.status === 403;
            if (isAuthFailed) {
              const serverMessage = extractStatusMessage(payload);
              markSyncErrorStatus(normalizedServerUrl, "push", "AUTH_REQUEST_FAILED", serverMessage);
              return {
                ok: false,
                errorCode: "AUTH_REQUEST_FAILED",
                serverMessage,
              };
            }

            failedCount += 1;
            continue;
          }

          const remoteMemoName = readString(payload, "name") ?? existingBinding.remoteMemoName;
          const remoteUpdateTime = readString(payload, "updateTime");

          if (remoteMemoName !== existingBinding.remoteMemoName) {
            delete remoteMemoBindings[existingBinding.remoteMemoName];
          }

          remoteMemoBindings[remoteMemoName] = {
            localMemoName: localMemo.name,
            remoteUpdateTime,
            localUpdateTime: localUpdateTimeRaw,
          };
          localMemoBindingLookup[localMemo.name] = {
            remoteMemoName,
            remoteUpdateTime,
            localUpdateTime: localUpdateTimeRaw,
          };
          importedRemoteMemoNames.add(remoteMemoName);
          updatedCount += 1;
          continue;
        }

        if (dryRun) {
          createdCount += 1;
          continue;
        }

        const attachmentSyncResult = await syncLocalMemoAttachmentsToRemote(localMemo, getRemoteAttachmentClient);
        failedCount += attachmentSyncResult.failedCount;

        const createResult = await createRemoteMemoFromLocal(
          normalizedServerUrl,
          accessToken,
          localMemo,
          attachmentSyncResult.attachmentReferences,
          payloadConfig,
        );
        if (!createResult.ok) {
          failedCount += 1;
          continue;
        }

        remoteMemoBindings[createResult.remoteMemoName] = {
          localMemoName: localMemo.name,
          remoteUpdateTime: createResult.remoteUpdateTime,
          localUpdateTime: createResult.localUpdateTime,
        };
        localMemoBindingLookup[localMemo.name] = {
          remoteMemoName: createResult.remoteMemoName,
          remoteUpdateTime: createResult.remoteUpdateTime,
          localUpdateTime: createResult.localUpdateTime,
        };
        importedRemoteMemoNames.add(createResult.remoteMemoName);
        createdCount += 1;
      }

      // 断点续传：每页处理完毕后增量保存元数据，中断后下次可从此处继续
      if (!dryRun) {
        setImportedRemoteMemoNameSet(normalizedServerUrl, importedRemoteMemoNames);
        setRemoteMemoBindings(normalizedServerUrl, remoteMemoBindings);
      }

      if (!pageToken) {
        break;
      }
    }

    const scannedAllLocalPages = !pageToken;
    if (scannedAllLocalPages) {
      // 安全检查：先统计待删除数量，超过阈值时要求用户确认
      const orphanedLocalNames: string[] = [];
      for (const [localMemoName] of Object.entries(localMemoBindingLookup)) {
        if (seenLocalMemoNames.has(localMemoName)) continue;
        try {
          await memoServiceClient.getMemo({ name: localMemoName });
        } catch (error) {
          if (isConnectNotFoundError(error)) {
            orphanedLocalNames.push(localMemoName);
          }
        }
      }

      if (orphanedLocalNames.length > SYNC_DELETION_CONFIRM_THRESHOLD && !input.confirmDeletions && !dryRun) {
        console.warn(
          `[memore-sync] push: ${orphanedLocalNames.length} memos would be deleted from remote, ` +
            `exceeds threshold ${SYNC_DELETION_CONFIRM_THRESHOLD}. Aborting — user confirmation required.`,
        );
        return {
          ok: true,
          totalLocalMemoCount,
          pushedPages,
          createdCount,
          updatedCount,
          deletedCount: 0,
          skippedCount,
          failedCount,
          needsDeletionConfirmation: true,
          pendingDeletionCount: orphanedLocalNames.length,
        };
      }

      for (const localMemoName of orphanedLocalNames) {
        const binding = localMemoBindingLookup[localMemoName];
        if (!binding) continue;

        if (dryRun) {
          deletedCount += 1;
          continue;
        }

        const deleteResult = await deleteRemoteMemoByName(normalizedServerUrl, accessToken, binding.remoteMemoName);
        if (!deleteResult.ok) {
          if (deleteResult.authFailed) {
            markSyncErrorStatus(normalizedServerUrl, "push", "AUTH_REQUEST_FAILED", deleteResult.serverMessage);
            return {
              ok: false,
              errorCode: "AUTH_REQUEST_FAILED",
              serverMessage: deleteResult.serverMessage,
            };
          }

          failedCount += 1;
          continue;
        }

        delete remoteMemoBindings[binding.remoteMemoName];
        delete localMemoBindingLookup[localMemoName];
        importedRemoteMemoNames.delete(binding.remoteMemoName);
        deletedCount += 1;
      }
    }

    // Dry Run 模式下不持久化元数据
    if (!dryRun) {
      setImportedRemoteMemoNameSet(normalizedServerUrl, importedRemoteMemoNames);
      setRemoteMemoBindings(normalizedServerUrl, remoteMemoBindings);

      markPushSuccessStatus(normalizedServerUrl, {
        totalLocalMemoCount,
        pushedPages,
        createdCount,
        updatedCount,
        deletedCount,
        skippedCount,
        failedCount,
      });
    }

    return {
      ok: true,
      dryRun,
      totalLocalMemoCount,
      pushedPages,
      createdCount,
      updatedCount,
      deletedCount,
      skippedCount,
      failedCount,
    };
  } catch {
    markSyncErrorStatus(normalizedServerUrl, "push", "NETWORK");
    return {
      ok: false,
      errorCode: "NETWORK",
    };
  }
};

const parseJsonIfPossible = async (response: Response): Promise<Record<string, unknown> | null> => {
  const contentType = response.headers.get("content-type");
  if (!contentType?.includes("application/json")) {
    return null;
  }

  try {
    const payload = await response.json();
    return isRecord(payload) ? payload : null;
  } catch {
    return null;
  }
};

export const syncMemoreRemoteMemosToLocal = async (input: MemoreRemotePullInput): Promise<MemoreRemotePullResult> => {
  const normalizedServerUrl = normalizeMemoreRemoteServerUrl(input.serverUrl);
  if (!normalizedServerUrl) {
    return {
      ok: false,
      errorCode: "INVALID_URL",
    };
  }

  const accessToken = input.accessToken.trim();
  if (!accessToken) {
    return {
      ok: false,
      errorCode: "MISSING_TOKEN",
    };
  }

  const dryRun = input.dryRun ?? false;
  const syncPinned = input.syncPinned ?? false;
  const syncArchived = input.syncArchived ?? false;
  const metadataSyncEnabled = syncPinned || syncArchived;
  const pageSize = Math.max(1, Math.min(500, input.pageSize ?? 200));
  const maxPages = Math.max(1, Math.min(50, input.maxPages ?? (metadataSyncEnabled ? 30 : 20)));
  let pulledPages = 0;
  let totalMemoCount = 0;
  let importedCount = 0;
  let updatedCount = 0;
  let deletedCount = 0;
  let conflictCount = 0;
  let skippedCount = 0;
  let failedCount = 0;

  const importedRemoteMemoNames = getImportedRemoteMemoNameSet(normalizedServerUrl);
  const remoteMemoBindings = getRemoteMemoBindings(normalizedServerUrl);
  const seenRemoteMemoNames = new Set<string>();
  const pullConflictLogs: MemoreSyncConflictLog[] = [];

  // 内容指纹去重：预加载本地 memo 生成 contentFingerprint → localMemoName 映射
  const localContentFingerprints = new Map<string, string>();
  try {
    const localMemos = await memoServiceClient.listMemos({ pageSize: 1000 });
    for (const lm of localMemos.memos) {
      if (lm.content && lm.name) {
        const fp = computeContentFingerprint(lm.content, toIsoString(timestampToDate(lm.createTime)));
        localContentFingerprints.set(fp, lm.name);
      }
    }
  } catch {
    // 指纹预加载失败不阻塞同步
  }
  // 当元数据同步开启时，跳过游标以执行全量扫描，确保检测到仅修改 pinned/state/visibility 的变更
  const lastPullCursor = metadataSyncEnabled ? undefined : getMemoreRemotePullCursor(normalizedServerUrl);
  let latestObservedRemoteUpdateTime = lastPullCursor ?? getMemoreRemotePullCursor(normalizedServerUrl);
  let allStatesFullyScanned = true;

  try {
    const pullStates = ["NORMAL", "ARCHIVED"] as const;
    for (const pullState of pullStates) {
      let nextStatePageToken = "";
      let stateStoppedByPullCursor = false;

    while (pulledPages < maxPages) {
      const searchParams = new URLSearchParams({
        pageSize: String(pageSize),
        state: pullState,
        orderBy: "update_time desc",
      });
      if (nextStatePageToken) {
        searchParams.set("pageToken", nextStatePageToken);
      }

      const response = await fetch(`${normalizedServerUrl}/api/v1/memos?${searchParams.toString()}`, {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
      });
      const payload = await parseJsonIfPossible(response);

      if (!response.ok) {
        const serverMessage = extractStatusMessage(payload);
        markSyncErrorStatus(normalizedServerUrl, "pull", "MEMO_LIST_FAILED", serverMessage);
        return {
          ok: false,
          errorCode: "MEMO_LIST_FAILED",
          serverMessage,
        };
      }

      const remoteMemos = readMemos(payload);
      totalMemoCount += remoteMemos.length;
      pulledPages += 1;
      nextStatePageToken = readNextPageToken(payload);

      for (const remoteMemoRaw of remoteMemos) {
        const rawRemoteMemoName = readString(remoteMemoRaw, "name");
        if (rawRemoteMemoName) {
          seenRemoteMemoNames.add(rawRemoteMemoName);
        }

        const rawRemoteMemoUpdateTime = readString(remoteMemoRaw, "updateTime");
        if (
          rawRemoteMemoUpdateTime &&
          (!latestObservedRemoteUpdateTime || isLaterTimestamp(rawRemoteMemoUpdateTime, latestObservedRemoteUpdateTime))
        ) {
          latestObservedRemoteUpdateTime = rawRemoteMemoUpdateTime;
        }

        const reachedKnownCursor =
          !!lastPullCursor && !!rawRemoteMemoUpdateTime && !isLaterTimestamp(rawRemoteMemoUpdateTime, lastPullCursor);
        if (reachedKnownCursor) {
          stateStoppedByPullCursor = true;
          break;
        }

        const remoteMemo = parseRemoteMemoForImport(remoteMemoRaw);
        if (!remoteMemo) {
          skippedCount += 1;
          continue;
        }

        const existingBinding = remoteMemoBindings[remoteMemo.name];
        if (existingBinding) {
          const updateTimeUnchanged =
            !!existingBinding.remoteUpdateTime &&
            !!remoteMemo.updateTimeRaw &&
            existingBinding.remoteUpdateTime === remoteMemo.updateTimeRaw;

          // 元数据同步：当 updateTime 未变时检测 pinned/state/visibility 变更
          let metadataOnlyUpdate = false;
          if (updateTimeUnchanged) {
            try {
              const localMemoCheck = await memoServiceClient.getMemo({ name: existingBinding.localMemoName });
              const pinnedDiffers = syncPinned && localMemoCheck.pinned !== remoteMemo.pinned;
              const stateDiffers = syncArchived && toMemoStateString(localMemoCheck.state) !== remoteMemo.state;
              const visibilityDiffers = localMemoCheck.visibility !== remoteMemo.visibility;
              if (pinnedDiffers || stateDiffers || visibilityDiffers) {
                metadataOnlyUpdate = true;
              }
            } catch {
              // 无法获取本地 memo 时跳过元数据对比
            }
          }

          if (updateTimeUnchanged && !metadataOnlyUpdate) {
            skippedCount += 1;
            continue;
          }

          // 仅元数据变更：执行轻量更新（不同步内容和附件）
          if (metadataOnlyUpdate) {
            if (dryRun) {
              updatedCount += 1;
              continue;
            }
            try {
              const metaUpdateMask: string[] = [];
              const metaPatch: Partial<Memo> = { name: existingBinding.localMemoName };
              const localMemoMeta = await memoServiceClient.getMemo({ name: existingBinding.localMemoName });

              if (syncPinned && localMemoMeta.pinned !== remoteMemo.pinned) {
                metaUpdateMask.push("pinned");
                metaPatch.pinned = remoteMemo.pinned;
              }
              if (syncArchived && toMemoStateString(localMemoMeta.state) !== remoteMemo.state) {
                metaUpdateMask.push("state");
                metaPatch.state = remoteMemo.state === "ARCHIVED" ? State.ARCHIVED : State.NORMAL;
              }
              if (localMemoMeta.visibility !== remoteMemo.visibility) {
                metaUpdateMask.push("visibility");
                metaPatch.visibility = remoteMemo.visibility;
              }

              if (metaUpdateMask.length > 0) {
                await memoServiceClient.updateMemo({
                  memo: create(MemoSchema, metaPatch as Record<string, unknown>),
                  updateMask: create(FieldMaskSchema, { paths: metaUpdateMask }),
                });
                updatedCount += 1;
              } else {
                skippedCount += 1;
              }
            } catch {
              failedCount += 1;
            }
            continue;
          }

          let localCurrentUpdateTimeRaw: string | undefined;
          try {
            const localMemo = await memoServiceClient.getMemo({ name: existingBinding.localMemoName });
            localCurrentUpdateTimeRaw = getMemoUpdateTimeRaw(localMemo);
          } catch (error) {
            if (isConnectNotFoundError(error)) {
              delete remoteMemoBindings[remoteMemo.name];
              importedRemoteMemoNames.delete(remoteMemo.name);
            } else {
              failedCount += 1;
              continue;
            }
          }

          const bindingStillExists = !!remoteMemoBindings[remoteMemo.name];
          if (!bindingStillExists) {
            // 本地已删除对应 memo：回退为“重新导入远端”为新本地 memo
            // 继续走后续的导入逻辑
          } else {
            const localChangedSinceLastSync =
              !!localCurrentUpdateTimeRaw &&
              !!existingBinding.localUpdateTime &&
              localCurrentUpdateTimeRaw !== existingBinding.localUpdateTime;
            const remoteChangedSinceLastSync =
              !!existingBinding.remoteUpdateTime &&
              !!remoteMemo.updateTimeRaw &&
              existingBinding.remoteUpdateTime !== remoteMemo.updateTimeRaw;

            if (localChangedSinceLastSync && remoteChangedSinceLastSync) {
              // 冲突策略（LWW）：本地时间更新更晚则保留本地，跳过远端覆盖
              if (isLaterTimestamp(localCurrentUpdateTimeRaw, remoteMemo.updateTimeRaw)) {
                conflictCount += 1;
                skippedCount += 1;
                pullConflictLogs.push({
                  remoteMemoName: remoteMemo.name,
                  localMemoName: existingBinding.localMemoName,
                  localUpdateTime: localCurrentUpdateTimeRaw,
                  remoteUpdateTime: remoteMemo.updateTimeRaw,
                  recordedAt: new Date().toISOString(),
                });
                continue;
              }
            }
          }

          if (!remoteMemoBindings[remoteMemo.name]) {
            // binding 已被移除，继续走后续导入分支
          } else {
            if (dryRun) {
              // Dry Run 模式：只统计需要更新的数量，不实际写入
              updatedCount += 1;
              continue;
            }
            try {
              const localAttachmentSyncResult = await syncRemoteMemoAttachmentsToLocal(
                normalizedServerUrl,
                accessToken,
                remoteMemo.attachments,
              );
              failedCount += localAttachmentSyncResult.failedCount;

              const updateMaskPaths = ["content", "visibility", "attachments"];
              if (syncPinned) updateMaskPaths.push("pinned");
              if (syncArchived) updateMaskPaths.push("state");
              const localMemoPatch: Partial<Memo> = {
                name: existingBinding.localMemoName,
                content: remoteMemo.content,
                visibility: remoteMemo.visibility,
                attachments: localAttachmentSyncResult.attachmentReferences,
              };
              if (syncPinned) {
                localMemoPatch.pinned = remoteMemo.pinned;
              }
              if (syncArchived) {
                localMemoPatch.state = remoteMemo.state === "ARCHIVED" ? State.ARCHIVED : State.NORMAL;
              }

              if (remoteMemo.displayTime) {
                localMemoPatch.displayTime = timestampFromDate(remoteMemo.displayTime);
                updateMaskPaths.push("display_time");
              }

              if (remoteMemo.createTime) {
                localMemoPatch.createTime = timestampFromDate(remoteMemo.createTime);
                updateMaskPaths.push("create_time");
              }

              if (remoteMemo.updateTime) {
                localMemoPatch.updateTime = timestampFromDate(remoteMemo.updateTime);
                updateMaskPaths.push("update_time");
              }

              const localMemo = await memoServiceClient.updateMemo({
                memo: create(MemoSchema, localMemoPatch as Record<string, unknown>),
                updateMask: create(FieldMaskSchema, { paths: updateMaskPaths }),
              });

              existingBinding.remoteUpdateTime = remoteMemo.updateTimeRaw;
              existingBinding.localUpdateTime = getMemoUpdateTimeRaw(localMemo);
              importedRemoteMemoNames.add(remoteMemo.name);
              updatedCount += 1;
            } catch {
              failedCount += 1;
            }
            continue;
          }
        }

        if (importedRemoteMemoNames.has(remoteMemo.name)) {
          skippedCount += 1;
          continue;
        }

        // 内容指纹去重：检查本地是否已存在相同内容的 memo，避免重复创建
        const remoteFp = computeContentFingerprint(remoteMemo.content, remoteMemo.createTime?.toISOString());
        const existingLocalName = localContentFingerprints.get(remoteFp);
        if (existingLocalName) {
          // 已存在相同内容的本地 memo，建立 binding 而不是重复创建
          remoteMemoBindings[remoteMemo.name] = {
            localMemoName: existingLocalName,
            remoteUpdateTime: remoteMemo.updateTimeRaw,
            localUpdateTime: undefined,
          };
          importedRemoteMemoNames.add(remoteMemo.name);
          skippedCount += 1;
          continue;
        }

        if (dryRun) {
          // Dry Run 模式：只统计需要创建的数量，不实际写入
          importedCount += 1;
          continue;
        }

        try {
          const localAttachmentSyncResult = await syncRemoteMemoAttachmentsToLocal(
            normalizedServerUrl,
            accessToken,
            remoteMemo.attachments,
          );
          failedCount += localAttachmentSyncResult.failedCount;

          const localMemoData: Partial<Memo> = {
            content: remoteMemo.content,
            visibility: remoteMemo.visibility,
            attachments: localAttachmentSyncResult.attachmentReferences,
            displayTime: remoteMemo.displayTime ? timestampFromDate(remoteMemo.displayTime) : undefined,
            createTime: remoteMemo.createTime ? timestampFromDate(remoteMemo.createTime) : undefined,
            updateTime: remoteMemo.updateTime ? timestampFromDate(remoteMemo.updateTime) : undefined,
          };
          if (syncPinned) {
            localMemoData.pinned = remoteMemo.pinned;
          }

          const localMemo = await memoServiceClient.createMemo({
            memo: create(MemoSchema, localMemoData as Record<string, unknown>),
          });

          if (syncArchived && remoteMemo.state === "ARCHIVED") {
            try {
              await memoServiceClient.updateMemo({
                memo: create(MemoSchema, { name: localMemo.name, state: State.ARCHIVED } as Record<string, unknown>),
                updateMask: create(FieldMaskSchema, { paths: ["state"] }),
              });
            } catch {
              console.warn(`[memore-sync] 本地 memo 归档状态设置失败: ${localMemo.name}`);
            }
          }

          remoteMemoBindings[remoteMemo.name] = {
            localMemoName: localMemo.name,
            remoteUpdateTime: remoteMemo.updateTimeRaw,
            localUpdateTime: getMemoUpdateTimeRaw(localMemo),
          };
          importedRemoteMemoNames.add(remoteMemo.name);
          // 注册到指纹表，防止同一批次内重复
          localContentFingerprints.set(remoteFp, localMemo.name);
          importedCount += 1;
        } catch {
          failedCount += 1;
        }
      }

      // 断点续传：每页处理完毕后增量保存元数据，中断后下次可从此处继续
      if (!dryRun) {
        setImportedRemoteMemoNameSet(normalizedServerUrl, importedRemoteMemoNames);
        setRemoteMemoBindings(normalizedServerUrl, remoteMemoBindings);
        if (latestObservedRemoteUpdateTime) {
          setMemoreRemotePullCursor(normalizedServerUrl, latestObservedRemoteUpdateTime);
        }
      }

      if (stateStoppedByPullCursor) {
        break;
      }

      if (!nextStatePageToken) {
        break;
      }
    } // end of while (pulledPages < maxPages)

      if (pulledPages >= maxPages && nextStatePageToken && !stateStoppedByPullCursor) {
        allStatesFullyScanned = false;
      }
    } // end of pullStates loop

    const shouldRunRemoteDeletionSweep = allStatesFullyScanned;
    if (shouldRunRemoteDeletionSweep) {
      // 安全检查：先统计远端已删除的 memo 数量，超过阈值时要求用户确认
      const orphanedRemoteNames: string[] = [];
      for (const [remoteMemoName] of Object.entries(remoteMemoBindings)) {
        if (seenRemoteMemoNames.has(remoteMemoName)) continue;
        const remoteCheck = await checkRemoteMemoByName(normalizedServerUrl, accessToken, remoteMemoName);
        if (!remoteCheck.ok) {
          if (remoteCheck.authFailed) {
            markSyncErrorStatus(normalizedServerUrl, "pull", "AUTH_REQUEST_FAILED", remoteCheck.serverMessage);
            return { ok: false, errorCode: "AUTH_REQUEST_FAILED", serverMessage: remoteCheck.serverMessage };
          }
          continue;
        }
        if (!remoteCheck.exists) {
          orphanedRemoteNames.push(remoteMemoName);
        }
      }

      if (orphanedRemoteNames.length > SYNC_DELETION_CONFIRM_THRESHOLD && !input.confirmDeletions && !dryRun) {
        console.warn(
          `[memore-sync] pull: ${orphanedRemoteNames.length} local memos would be deleted, ` +
            `exceeds threshold ${SYNC_DELETION_CONFIRM_THRESHOLD}. Aborting — user confirmation required.`,
        );
        return {
          ok: true,
          totalMemoCount: totalMemoCount ?? 0,
          pulledPages: pulledPages ?? 0,
          importedCount,
          updatedCount,
          deletedCount: 0,
          conflictCount,
          skippedCount,
          failedCount,
          needsDeletionConfirmation: true,
          pendingDeletionCount: orphanedRemoteNames.length,
        };
      }

      for (const remoteMemoName of orphanedRemoteNames) {
        const binding = remoteMemoBindings[remoteMemoName];
        if (!binding) continue;

        if (dryRun) {
          deletedCount += 1;
          continue;
        }

        try {
          await memoServiceClient.deleteMemo({
            name: binding.localMemoName,
            force: true,
          });
        } catch (error) {
          if (!isConnectNotFoundError(error)) {
            failedCount += 1;
            continue;
          }
        }

        delete remoteMemoBindings[remoteMemoName];
        importedRemoteMemoNames.delete(remoteMemoName);
        deletedCount += 1;
      }
    }

    // Dry Run 模式下不持久化任何元数据
    if (!dryRun) {
      setImportedRemoteMemoNameSet(normalizedServerUrl, importedRemoteMemoNames);
      setRemoteMemoBindings(normalizedServerUrl, remoteMemoBindings);
      if (latestObservedRemoteUpdateTime) {
        setMemoreRemotePullCursor(normalizedServerUrl, latestObservedRemoteUpdateTime);
      }

      markPullSuccessStatus(
        normalizedServerUrl,
        {
          totalMemoCount,
          pulledPages,
          importedCount,
          updatedCount,
          deletedCount,
          conflictCount,
          skippedCount,
          failedCount,
        },
        pullConflictLogs,
      );
    }

    return {
      ok: true,
      dryRun,
      totalMemoCount,
      pulledPages,
      importedCount,
      updatedCount,
      deletedCount,
      conflictCount,
      skippedCount,
      failedCount,
    };
  } catch {
    markSyncErrorStatus(normalizedServerUrl, "pull", "NETWORK");
    return {
      ok: false,
      errorCode: "NETWORK",
    };
  }
};

export const pullMemoreRemoteMemos = async (input: MemoreRemotePullInput): Promise<MemoreRemotePullResult> => {
  const normalizedServerUrl = normalizeMemoreRemoteServerUrl(input.serverUrl);
  if (!normalizedServerUrl) {
    return {
      ok: false,
      errorCode: "INVALID_URL",
    };
  }

  const accessToken = input.accessToken.trim();
  if (!accessToken) {
    return {
      ok: false,
      errorCode: "MISSING_TOKEN",
    };
  }

  const pageSize = Math.max(1, Math.min(500, input.pageSize ?? 100));
  const maxPages = Math.max(1, Math.min(50, input.maxPages ?? 10));
  let nextPageToken = "";
  let pulledPages = 0;
  let totalMemoCount = 0;

  try {
    while (pulledPages < maxPages) {
      const searchParams = new URLSearchParams({
        pageSize: String(pageSize),
        state: "NORMAL",
        orderBy: "update_time desc",
      });
      if (nextPageToken) {
        searchParams.set("pageToken", nextPageToken);
      }

      const response = await fetch(`${normalizedServerUrl}/api/v1/memos?${searchParams.toString()}`, {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
      });
      const payload = await parseJsonIfPossible(response);

      if (!response.ok) {
        return {
          ok: false,
          errorCode: "MEMO_LIST_FAILED",
          serverMessage: extractStatusMessage(payload),
        };
      }

      totalMemoCount += readMemos(payload).length;
      pulledPages += 1;
      nextPageToken = readNextPageToken(payload);

      if (!nextPageToken) {
        break;
      }
    }

    return {
      ok: true,
      totalMemoCount,
      pulledPages,
      importedCount: 0,
      updatedCount: 0,
      deletedCount: 0,
      conflictCount: 0,
      skippedCount: 0,
      failedCount: 0,
    };
  } catch {
    return {
      ok: false,
      errorCode: "NETWORK",
    };
  }
};

const extractStatusMessage = (payload: Record<string, unknown> | null): string | undefined => {
  if (!payload) {
    return undefined;
  }
  return readString(payload, "message");
};

export const normalizeMemoreRemoteServerUrl = (rawServerUrl: string): string => {
  const trimmed = rawServerUrl.trim();
  if (!trimmed) {
    return "";
  }

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return "";
    }

    return `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, "");
  } catch {
    return "";
  }
};

const getAuthUser = (payload: Record<string, unknown> | null): Record<string, unknown> | null => {
  if (!payload) {
    return null;
  }

  const user = payload.user;
  return isRecord(user) ? user : null;
};

const readMemos = (payload: Record<string, unknown> | null): unknown[] => {
  if (!payload) {
    return [];
  }

  const memos = payload.memos;
  return Array.isArray(memos) ? memos : [];
};

const readNextPageToken = (payload: Record<string, unknown> | null): string => {
  if (!payload) {
    return "";
  }

  const nextPageToken = payload.nextPageToken;
  return typeof nextPageToken === "string" ? nextPageToken : "";
};

export const testMemoreRemoteConnection = async (input: MemoreRemoteConnectionTestInput): Promise<MemoreRemoteConnectionTestResult> => {
  const normalizedServerUrl = normalizeMemoreRemoteServerUrl(input.serverUrl);
  if (!normalizedServerUrl) {
    return {
      ok: false,
      errorCode: "INVALID_URL",
    };
  }

  const accessToken = input.accessToken.trim();
  if (!accessToken) {
    return {
      ok: false,
      errorCode: "MISSING_TOKEN",
    };
  }

  const requestInitBase: RequestInit = {
    method: "GET",
    headers: {
      Accept: "application/json",
    },
  };

  try {
    const profileResponse = await fetch(`${normalizedServerUrl}/api/v1/instance/profile`, requestInitBase);
    const profilePayload = await parseJsonIfPossible(profileResponse);

    if (!profileResponse.ok) {
      const serverMessage = extractStatusMessage(profilePayload);
      markSyncErrorStatus(normalizedServerUrl, "connection", "PROFILE_REQUEST_FAILED", serverMessage);
      return {
        ok: false,
        errorCode: "PROFILE_REQUEST_FAILED",
        serverMessage,
      };
    }

    const authResponse = await fetch(`${normalizedServerUrl}/api/v1/auth/me`, {
      ...requestInitBase,
      headers: {
        ...requestInitBase.headers,
        Authorization: `Bearer ${accessToken}`,
      },
    });
    const authPayload = await parseJsonIfPossible(authResponse);

    if (!authResponse.ok) {
      const serverMessage = extractStatusMessage(authPayload);
      markSyncErrorStatus(normalizedServerUrl, "connection", "AUTH_REQUEST_FAILED", serverMessage);
      return {
        ok: false,
        errorCode: "AUTH_REQUEST_FAILED",
        serverMessage,
      };
    }

    const user = getAuthUser(authPayload);

    clearConnectionErrorStatus(normalizedServerUrl);

    return {
      ok: true,
      username: readString(user, "username"),
      userResourceName: readString(user, "name"),
      instanceUrl: readString(profilePayload, "instanceUrl"),
    };
  } catch {
    markSyncErrorStatus(normalizedServerUrl, "connection", "NETWORK");
    return {
      ok: false,
      errorCode: "NETWORK",
    };
  }
};

// ─── Comment Sync ────────────────────────────────────────────────────────────

const MEMORE_COMMENT_BINDING_STORAGE_KEY = "memore-sync-comment-bindings";

interface CommentBinding {
  localCommentName: string;
  parentLocalName: string;
  parentRemoteName: string;
  remoteUpdateTime?: string;
  localUpdateTime?: string;
}

type CommentBindingMap = Record<string, Record<string, CommentBinding>>;

const loadCommentBindingMap = (): CommentBindingMap => {
  try {
    const raw = localStorage.getItem(MEMORE_COMMENT_BINDING_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) return {};

    const map: CommentBindingMap = {};
    for (const [serverKey, bindings] of Object.entries(parsed)) {
      if (!isRecord(bindings)) continue;
      const serverBindings: Record<string, CommentBinding> = {};
      for (const [remoteCommentName, binding] of Object.entries(bindings)) {
        if (!isRecord(binding)) continue;
        const localCommentName = readString(binding, "localCommentName");
        const parentLocalName = readString(binding, "parentLocalName");
        const parentRemoteName = readString(binding, "parentRemoteName");
        if (!localCommentName || !parentLocalName || !parentRemoteName) continue;
        serverBindings[remoteCommentName] = {
          localCommentName,
          parentLocalName,
          parentRemoteName,
          remoteUpdateTime: readString(binding, "remoteUpdateTime"),
          localUpdateTime: readString(binding, "localUpdateTime"),
        };
      }
      map[serverKey] = serverBindings;
    }
    return map;
  } catch {
    return {};
  }
};

const persistCommentBindingMap = (map: CommentBindingMap) => {
  try {
    localStorage.setItem(MEMORE_COMMENT_BINDING_STORAGE_KEY, JSON.stringify(map));
  } catch {
    // ignore
  }
};

const getCommentBindings = (serverKey: string): Record<string, CommentBinding> => {
  return loadCommentBindingMap()[serverKey] ?? {};
};

const setCommentBindings = (serverKey: string, bindings: Record<string, CommentBinding>) => {
  const map = loadCommentBindingMap();
  map[serverKey] = bindings;
  persistCommentBindingMap(map);
};

export interface CommentSyncResult {
  ok: boolean;
  pushedCount: number;
  pulledCount: number;
  deletedCount: number;
  failedCount: number;
  /** Local memo names whose comments changed (for query invalidation) */
  affectedLocalMemoNames: string[];
}

/**
 * Bi-directional comment sync for all bound memo pairs.
 * Called after push+pull of top-level memos.
 */
export const syncMemoreComments = async (input: {
  serverUrl: string;
  accessToken: string;
}): Promise<CommentSyncResult> => {
  const emptyResult: CommentSyncResult = { ok: false, pushedCount: 0, pulledCount: 0, deletedCount: 0, failedCount: 0, affectedLocalMemoNames: [] };
  const normalizedServerUrl = normalizeMemoreRemoteServerUrl(input.serverUrl);
  if (!normalizedServerUrl) return emptyResult;

  const accessToken = input.accessToken.trim();
  if (!accessToken) return emptyResult;

  const memoBindings = getRemoteMemoBindings(normalizedServerUrl);
  const commentBindings = getCommentBindings(normalizedServerUrl);
  let pushedCount = 0;
  let pulledCount = 0;
  let deletedCount = 0;
  let failedCount = 0;
  const affectedLocalMemoNamesSet = new Set<string>();

  const localToRemoteMemoMap = new Map<string, string>();
  const remoteToLocalMemoMap = new Map<string, string>();
  for (const [remoteName, binding] of Object.entries(memoBindings)) {
    localToRemoteMemoMap.set(binding.localMemoName, remoteName);
    remoteToLocalMemoMap.set(remoteName, binding.localMemoName);
  }

  // Build reverse lookup: localCommentName -> remoteCommentName
  const localCommentToRemote = new Map<string, string>();
  for (const [remoteCommentName, cb] of Object.entries(commentBindings)) {
    localCommentToRemote.set(cb.localCommentName, remoteCommentName);
  }

  try {
    // ── Push: local comments -> remote ──
    for (const [localMemoName, remoteMemoName] of localToRemoteMemoMap) {
      let localComments: Memo[];
      try {
        const resp = await memoServiceClient.listMemoComments({ name: localMemoName });
        localComments = resp.memos;
      } catch {
        continue;
      }

      const remoteMemoId = extractMemoIdFromName(remoteMemoName);
      const seenLocalCommentNames = new Set<string>();

      for (const localComment of localComments) {
        seenLocalCommentNames.add(localComment.name);
        const existingRemoteCommentName = localCommentToRemote.get(localComment.name);
        const localUpdateTimeRaw = getMemoUpdateTimeRaw(localComment);

        if (existingRemoteCommentName) {
          const cb = commentBindings[existingRemoteCommentName];
          if (cb && cb.localUpdateTime === localUpdateTimeRaw) continue;

          // Update existing remote comment
          const remoteCommentId = extractMemoIdFromName(existingRemoteCommentName);
          try {
            const resp = await fetch(
              `${normalizedServerUrl}/api/v1/memos/${encodeURIComponent(remoteCommentId)}?${new URLSearchParams({ updateMask: "content,visibility" }).toString()}`,
              {
                method: "PATCH",
                headers: {
                  Accept: "application/json",
                  "Content-Type": "application/json",
                  Authorization: `Bearer ${accessToken}`,
                },
                body: JSON.stringify({
                  content: localComment.content,
                  visibility: toVisibilityString(localComment.visibility),
                }),
              },
            );
            if (resp.ok) {
              const payload = await parseJsonIfPossible(resp);
              commentBindings[existingRemoteCommentName] = {
                ...cb!,
                localUpdateTime: localUpdateTimeRaw,
                remoteUpdateTime: readString(payload, "updateTime"),
              };
              affectedLocalMemoNamesSet.add(localMemoName);
              pushedCount += 1;
            } else {
              failedCount += 1;
            }
          } catch {
            failedCount += 1;
          }
        } else {
          // Create new comment on remote
          try {
            const resp = await fetch(`${normalizedServerUrl}/api/v1/memos/${encodeURIComponent(remoteMemoId)}/comments`, {
              method: "POST",
              headers: {
                Accept: "application/json",
                "Content-Type": "application/json",
                Authorization: `Bearer ${accessToken}`,
              },
              body: JSON.stringify({
                content: localComment.content,
                visibility: toVisibilityString(localComment.visibility),
              }),
            });
            if (resp.ok) {
              const payload = await parseJsonIfPossible(resp);
              const remoteCommentName = readString(payload, "name");
              if (remoteCommentName) {
                commentBindings[remoteCommentName] = {
                  localCommentName: localComment.name,
                  parentLocalName: localMemoName,
                  parentRemoteName: remoteMemoName,
                  remoteUpdateTime: readString(payload, "updateTime"),
                  localUpdateTime: localUpdateTimeRaw,
                };
                localCommentToRemote.set(localComment.name, remoteCommentName);
                affectedLocalMemoNamesSet.add(localMemoName);
                pushedCount += 1;
              }
            } else {
              failedCount += 1;
            }
          } catch {
            failedCount += 1;
          }
        }
      }

      // Delete remote comments whose local counterpart is gone
      for (const [remoteCommentName, cb] of Object.entries(commentBindings)) {
        if (cb.parentLocalName !== localMemoName) continue;
        if (seenLocalCommentNames.has(cb.localCommentName)) continue;

        // Verify local comment is truly deleted
        try {
          await memoServiceClient.getMemo({ name: cb.localCommentName });
          continue; // still exists
        } catch (e) {
          if (!isConnectNotFoundError(e)) continue;
        }

        const remoteCommentId = extractMemoIdFromName(remoteCommentName);
        try {
          await fetch(`${normalizedServerUrl}/api/v1/memos/${encodeURIComponent(remoteCommentId)}`, {
            method: "DELETE",
            headers: { Authorization: `Bearer ${accessToken}` },
          });
          delete commentBindings[remoteCommentName];
          localCommentToRemote.delete(cb.localCommentName);
          affectedLocalMemoNamesSet.add(localMemoName);
          deletedCount += 1;
        } catch {
          failedCount += 1;
        }
      }
    }

    // ── Pull: remote comments -> local ──
    for (const [remoteMemoName, localMemoName] of remoteToLocalMemoMap) {
      const remoteMemoId = extractMemoIdFromName(remoteMemoName);
      let remoteComments: Record<string, unknown>[];
      try {
        const resp = await fetch(`${normalizedServerUrl}/api/v1/memos/${encodeURIComponent(remoteMemoId)}/comments`, {
          method: "GET",
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${accessToken}`,
          },
        });
        if (!resp.ok) continue;
        const payload = await parseJsonIfPossible(resp);
        remoteComments = readMemos(payload) as Record<string, unknown>[];
      } catch {
        continue;
      }

      const seenRemoteCommentNames = new Set<string>();

      for (const remoteCommentRaw of remoteComments) {
        const remoteCommentName = readString(remoteCommentRaw, "name");
        const remoteContent = readString(remoteCommentRaw, "content") ?? "";
        const remoteUpdateTimeRaw = readString(remoteCommentRaw, "updateTime");
        if (!remoteCommentName) continue;

        seenRemoteCommentNames.add(remoteCommentName);
        const existingCb = commentBindings[remoteCommentName];

        if (existingCb) {
          if (existingCb.remoteUpdateTime === remoteUpdateTimeRaw) continue;

          // Update local comment
          try {
            await memoServiceClient.updateMemo({
              memo: create(MemoSchema, {
                name: existingCb.localCommentName,
                content: remoteContent,
                visibility: toVisibility(readString(remoteCommentRaw, "visibility")),
              } as Record<string, unknown>),
              updateMask: create(FieldMaskSchema, { paths: ["content", "visibility"] }),
            });
            existingCb.remoteUpdateTime = remoteUpdateTimeRaw;
            const localMemo = await memoServiceClient.getMemo({ name: existingCb.localCommentName });
            existingCb.localUpdateTime = getMemoUpdateTimeRaw(localMemo);
            affectedLocalMemoNamesSet.add(localMemoName);
            pulledCount += 1;
          } catch (e) {
            if (isConnectNotFoundError(e)) {
              delete commentBindings[remoteCommentName];
            } else {
              failedCount += 1;
            }
          }
        } else {
          // Create local comment
          try {
            const commentData = create(MemoSchema, {
              content: remoteContent,
              visibility: toVisibility(readString(remoteCommentRaw, "visibility")),
            });
            const localComment = await memoServiceClient.createMemoComment({
              name: localMemoName,
              comment: commentData,
            });
            commentBindings[remoteCommentName] = {
              localCommentName: localComment.name,
              parentLocalName: localMemoName,
              parentRemoteName: remoteMemoName,
              remoteUpdateTime: remoteUpdateTimeRaw,
              localUpdateTime: getMemoUpdateTimeRaw(localComment),
            };
            localCommentToRemote.set(localComment.name, remoteCommentName);
            affectedLocalMemoNamesSet.add(localMemoName);
            pulledCount += 1;
          } catch {
            failedCount += 1;
          }
        }
      }

      // Delete local comments whose remote counterpart is gone
      for (const [remoteCommentName, cb] of Object.entries(commentBindings)) {
        if (cb.parentRemoteName !== remoteMemoName) continue;
        if (seenRemoteCommentNames.has(remoteCommentName)) continue;

        try {
          await memoServiceClient.deleteMemo({ name: cb.localCommentName });
        } catch (e) {
          if (!isConnectNotFoundError(e)) {
            failedCount += 1;
            continue;
          }
        }
        delete commentBindings[remoteCommentName];
        localCommentToRemote.delete(cb.localCommentName);
        affectedLocalMemoNamesSet.add(localMemoName);
        deletedCount += 1;
      }
    }

    setCommentBindings(normalizedServerUrl, commentBindings);
    return { ok: true, pushedCount, pulledCount, deletedCount, failedCount, affectedLocalMemoNames: Array.from(affectedLocalMemoNamesSet) };
  } catch {
    setCommentBindings(normalizedServerUrl, commentBindings);
    return { ok: false, pushedCount, pulledCount, deletedCount, failedCount, affectedLocalMemoNames: Array.from(affectedLocalMemoNamesSet) };
  }
};
