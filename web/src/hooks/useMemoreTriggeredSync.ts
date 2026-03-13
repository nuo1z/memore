/**
 * Memore 事件驱动同步 Hook
 *
 * 监听特定事件（memo 创建/更新/删除、手动触发等）
 * 自动执行对应的同步操作（Push/Pull）
 *
 * 使用 triggerMemoreSync() 触发同步事件
 * 通过防抖和锁机制避免频繁重复同步
 */
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { toast } from "react-hot-toast";
import { memoKeys } from "@/hooks/useMemoQueries";
import { useMemoreSyncPreferences } from "@/hooks/useMemoreSyncPreferences";
import { userKeys } from "@/hooks/useUserQueries";
import {
  type MemoreRemoteConnectionTestErrorCode,
  runMemoreSyncTaskWithLock,
  syncMemoreLocalMemosToRemote,
  syncMemoreRemoteMemosToLocal,
  updateMemoreSyncBackgroundRuntimeStatus,
} from "@/lib/memore-sync";
import { MEMORE_SYNC_TRIGGER_EVENT, type MemoreSyncTriggerEventDetail } from "@/lib/memore-sync-trigger";
import { useTranslate } from "@/utils/i18n";

const getSyncConnectionErrorMessage = (t: ReturnType<typeof useTranslate>, errorCode?: MemoreRemoteConnectionTestErrorCode): string => {
  switch (errorCode) {
    case "INVALID_URL":
      return t("setting.preference-section.memore-sync.connection-error-invalid-url");
    case "MISSING_TOKEN":
      return t("setting.preference-section.memore-sync.connection-error-missing-token");
    case "PROFILE_REQUEST_FAILED":
      return t("setting.preference-section.memore-sync.connection-error-profile-request");
    case "AUTH_REQUEST_FAILED":
      return t("setting.preference-section.memore-sync.connection-error-auth-request");
    case "MEMO_LIST_FAILED":
      return t("setting.preference-section.memore-sync.connection-error-memo-list");
    case "NETWORK":
    default:
      return t("setting.preference-section.memore-sync.connection-error-network");
  }
};

