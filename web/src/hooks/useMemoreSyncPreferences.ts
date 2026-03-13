/**
 * Memore 同步偏好设置 Hook
 *
 * 管理存储在 localStorage 中的同步配置：
 * - enableRemoteSync：是否启用远端同步
 * - remoteServerUrl：远端 Memos 服务器地址
 * - remoteAccessToken：远端访问令牌
 * - autoSyncOnStartup：启动时自动同步
 *
 * 通过 CustomEvent 和 StorageEvent 实现跨组件/跨标签页的偏好同步
 */
import { useCallback, useEffect, useMemo, useState } from "react";

const MEMORE_SYNC_PREFERENCES_STORAGE_KEY = "memore-sync-preferences";
const MEMORE_SYNC_PREFERENCES_EVENT = "memore-sync-preferences-updated";

export interface MemoreSyncPreferences {
  enableRemoteSync: boolean;
  remoteServerUrl: string;
  remoteAccessToken: string;
  autoSyncOnStartup: boolean;
  syncPinned: boolean;
  syncArchived: boolean;
}

const DEFAULT_MEMORE_SYNC_PREFERENCES: MemoreSyncPreferences = {
  enableRemoteSync: false,
  remoteServerUrl: "",
  remoteAccessToken: "",
  autoSyncOnStartup: false,
  syncPinned: false,
  syncArchived: false,
};

const parseSyncPreferences = (rawValue: string | null): MemoreSyncPreferences => {
  if (!rawValue) {
    return DEFAULT_MEMORE_SYNC_PREFERENCES;
  }

  try {
    const parsed = JSON.parse(rawValue) as Partial<MemoreSyncPreferences>;
    return {
      enableRemoteSync: parsed.enableRemoteSync ?? DEFAULT_MEMORE_SYNC_PREFERENCES.enableRemoteSync,
      remoteServerUrl: parsed.remoteServerUrl ?? DEFAULT_MEMORE_SYNC_PREFERENCES.remoteServerUrl,
      remoteAccessToken: parsed.remoteAccessToken ?? DEFAULT_MEMORE_SYNC_PREFERENCES.remoteAccessToken,
      autoSyncOnStartup: parsed.autoSyncOnStartup ?? DEFAULT_MEMORE_SYNC_PREFERENCES.autoSyncOnStartup,
      syncPinned: parsed.syncPinned ?? DEFAULT_MEMORE_SYNC_PREFERENCES.syncPinned,
      syncArchived: parsed.syncArchived ?? DEFAULT_MEMORE_SYNC_PREFERENCES.syncArchived,
    };
  } catch {
    return DEFAULT_MEMORE_SYNC_PREFERENCES;
  }
};

export const getMemoreSyncPreferences = (): MemoreSyncPreferences => {
  try {
    return parseSyncPreferences(localStorage.getItem(MEMORE_SYNC_PREFERENCES_STORAGE_KEY));
  } catch {
    return DEFAULT_MEMORE_SYNC_PREFERENCES;
  }
};

const persistMemoreSyncPreferences = (preferences: MemoreSyncPreferences) => {
  try {
    localStorage.setItem(MEMORE_SYNC_PREFERENCES_STORAGE_KEY, JSON.stringify(preferences));
  } catch {
    // 忽略 localStorage 异常（隐私模式、配额超限等）
  }

  window.dispatchEvent(
    new CustomEvent<MemoreSyncPreferences>(MEMORE_SYNC_PREFERENCES_EVENT, {
      detail: preferences,
    }),
  );
};

export const useMemoreSyncPreferences = () => {
  const [syncPreferences, setSyncPreferences] = useState<MemoreSyncPreferences>(() => getMemoreSyncPreferences());

  useEffect(() => {
    const handlePreferencesUpdated = (event: Event) => {
      const customEvent = event as CustomEvent<MemoreSyncPreferences>;
      if (customEvent.detail) {
        setSyncPreferences(customEvent.detail);
        return;
      }

      setSyncPreferences(getMemoreSyncPreferences());
    };

    const handleStorageChanged = (event: StorageEvent) => {
      if (event.key !== MEMORE_SYNC_PREFERENCES_STORAGE_KEY) {
        return;
      }

      setSyncPreferences(getMemoreSyncPreferences());
    };

    window.addEventListener(MEMORE_SYNC_PREFERENCES_EVENT, handlePreferencesUpdated as EventListener);
    window.addEventListener("storage", handleStorageChanged);

    return () => {
      window.removeEventListener(MEMORE_SYNC_PREFERENCES_EVENT, handlePreferencesUpdated as EventListener);
      window.removeEventListener("storage", handleStorageChanged);
    };
  }, []);

  const updateSyncPreferences = useCallback((partial: Partial<MemoreSyncPreferences>) => {
    setSyncPreferences((previous: MemoreSyncPreferences) => {
      const next = {
        ...previous,
        ...partial,
      };
      persistMemoreSyncPreferences(next);
      return next;
    });
  }, []);

  const resetSyncPreferences = useCallback(() => {
    setSyncPreferences(DEFAULT_MEMORE_SYNC_PREFERENCES);
    persistMemoreSyncPreferences(DEFAULT_MEMORE_SYNC_PREFERENCES);
  }, []);

  return useMemo(
    () => ({
      syncPreferences,
      updateSyncPreferences,
      resetSyncPreferences,
    }),
    [syncPreferences, resetSyncPreferences, updateSyncPreferences],
  );
};
