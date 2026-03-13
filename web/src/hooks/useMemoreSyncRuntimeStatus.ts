/**
 * Memore 同步运行时状态 Hook
 *
 * 提供当前同步任务的实时状态（syncing / success / error）
 * 包含上次推送/拉取时间、错误信息等
 *
 * 状态来源：localStorage + CustomEvent，支持跨标签页同步
 * 主要被 InsertMenu 同步按钮和设置页面使用
 */
import { useEffect, useMemo, useState } from "react";
import {
  getMemoreSyncRuntimeStatus,
  MEMORE_SYNC_RUNTIME_STATUS_EVENT,
  MEMORE_SYNC_RUNTIME_STATUS_STORAGE_KEY,
  type MemoreSyncRuntimeStatus,
  type MemoreSyncRuntimeStatusEventDetail,
  normalizeMemoreRemoteServerUrl,
} from "@/lib/memore-sync";

const EMPTY_SYNC_RUNTIME_STATUS: MemoreSyncRuntimeStatus = {};

export const useMemoreSyncRuntimeStatus = (remoteServerUrl: string) => {
  const normalizedServerUrl = useMemo(() => normalizeMemoreRemoteServerUrl(remoteServerUrl), [remoteServerUrl]);

  const [runtimeStatus, setRuntimeStatus] = useState<MemoreSyncRuntimeStatus>(() => {
    if (!normalizedServerUrl) {
      return EMPTY_SYNC_RUNTIME_STATUS;
    }

    return getMemoreSyncRuntimeStatus(normalizedServerUrl);
  });

  useEffect(() => {
    if (!normalizedServerUrl) {
      setRuntimeStatus(EMPTY_SYNC_RUNTIME_STATUS);
      return;
    }

    setRuntimeStatus(getMemoreSyncRuntimeStatus(normalizedServerUrl));
  }, [normalizedServerUrl]);

  useEffect(() => {
    const handleRuntimeStatusUpdated = (event: Event) => {
      const customEvent = event as CustomEvent<MemoreSyncRuntimeStatusEventDetail>;
      if (customEvent.detail?.serverUrl !== normalizedServerUrl) {
        return;
      }

      setRuntimeStatus(customEvent.detail.status);
    };

    const handleStorageChanged = (event: StorageEvent) => {
      if (event.key !== MEMORE_SYNC_RUNTIME_STATUS_STORAGE_KEY) {
        return;
      }

      if (!normalizedServerUrl) {
        setRuntimeStatus(EMPTY_SYNC_RUNTIME_STATUS);
        return;
      }

      setRuntimeStatus(getMemoreSyncRuntimeStatus(normalizedServerUrl));
    };

    window.addEventListener(MEMORE_SYNC_RUNTIME_STATUS_EVENT, handleRuntimeStatusUpdated as EventListener);
    window.addEventListener("storage", handleStorageChanged);

    return () => {
      window.removeEventListener(MEMORE_SYNC_RUNTIME_STATUS_EVENT, handleRuntimeStatusUpdated as EventListener);
      window.removeEventListener("storage", handleStorageChanged);
    };
  }, [normalizedServerUrl]);

  return {
    runtimeStatus,
    normalizedServerUrl,
  };
};