export const useMemoreTriggeredSync = (enabled: boolean) => {
  const t = useTranslate();
  const queryClient = useQueryClient();
  const { syncPreferences } = useMemoreSyncPreferences();
  const runningRef = useRef(false);
  const pendingTriggerRef = useRef<MemoreSyncTriggerEventDetail | null>(null);

  useEffect(() => {
    const serverUrl = syncPreferences.remoteServerUrl.trim();

    if (!enabled || !syncPreferences.enableRemoteSync || !serverUrl || !syncPreferences.remoteAccessToken.trim()) {
      updateMemoreSyncBackgroundRuntimeStatus(serverUrl, {
        backgroundSyncState: "idle",
        backgroundNextRunAt: undefined,
      });
    }
  }, [enabled, syncPreferences.enableRemoteSync, syncPreferences.remoteAccessToken, syncPreferences.remoteServerUrl]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const runTriggeredSync = async (detail: MemoreSyncTriggerEventDetail) => {
      if (runningRef.current) {
        pendingTriggerRef.current = { ...detail, showToast: false };
        if (detail.showToast) {
          toast.error(t("setting.preference-section.memore-sync.connection-error-sync-locked"));
        }
        return;
      }

      if (!enabled) {
        return;
      }

      const serverUrl = syncPreferences.remoteServerUrl.trim();
      const accessToken = syncPreferences.remoteAccessToken.trim();
      if (!syncPreferences.enableRemoteSync || !serverUrl || !accessToken) {
        if (detail.showToast) {
          toast.error(t("setting.preference-section.memore-sync.manual-sync-disabled"));
        }
        return;
      }

      runningRef.current = true;
      updateMemoreSyncBackgroundRuntimeStatus(serverUrl, {
        backgroundSyncState: "running",
        backgroundLastAttemptAt: new Date().toISOString(),
        backgroundNextRunAt: undefined,
      });

      try {
        const { syncPinned, syncArchived } = syncPreferences;

        const runSyncCycle = async (confirmDeletions: boolean) => {
          return runMemoreSyncTaskWithLock(serverUrl, async () => {
            const pushResult = await syncMemoreLocalMemosToRemote({
              serverUrl,
              accessToken,
              pageSize: 100,
              maxPages: 20,
              confirmDeletions,
              syncPinned,
              syncArchived,
            });

            if (!pushResult.ok) {
              return { phase: "push" as const, pushResult };
            }

            if (pushResult.needsDeletionConfirmation) {
              return { phase: "push-confirm" as const, pushResult };
            }

            const pullResult = await syncMemoreRemoteMemosToLocal({
              serverUrl,
              accessToken,
              pageSize: 100,
              maxPages: 20,
              confirmDeletions,
              syncPinned,
              syncArchived,
            });

            if (pullResult.needsDeletionConfirmation) {
              return { phase: "pull-confirm" as const, pushResult, pullResult };
            }

            return { phase: "pull" as const, pushResult, pullResult };
          });
        };

        let lockedSyncRun = await runSyncCycle(false);

        if (!lockedSyncRun.ok) {
          updateMemoreSyncBackgroundRuntimeStatus(serverUrl, {
            backgroundSyncState: "locked",
            backgroundNextRunAt: undefined,
          });

          if (detail.showToast) {
            const msgKey =
              lockedSyncRun.reason === "IN_PROGRESS"
                ? "setting.preference-section.memore-sync.connection-error-sync-in-progress"
                : "setting.preference-section.memore-sync.connection-error-sync-locked";
            toast.error(t(msgKey));
          }
          return;
        }

        let cycleResult = lockedSyncRun.value;

        if (cycleResult.phase === "push-confirm" || cycleResult.phase === "pull-confirm") {
          const pendingCount =
            cycleResult.phase === "push-confirm"
              ? cycleResult.pushResult.pendingDeletionCount ?? 0
              : cycleResult.pullResult?.pendingDeletionCount ?? 0;
          const direction = cycleResult.phase === "push-confirm" ? "远端" : "本地";

          const confirmed = window.confirm(
            `同步安全警告\n\n` +
            `即将从${direction}删除 ${pendingCount} 条笔记。\n` +
            `这通常发生在本地数据库被清空或远端数据变更较大时。\n\n` +
            `确定要继续执行这些删除操作吗？`
          );

          if (confirmed) {
            lockedSyncRun = await runSyncCycle(true);
            if (!lockedSyncRun.ok) {
              if (detail.showToast) toast.error(t("setting.preference-section.memore-sync.connection-error-sync-locked"));
              return;
            }
            cycleResult = lockedSyncRun.value;
          } else {
            updateMemoreSyncBackgroundRuntimeStatus(serverUrl, {
              backgroundSyncState: "idle",
              backgroundNextRunAt: undefined,
            });
            if (detail.showToast) toast(t("setting.preference-section.memore-sync.sync-deletion-cancelled"), { icon: "🛡️" });
            return;
          }
        }

        if (cycleResult.phase === "push") {
          updateMemoreSyncBackgroundRuntimeStatus(serverUrl, {
            backgroundSyncState: "idle",
            backgroundNextRunAt: undefined,
          });

          if (detail.showToast) {
            const fallbackMessage = getSyncConnectionErrorMessage(t, cycleResult.pushResult.errorCode);
            if (cycleResult.pushResult.serverMessage) {
              toast.error(`${fallbackMessage} (${cycleResult.pushResult.serverMessage})`);
            } else {
              toast.error(fallbackMessage);
            }
          }
          return;
        }

        const pushResult = cycleResult.pushResult;
        const pullResult = cycleResult.pullResult!;
        if (!pullResult.ok) {
          updateMemoreSyncBackgroundRuntimeStatus(serverUrl, {
            backgroundSyncState: "idle",
            backgroundNextRunAt: undefined,
          });

          if (detail.showToast) {
            const fallbackMessage = getSyncConnectionErrorMessage(t, pullResult.errorCode);
            if (pullResult.serverMessage) {
              toast.error(`${fallbackMessage} (${pullResult.serverMessage})`);
            } else {
              toast.error(fallbackMessage);
            }
          }
          return;
        }

        const hasPushChanges =
          (pushResult.createdCount ?? 0) > 0 || (pushResult.updatedCount ?? 0) > 0 || (pushResult.deletedCount ?? 0) > 0;
        const hasPullChanges =
          (pullResult.importedCount ?? 0) > 0 ||
          (pullResult.updatedCount ?? 0) > 0 ||
          (pullResult.deletedCount ?? 0) > 0 ||
          (pullResult.conflictCount ?? 0) > 0;

        if (hasPushChanges || hasPullChanges) {
          await Promise.all([
            queryClient.invalidateQueries({ queryKey: memoKeys.lists() }),
            queryClient.invalidateQueries({ queryKey: userKeys.stats() }),
          ]);
        }

        updateMemoreSyncBackgroundRuntimeStatus(serverUrl, {
          backgroundSyncState: "idle",
          backgroundLastSuccessAt: new Date().toISOString(),
          backgroundNextRunAt: undefined,
          backgroundRetryCount: 0,
        });

        if (detail.showToast) {
          if (hasPushChanges || hasPullChanges) {
            toast.success(
              t("setting.preference-section.memore-sync.manual-sync-success", {
                created: pushResult.createdCount ?? 0,
                updated: pushResult.updatedCount ?? 0,
                deleted: pushResult.deletedCount ?? 0,
                imported: pullResult.importedCount ?? 0,
                pullUpdated: pullResult.updatedCount ?? 0,
                pullDeleted: pullResult.deletedCount ?? 0,
                conflict: pullResult.conflictCount ?? 0,
              }),
            );
          } else {
            toast.success(t("setting.preference-section.memore-sync.manual-sync-no-change"));
          }
        }
      } catch {
        updateMemoreSyncBackgroundRuntimeStatus(serverUrl, {
          backgroundSyncState: "idle",
          backgroundNextRunAt: undefined,
        });

        if (detail.showToast) {
          toast.error(t("setting.preference-section.memore-sync.connection-error-network"));
        }
      } finally {
        runningRef.current = false;
        const pending = pendingTriggerRef.current;
        if (pending) {
          pendingTriggerRef.current = null;
          void runTriggeredSync(pending);
        }
      }
    };

    const handleTrigger = (event: Event) => {
      const customEvent = event as CustomEvent<MemoreSyncTriggerEventDetail>;
      const detail = customEvent.detail ?? {
        reason: "manual",
      };

      void runTriggeredSync(detail);
    };

    window.addEventListener(MEMORE_SYNC_TRIGGER_EVENT, handleTrigger as EventListener);

    return () => {
      window.removeEventListener(MEMORE_SYNC_TRIGGER_EVENT, handleTrigger as EventListener);
    };
  }, [enabled, queryClient, syncPreferences.enableRemoteSync, syncPreferences.remoteAccessToken, syncPreferences.remoteServerUrl, syncPreferences.syncPinned, syncPreferences.syncArchived, t]);
};
