/**
 * Memore 同步触发器
 *
 * 提供 triggerMemoreSync() 函数，用于在应用中的任何位置触发同步事件
 * 通过 CustomEvent 机制通知 useMemoreTriggeredSync Hook 执行实际同步
 *
 * 使用场景：手动同步按钮、memo CRUD 后自动同步等
 */
export const MEMORE_SYNC_TRIGGER_EVENT = "memore-sync-trigger";

export type MemoreSyncTriggerReason = "memo-created" | "memo-updated" | "manual";

export interface MemoreSyncTriggerEventDetail {
  reason: MemoreSyncTriggerReason;
  showToast?: boolean;
}

export const triggerMemoreSync = (detail: MemoreSyncTriggerEventDetail) => {
  if (typeof window === "undefined") {
    return;
  }

  window.dispatchEvent(
    new CustomEvent<MemoreSyncTriggerEventDetail>(MEMORE_SYNC_TRIGGER_EVENT, {
      detail,
    }),
  );
};
