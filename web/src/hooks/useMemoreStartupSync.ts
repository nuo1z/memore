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
} from "@/lib/memore-sync";
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

export const useMemoreStartupSync = (enabled: boolean) => {
  const t = useTranslate();
  const queryClient = useQueryClient();
  const { syncPreferences } = useMemoreSyncPreferences();
  const startupSyncKeyRef = useRef("");

  useEffect(() => {
    if (!enabled) {
      return;
    }

    if (!syncPreferences.enableRemoteSync || !syncPreferences.autoSyncOnStartup) {
      return;
    }

    const serverUrl = syncPreferences.remoteServerUrl.trim();
    const accessToken = syncPreferences.remoteAccessToken.trim();
    if (!serverUrl || !accessToken) {
      return;
    }

    const syncKey = `${serverUrl}::${accessToken}`;
    if (startupSyncKeyRef.current === syncKey) {
      return;
    }
    startupSyncKeyRef.current = syncKey;

    let cancelled = false;

    void (async () => {
      try {
        const { syncPinned, syncArchived } = syncPreferences;

        const lockedSyncRun = await runMemoreSyncTaskWithLock(serverUrl, async () => {
          const pushResult = await syncMemoreLocalMemosToRemote({
            serverUrl,
            accessToken,
            pageSize: 100,
            maxPages: 20,
            syncPinned,
            syncArchived,
          });

          if (!pushResult.ok) {
            return {
              phase: "push" as const,
              pushResult,
            };
          }

          const pullResult = await syncMemoreRemoteMemosToLocal({
            serverUrl,
            accessToken,
            pageSize: 100,
            maxPages: 20,
            syncPinned,
            syncArchived,
          });

          return {
            phase: "pull" as const,
            pushResult,
            pullResult,
          };
        });

        if (cancelled) {
          return;
        }

        if (!lockedSyncRun.ok) {
          // 另一个标签页正在执行同步，当前标签页启动阶段跳过即可。
          return;
        }

        const cycleResult = lockedSyncRun.value;
        const pushResult = cycleResult.pushResult;

        if ((pushResult.createdCount ?? 0) > 0 || (pushResult.updatedCount ?? 0) > 0 || (pushResult.deletedCount ?? 0) > 0) {
          toast.success(
            t("setting.preference-section.memore-sync.auto-sync-push-success", {
              created: pushResult.createdCount ?? 0,
              updated: pushResult.updatedCount ?? 0,
              deleted: pushResult.deletedCount ?? 0,
              skipped: pushResult.skippedCount ?? 0,
              failed: pushResult.failedCount ?? 0,
            }),
          );
        }

        if (cycleResult.phase === "push") {
          const fallbackMessage = getSyncConnectionErrorMessage(t, pushResult.errorCode);
          if (pushResult.serverMessage) {
            toast.error(`${fallbackMessage} (${pushResult.serverMessage})`);
          } else {
            toast.error(fallbackMessage);
          }
          return;
        }

        const result = cycleResult.pullResult;

        if (result.ok) {
          if (
            (result.importedCount ?? 0) > 0 ||
            (result.updatedCount ?? 0) > 0 ||
            (result.deletedCount ?? 0) > 0 ||
            (result.conflictCount ?? 0) > 0
          ) {
            await Promise.all([
              queryClient.invalidateQueries({ queryKey: memoKeys.lists() }),
              queryClient.invalidateQueries({ queryKey: userKeys.stats() }),
            ]);

            if (cancelled) {
              return;
            }

            toast.success(
              t("setting.preference-section.memore-sync.auto-sync-import-success", {
                imported: result.importedCount ?? 0,
                updated: result.updatedCount ?? 0,
                deleted: result.deletedCount ?? 0,
                conflict: result.conflictCount ?? 0,
                skipped: result.skippedCount ?? 0,
                failed: result.failedCount ?? 0,
              }),
            );
          }
          return;
        }

        const fallbackMessage = getSyncConnectionErrorMessage(t, result.errorCode);
        if (result.serverMessage) {
          toast.error(`${fallbackMessage} (${result.serverMessage})`);
        } else {
          toast.error(fallbackMessage);
        }
      } catch {
        if (!cancelled) {
          toast.error(t("setting.preference-section.memore-sync.connection-error-network"));
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    enabled,
    queryClient,
    syncPreferences.autoSyncOnStartup,
    syncPreferences.enableRemoteSync,
    syncPreferences.remoteAccessToken,
    syncPreferences.remoteServerUrl,
    t,
  ]);
};
