import { create } from "@bufbuild/protobuf";
import { useQueryClient } from "@tanstack/react-query";
import { LoaderIcon, MoreVerticalIcon, PenLineIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "react-hot-toast";
import ChangeMemberPasswordDialog from "@/components/ChangeMemberPasswordDialog";
import UpdateAccountDialog from "@/components/UpdateAccountDialog";
import UserAvatar from "@/components/UserAvatar";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useAuth } from "@/contexts/AuthContext";
import { useDialog } from "@/hooks/useDialog";
import { memoKeys } from "@/hooks/useMemoQueries";
import { useMemoreEditorPreferences } from "@/hooks/useMemoreEditorPreferences";
import { useMemoreSyncPreferences } from "@/hooks/useMemoreSyncPreferences";
import { useMemoreSyncRuntimeStatus } from "@/hooks/useMemoreSyncRuntimeStatus";
import { userKeys, useUpdateUserGeneralSetting } from "@/hooks/useUserQueries";
import {
  clearMemoreSyncRuntimeStatus,
  exportMemoreSyncMetadata,
  importMemoreSyncMetadata,
  type MemoreRemoteConnectionTestErrorCode,
  resetMemoreSyncMetadata,
  runMemoreSyncTaskWithLock,
  syncMemoreLocalMemosToRemote,
  syncMemoreRemoteMemosToLocal,
  testMemoreRemoteConnection,
} from "@/lib/memore-sync";
import { Visibility } from "@/types/proto/api/v1/memo_service_pb";
import { UserSetting_GeneralSetting, UserSetting_GeneralSettingSchema } from "@/types/proto/api/v1/user_service_pb";
import { loadLocale, useTranslate } from "@/utils/i18n";
import { convertVisibilityFromString, convertVisibilityToString } from "@/utils/memo";
import { loadTheme } from "@/utils/theme";
import LocaleSelect from "../LocaleSelect";
import ThemeSelect from "../ThemeSelect";
import VisibilityIcon from "../VisibilityIcon";
import SettingGroup from "./SettingGroup";
import SettingRow from "./SettingRow";
import SettingSection from "./SettingSection";
import WebhookSection from "./WebhookSection";

const PreferencesSection = () => {
  const t = useTranslate();
  const queryClient = useQueryClient();
  const { currentUser, userGeneralSetting: generalSetting, refetchSettings } = useAuth();
  const { mutate: updateUserGeneralSetting } = useUpdateUserGeneralSetting(currentUser?.name);
  const { preferences, updatePreferences } = useMemoreEditorPreferences();
  const { syncPreferences, updateSyncPreferences } = useMemoreSyncPreferences();
  const { runtimeStatus } = useMemoreSyncRuntimeStatus(syncPreferences.remoteServerUrl);
  const accountDialog = useDialog();
  const passwordDialog = useDialog();
  const [isTestingSyncConnection, setIsTestingSyncConnection] = useState(false);
  const [isPushingLocalMemos, setIsPushingLocalMemos] = useState(false);
  const [isPullingRemoteMemos, setIsPullingRemoteMemos] = useState(false);

  const getSyncConnectionErrorMessage = (errorCode?: MemoreRemoteConnectionTestErrorCode) => {
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

  const getBackgroundSyncStateLabel = (state?: "idle" | "waiting" | "running" | "backoff" | "locked") => {
    switch (state) {
      case "waiting":
        return t("setting.preference-section.memore-sync.status-background-state-waiting");
      case "running":
        return t("setting.preference-section.memore-sync.status-background-state-running");
      case "backoff":
        return t("setting.preference-section.memore-sync.status-background-state-backoff");
      case "locked":
        return t("setting.preference-section.memore-sync.status-background-state-locked");
      case "idle":
      default:
        return t("setting.preference-section.memore-sync.status-background-state-idle");
    }
  };

  const getSyncErrorPhaseLabel = (phase?: "push" | "pull" | "connection") => {
    switch (phase) {
      case "push":
        return t("setting.preference-section.memore-sync.status-phase-push");
      case "pull":
        return t("setting.preference-section.memore-sync.status-phase-pull");
      case "connection":
      default:
        return t("setting.preference-section.memore-sync.status-phase-connection");
    }
  };

  const formatSyncTime = (rawTime?: string) => {
    if (!rawTime) {
      return t("setting.preference-section.memore-sync.status-never");
    }

    const parsed = new Date(rawTime);
    if (Number.isNaN(parsed.getTime())) {
      return rawTime;
    }

    return parsed.toLocaleString();
  };

  const conflictLogLines = (runtimeStatus.lastPullConflictLogs ?? []).slice(0, 10).map((conflictLog, index) => {
    return t("setting.preference-section.memore-sync.status-conflict-log-line", {
      index: index + 1,
      remote: conflictLog.remoteMemoName,
      local: conflictLog.localMemoName,
      localUpdate: formatSyncTime(conflictLog.localUpdateTime),
      remoteUpdate: formatSyncTime(conflictLog.remoteUpdateTime),
      at: formatSyncTime(conflictLog.recordedAt),
    });
  });

  const conflictLogSummaryLine = `${t("setting.preference-section.memore-sync.status-conflict-log-title")}: ${
    conflictLogLines.length > 0
      ? t("setting.preference-section.memore-sync.status-conflict-log-count", {
          count: runtimeStatus.lastPullConflictLogs?.length ?? 0,
        })
      : t("setting.preference-section.memore-sync.status-summary-none")
  }`;

  const syncStatusSummary = [
    `${t("setting.preference-section.memore-sync.status-last-push")}: ${formatSyncTime(runtimeStatus.lastPushAt)}`,
    `${t("setting.preference-section.memore-sync.status-last-push-summary")}: ${
      runtimeStatus.lastPushSummary
        ? [
            `${t("setting.preference-section.memore-sync.status-summary-total")}=${runtimeStatus.lastPushSummary.totalLocalMemoCount ?? 0}`,
            `${t("setting.preference-section.memore-sync.status-summary-pages")}=${runtimeStatus.lastPushSummary.pushedPages ?? 0}`,
            `${t("setting.preference-section.memore-sync.status-summary-created")}=${runtimeStatus.lastPushSummary.createdCount ?? 0}`,
            `${t("setting.preference-section.memore-sync.status-summary-updated")}=${runtimeStatus.lastPushSummary.updatedCount ?? 0}`,
            `${t("setting.preference-section.memore-sync.status-summary-deleted")}=${runtimeStatus.lastPushSummary.deletedCount ?? 0}`,
            `${t("setting.preference-section.memore-sync.status-summary-skipped")}=${runtimeStatus.lastPushSummary.skippedCount ?? 0}`,
            `${t("setting.preference-section.memore-sync.status-summary-failed")}=${runtimeStatus.lastPushSummary.failedCount ?? 0}`,
          ].join(", ")
        : t("setting.preference-section.memore-sync.status-summary-none")
    }`,
    `${t("setting.preference-section.memore-sync.status-last-pull")}: ${formatSyncTime(runtimeStatus.lastPullAt)}`,
    `${t("setting.preference-section.memore-sync.status-last-pull-summary")}: ${
      runtimeStatus.lastPullSummary
        ? [
            `${t("setting.preference-section.memore-sync.status-summary-total")}=${runtimeStatus.lastPullSummary.totalMemoCount ?? 0}`,
            `${t("setting.preference-section.memore-sync.status-summary-pages")}=${runtimeStatus.lastPullSummary.pulledPages ?? 0}`,
            `${t("setting.preference-section.memore-sync.status-summary-imported")}=${runtimeStatus.lastPullSummary.importedCount ?? 0}`,
            `${t("setting.preference-section.memore-sync.status-summary-updated")}=${runtimeStatus.lastPullSummary.updatedCount ?? 0}`,
            `${t("setting.preference-section.memore-sync.status-summary-deleted")}=${runtimeStatus.lastPullSummary.deletedCount ?? 0}`,
            `${t("setting.preference-section.memore-sync.status-summary-conflict")}=${runtimeStatus.lastPullSummary.conflictCount ?? 0}`,
            `${t("setting.preference-section.memore-sync.status-summary-skipped")}=${runtimeStatus.lastPullSummary.skippedCount ?? 0}`,
            `${t("setting.preference-section.memore-sync.status-summary-failed")}=${runtimeStatus.lastPullSummary.failedCount ?? 0}`,
          ].join(", ")
        : t("setting.preference-section.memore-sync.status-summary-none")
    }`,
    `${t("setting.preference-section.memore-sync.status-last-error")}: ${
      runtimeStatus.lastErrorMessage
        ? `${getSyncErrorPhaseLabel(runtimeStatus.lastErrorPhase)} - ${runtimeStatus.lastErrorMessage}`
        : t("setting.preference-section.memore-sync.status-none")
    }`,
    `${t("setting.preference-section.memore-sync.status-background-state")}: ${getBackgroundSyncStateLabel(runtimeStatus.backgroundSyncState)}`,
    `${t("setting.preference-section.memore-sync.status-background-last-attempt")}: ${formatSyncTime(runtimeStatus.backgroundLastAttemptAt)}`,
    `${t("setting.preference-section.memore-sync.status-background-last-success")}: ${formatSyncTime(runtimeStatus.backgroundLastSuccessAt)}`,
    `${t("setting.preference-section.memore-sync.status-background-next-run")}: ${formatSyncTime(runtimeStatus.backgroundNextRunAt)}`,
    `${t("setting.preference-section.memore-sync.status-background-retry-count")}: ${runtimeStatus.backgroundRetryCount ?? 0}`,
    conflictLogSummaryLine,
    ...conflictLogLines,
  ].join("\n");

  const handleClearSyncStatus = () => {
    clearMemoreSyncRuntimeStatus(syncPreferences.remoteServerUrl);
    toast.success(t("setting.preference-section.memore-sync.status-clear-success"));
  };

  const handleExportSyncMetadata = () => {
    const json = exportMemoreSyncMetadata(syncPreferences.remoteServerUrl);
    if (!json) {
      toast.error("导出失败：未配置远端服务器");
      return;
    }
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `memore-sync-metadata-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success("同步元数据已导出");
  };

  const handleImportSyncMetadata = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json";
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        const ok = importMemoreSyncMetadata(syncPreferences.remoteServerUrl, text);
        if (ok) {
          toast.success("同步元数据已导入");
        } else {
          toast.error("导入失败：文件格式无效");
        }
      } catch {
        toast.error("导入失败：读取文件出错");
      }
    };
    input.click();
  };

  const handleResetSyncMetadata = () => {
    const confirmed = window.confirm(
      "确定要重置同步元数据吗？\n\n" +
        "重置后下次同步会将远端所有笔记视为新内容，可能导致重复创建。\n" +
        "仅在同步异常无法恢复时使用此操作。",
    );
    if (!confirmed) return;
    resetMemoreSyncMetadata(syncPreferences.remoteServerUrl);
    toast.success(t("setting.preference-section.memore-sync.status-reset-metadata-success"));
  };

  const handleDryRunSync = async () => {
    if (isPullingRemoteMemos || isPushingLocalMemos) return;

    setIsPullingRemoteMemos(true);
    try {
      const pullResult = await syncMemoreRemoteMemosToLocal({
        serverUrl: syncPreferences.remoteServerUrl,
        accessToken: syncPreferences.remoteAccessToken,
        pageSize: 100,
        maxPages: 20,
        dryRun: true,
        syncPinned: syncPreferences.syncPinned,
        syncArchived: syncPreferences.syncArchived,
      });

      const pushResult = await syncMemoreLocalMemosToRemote({
        serverUrl: syncPreferences.remoteServerUrl,
        accessToken: syncPreferences.remoteAccessToken,
        pageSize: 100,
        maxPages: 20,
        dryRun: true,
        syncPinned: syncPreferences.syncPinned,
        syncArchived: syncPreferences.syncArchived,
      });

      const lines = ["[Dry Run 预览] 以下操作将在实际同步时执行：", ""];
      if (pullResult.ok) {
        lines.push(`Pull: 新增 ${pullResult.importedCount ?? 0} / 更新 ${pullResult.updatedCount ?? 0} / 删除 ${pullResult.deletedCount ?? 0} / 冲突 ${pullResult.conflictCount ?? 0}`);
      } else {
        lines.push(`Pull: 失败 (${pullResult.errorCode})`);
      }
      if (pushResult.ok) {
        lines.push(`Push: 新增 ${pushResult.createdCount ?? 0} / 更新 ${pushResult.updatedCount ?? 0} / 删除 ${pushResult.deletedCount ?? 0}`);
      } else {
        lines.push(`Push: 失败 (${pushResult.errorCode})`);
      }

      toast.success(lines.join("\n"), { duration: 8000 });
    } catch {
      toast.error("Dry Run 执行失败");
    } finally {
      setIsPullingRemoteMemos(false);
    }
  };

  const handlePullRemoteMemos = async () => {
    if (isPullingRemoteMemos) {
      return;
    }

    setIsPullingRemoteMemos(true);

    try {
      const lockedRun = await runMemoreSyncTaskWithLock(syncPreferences.remoteServerUrl, async () =>
        syncMemoreRemoteMemosToLocal({
          serverUrl: syncPreferences.remoteServerUrl,
          accessToken: syncPreferences.remoteAccessToken,
          pageSize: 100,
          maxPages: 20,
          syncPinned: syncPreferences.syncPinned,
          syncArchived: syncPreferences.syncArchived,
        }),
      );

      if (!lockedRun.ok) {
        const msgKey =
          lockedRun.reason === "IN_PROGRESS"
            ? "setting.preference-section.memore-sync.connection-error-sync-in-progress"
            : "setting.preference-section.memore-sync.connection-error-sync-locked";
        toast.error(t(msgKey));
        return;
      }

      const result = lockedRun.value;

      if (result.ok) {
        if ((result.importedCount ?? 0) > 0 || (result.updatedCount ?? 0) > 0 || (result.deletedCount ?? 0) > 0) {
          await Promise.all([
            queryClient.invalidateQueries({ queryKey: memoKeys.lists() }),
            queryClient.invalidateQueries({ queryKey: userKeys.stats() }),
          ]);
        }

        toast.success(
          t("setting.preference-section.memore-sync.pull-remote-import-success", {
            total: result.totalMemoCount ?? 0,
            pages: result.pulledPages ?? 0,
            imported: result.importedCount ?? 0,
            updated: result.updatedCount ?? 0,
            deleted: result.deletedCount ?? 0,
            conflict: result.conflictCount ?? 0,
            skipped: result.skippedCount ?? 0,
            failed: result.failedCount ?? 0,
          }),
        );
        return;
      }

      const fallbackMessage = getSyncConnectionErrorMessage(result.errorCode);
      if (result.serverMessage) {
        toast.error(`${fallbackMessage} (${result.serverMessage})`);
      } else {
        toast.error(fallbackMessage);
      }
    } catch {
      toast.error(t("setting.preference-section.memore-sync.connection-error-network"));
    } finally {
      setIsPullingRemoteMemos(false);
    }
  };

  const handlePushLocalMemos = async () => {
    if (isPushingLocalMemos) {
      return;
    }

    setIsPushingLocalMemos(true);

    try {
      const lockedRun = await runMemoreSyncTaskWithLock(syncPreferences.remoteServerUrl, async () =>
        syncMemoreLocalMemosToRemote({
          serverUrl: syncPreferences.remoteServerUrl,
          accessToken: syncPreferences.remoteAccessToken,
          pageSize: 100,
          maxPages: 20,
          syncPinned: syncPreferences.syncPinned,
          syncArchived: syncPreferences.syncArchived,
        }),
      );

      if (!lockedRun.ok) {
        const msgKey =
          lockedRun.reason === "IN_PROGRESS"
            ? "setting.preference-section.memore-sync.connection-error-sync-in-progress"
            : "setting.preference-section.memore-sync.connection-error-sync-locked";
        toast.error(t(msgKey));
        return;
      }

      const result = lockedRun.value;

      if (result.ok) {
        toast.success(
          t("setting.preference-section.memore-sync.push-local-success", {
            total: result.totalLocalMemoCount ?? 0,
            pages: result.pushedPages ?? 0,
            created: result.createdCount ?? 0,
            updated: result.updatedCount ?? 0,
            deleted: result.deletedCount ?? 0,
            skipped: result.skippedCount ?? 0,
            failed: result.failedCount ?? 0,
          }),
        );
        return;
      }

      const fallbackMessage = getSyncConnectionErrorMessage(result.errorCode);
      if (result.serverMessage) {
        toast.error(`${fallbackMessage} (${result.serverMessage})`);
      } else {
        toast.error(fallbackMessage);
      }
    } catch {
      toast.error(t("setting.preference-section.memore-sync.connection-error-network"));
    } finally {
      setIsPushingLocalMemos(false);
    }
  };

  const handleTestSyncConnection = async () => {
    if (isTestingSyncConnection) {
      return;
    }

    setIsTestingSyncConnection(true);

    try {
      const result = await testMemoreRemoteConnection({
        serverUrl: syncPreferences.remoteServerUrl,
        accessToken: syncPreferences.remoteAccessToken,
      });

      if (result.ok) {
        toast.success(
          t("setting.preference-section.memore-sync.connection-test-success", {
            username: result.username ?? result.userResourceName ?? "unknown",
          }),
        );
        return;
      }

      const fallbackMessage = getSyncConnectionErrorMessage(result.errorCode);
      if (result.serverMessage) {
        toast.error(`${fallbackMessage} (${result.serverMessage})`);
      } else {
        toast.error(fallbackMessage);
      }
    } catch {
      toast.error(t("setting.preference-section.memore-sync.connection-error-network"));
    } finally {
      setIsTestingSyncConnection(false);
    }
  };

  const handleLocaleSelectChange = async (locale: Locale) => {
    // 立即应用语言，提供即时 UI 反馈并写入 localStorage
    loadLocale(locale);
    // 持久化到用户设置
    updateUserGeneralSetting(
      { generalSetting: { locale }, updateMask: ["locale"] },
      {
        onSuccess: () => {
          refetchSettings();
        },
      },
    );
  };

  const handleDefaultMemoVisibilityChanged = (value: string) => {
    updateUserGeneralSetting(
      { generalSetting: { memoVisibility: value }, updateMask: ["memo_visibility"] },
      {
        onSuccess: () => {
          refetchSettings();
        },
      },
    );
  };

  const handleThemeChange = async (theme: string) => {
    // 立即应用主题，提供即时 UI 反馈
    loadTheme(theme);
    // 持久化到用户设置
    updateUserGeneralSetting(
      { generalSetting: { theme }, updateMask: ["theme"] },
      {
        onSuccess: () => {
          refetchSettings();
        },
      },
    );
  };

  // 设置尚未加载时提供默认值
  const setting: UserSetting_GeneralSetting =
    generalSetting ||
    create(UserSetting_GeneralSettingSchema, {
      locale: "en",
      memoVisibility: "PRIVATE",
      theme: "system",
    });

  return (
    <SettingSection>
      <SettingGroup title={t("setting.account-section.title")}>
        <div className="w-full flex flex-row justify-start items-center gap-3">
          <UserAvatar className="shrink-0 w-10 h-10" avatarUrl={currentUser?.avatarUrl} />
          <div className="flex-1 min-w-0 flex flex-col justify-center items-start">
            <div className="w-full">
              <span className="text-base font-semibold">{currentUser?.displayName}</span>
              <span className="ml-2 text-sm text-muted-foreground">@{currentUser?.username}</span>
            </div>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <Button variant="outline" size="sm" onClick={() => accountDialog.open()}>
              <PenLineIcon className="w-3.5 h-3.5 mr-1" />
              {t("common.edit")}
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm">
                  <MoreVerticalIcon className="w-3.5 h-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => passwordDialog.open()}>{t("setting.account-section.change-password")}</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </SettingGroup>

      <SettingGroup title={t("common.basic")} showSeparator>
        <SettingRow label={t("common.language")}>
          <LocaleSelect value={setting.locale} onChange={handleLocaleSelectChange} />
        </SettingRow>

        <SettingRow label={t("setting.preference-section.theme")}>
          <ThemeSelect value={setting.theme} onValueChange={handleThemeChange} />
        </SettingRow>

        <SettingRow
          label={t("setting.preference-section.custom-font")}
          description={t("setting.preference-section.custom-font-description")}
        >
          <div className="flex items-center gap-2">
            <Input
              className="w-48 font-mono text-sm"
              value={preferences.customFontFamily}
              placeholder={t("setting.preference-section.custom-font-placeholder")}
              onChange={(event) => updatePreferences({ customFontFamily: event.target.value })}
            />
            {preferences.customFontFamily.trim() && (
              <Button variant="ghost" size="sm" onClick={() => updatePreferences({ customFontFamily: "" })}>
                {t("common.reset")}
              </Button>
            )}
          </div>
        </SettingRow>
      </SettingGroup>

      <SettingGroup title={t("setting.preference")} showSeparator>
        <SettingRow label={t("setting.preference-section.default-memo-visibility")}>
          <Select value={setting.memoVisibility || "PRIVATE"} onValueChange={handleDefaultMemoVisibilityChanged}>
            <SelectTrigger className="min-w-fit">
              <div className="flex items-center gap-2">
                <VisibilityIcon visibility={convertVisibilityFromString(setting.memoVisibility)} />
                <SelectValue />
              </div>
            </SelectTrigger>
            <SelectContent>
              {[Visibility.PRIVATE, Visibility.PROTECTED, Visibility.PUBLIC]
                .map((v) => convertVisibilityToString(v))
                .map((item) => (
                  <SelectItem key={item} value={item} className="whitespace-nowrap">
                    {t(`memo.visibility.${item.toLowerCase() as Lowercase<typeof item>}`)}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
        </SettingRow>
      </SettingGroup>

      <SettingGroup title={t("setting.preference-section.memore-editor.title")} showSeparator>
        <SettingRow label={t("setting.preference-section.memore-editor.enable-double-click-edit")}>
          <Switch
            checked={preferences.enableDoubleClickEdit}
            onCheckedChange={(checked: boolean) => updatePreferences({ enableDoubleClickEdit: checked })}
          />
        </SettingRow>

        <SettingRow
          label={t("setting.preference-section.memore-editor.enable-vditor-focus-mode")}
          description={t("setting.preference-section.memore-editor.enable-vditor-focus-mode-description")}
        >
          <Switch
            checked={preferences.enableVditorFocusMode}
            onCheckedChange={(checked: boolean) => updatePreferences({ enableVditorFocusMode: checked })}
          />
        </SettingRow>

        <SettingRow
          label={t("setting.preference-section.memore-editor.enable-enhanced-edit-mode")}
          description={t("setting.preference-section.memore-editor.enable-enhanced-edit-mode-description")}
        >
          <Switch
            checked={preferences.enableEnhancedEditMode}
            onCheckedChange={(checked: boolean) => updatePreferences({ enableEnhancedEditMode: checked })}
          />
        </SettingRow>

        <SettingRow
          label={t("setting.preference-section.memore-editor.focus-draft-save")}
          description={t("setting.preference-section.memore-editor.focus-draft-save-description")}
        >
          <Switch
            checked={preferences.focusModeDraftSaveEnabled}
            onCheckedChange={(checked: boolean) => updatePreferences({ focusModeDraftSaveEnabled: checked })}
          />
        </SettingRow>

        <SettingRow
          label={t("setting.preference-section.memore-editor.focus-draft-restore")}
          description={t("setting.preference-section.memore-editor.focus-draft-restore-description")}
        >
          <Switch
            checked={preferences.focusModeDraftRestoreEnabled}
            onCheckedChange={(checked: boolean) => updatePreferences({ focusModeDraftRestoreEnabled: checked })}
          />
        </SettingRow>

        <SettingRow
          label={t("setting.preference-section.memore-editor.edit-draft-save")}
          description={t("setting.preference-section.memore-editor.edit-draft-save-description")}
        >
          <Switch
            checked={preferences.editModeDraftSaveEnabled}
            onCheckedChange={(checked: boolean) => updatePreferences({ editModeDraftSaveEnabled: checked })}
          />
        </SettingRow>
      </SettingGroup>

      <SettingGroup title={t("setting.preference-section.memore-sync.title")} showSeparator>
        <SettingRow
          label={t("setting.preference-section.memore-sync.enable-remote-sync")}
          description={t("setting.preference-section.memore-sync.enable-remote-sync-description")}
        >
          <Switch
            checked={syncPreferences.enableRemoteSync}
            onCheckedChange={(checked: boolean) => updateSyncPreferences({ enableRemoteSync: checked })}
          />
        </SettingRow>

        <SettingRow
          vertical
          label={t("setting.preference-section.memore-sync.remote-server-url")}
          description={t("setting.preference-section.memore-sync.remote-server-url-description")}
        >
          <Input
            className="w-full md:w-[28rem] font-mono"
            value={syncPreferences.remoteServerUrl}
            placeholder={t("setting.preference-section.memore-sync.remote-server-url-placeholder")}
            onChange={(event) => updateSyncPreferences({ remoteServerUrl: event.target.value })}
          />
        </SettingRow>

        <SettingRow
          vertical
          label={t("setting.preference-section.memore-sync.access-token")}
          description={t("setting.preference-section.memore-sync.access-token-description")}
        >
          <Input
            className="w-full md:w-[28rem] font-mono"
            type="password"
            autoComplete="off"
            value={syncPreferences.remoteAccessToken}
            placeholder={t("setting.preference-section.memore-sync.access-token-placeholder")}
            onChange={(event) => updateSyncPreferences({ remoteAccessToken: event.target.value })}
          />
        </SettingRow>

        <SettingRow
          label={t("setting.preference-section.memore-sync.auto-sync-on-startup")}
          description={t("setting.preference-section.memore-sync.auto-sync-on-startup-description")}
        >
          <Switch
            checked={syncPreferences.autoSyncOnStartup}
            onCheckedChange={(checked: boolean) => updateSyncPreferences({ autoSyncOnStartup: checked })}
          />
        </SettingRow>

        <SettingRow
          label={t("setting.preference-section.memore-sync.sync-pinned")}
          description={t("setting.preference-section.memore-sync.sync-pinned-description")}
        >
          <Switch
            checked={syncPreferences.syncPinned}
            onCheckedChange={(checked: boolean) => updateSyncPreferences({ syncPinned: checked })}
          />
        </SettingRow>

        <SettingRow
          label={t("setting.preference-section.memore-sync.sync-archived")}
          description={t("setting.preference-section.memore-sync.sync-archived-description")}
        >
          <Switch
            checked={syncPreferences.syncArchived}
            onCheckedChange={(checked: boolean) => updateSyncPreferences({ syncArchived: checked })}
          />
        </SettingRow>

        <SettingRow
          vertical
          label={t("setting.preference-section.memore-sync.status-title")}
          description={t("setting.preference-section.memore-sync.status-description")}
        >
          <div className="w-full md:w-[28rem] whitespace-pre-wrap rounded-md border bg-muted/30 p-3 text-xs font-mono leading-5">
            {syncStatusSummary}
          </div>
        </SettingRow>

        <SettingRow
          label={t("setting.preference-section.memore-sync.status-clear")}
          description={t("setting.preference-section.memore-sync.status-clear-description")}
        >
          <Button variant="outline" onClick={handleClearSyncStatus} disabled={!syncPreferences.remoteServerUrl.trim()}>
            {t("setting.preference-section.memore-sync.status-clear")}
          </Button>
        </SettingRow>

        <SettingRow
          label={t("setting.preference-section.memore-sync.status-reset-metadata")}
          description={t("setting.preference-section.memore-sync.status-reset-metadata-description")}
        >
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={handleExportSyncMetadata}
              disabled={!syncPreferences.remoteServerUrl.trim()}
            >
              导出
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={handleImportSyncMetadata}
              disabled={!syncPreferences.remoteServerUrl.trim()}
            >
              导入
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={handleResetSyncMetadata}
              disabled={isPushingLocalMemos || isPullingRemoteMemos || isTestingSyncConnection || !syncPreferences.remoteServerUrl.trim()}
            >
              {t("setting.preference-section.memore-sync.status-reset-metadata")}
            </Button>
          </div>
        </SettingRow>

        <SettingRow
          label={t("setting.preference-section.memore-sync.test-connection")}
          description={t("setting.preference-section.memore-sync.test-connection-description")}
        >
          <Button
            variant="outline"
            onClick={handleTestSyncConnection}
            disabled={isTestingSyncConnection || !syncPreferences.remoteServerUrl.trim() || !syncPreferences.remoteAccessToken.trim()}
          >
            {isTestingSyncConnection && <LoaderIcon className="h-4 w-4 animate-spin" />}
            {t("setting.preference-section.memore-sync.test-connection")}
          </Button>
        </SettingRow>

        <SettingRow
          label={t("setting.preference-section.memore-sync.push-local")}
          description={t("setting.preference-section.memore-sync.push-local-description")}
        >
          <Button
            variant="outline"
            onClick={handlePushLocalMemos}
            disabled={
              isPushingLocalMemos ||
              isPullingRemoteMemos ||
              isTestingSyncConnection ||
              !syncPreferences.enableRemoteSync ||
              !syncPreferences.remoteServerUrl.trim() ||
              !syncPreferences.remoteAccessToken.trim()
            }
          >
            {isPushingLocalMemos && <LoaderIcon className="h-4 w-4 animate-spin" />}
            {t("setting.preference-section.memore-sync.push-local")}
          </Button>
        </SettingRow>

        <SettingRow
          label={t("setting.preference-section.memore-sync.pull-remote")}
          description={t("setting.preference-section.memore-sync.pull-remote-description")}
        >
          <Button
            variant="outline"
            onClick={handlePullRemoteMemos}
            disabled={
              isPushingLocalMemos ||
              isPullingRemoteMemos ||
              isTestingSyncConnection ||
              !syncPreferences.enableRemoteSync ||
              !syncPreferences.remoteServerUrl.trim() ||
              !syncPreferences.remoteAccessToken.trim()
            }
          >
            {isPullingRemoteMemos && <LoaderIcon className="h-4 w-4 animate-spin" />}
            {t("setting.preference-section.memore-sync.pull-remote")}
          </Button>
        </SettingRow>

        <SettingRow label="Dry Run 预览" description="预览同步将执行的操作（不实际修改任何数据）">
          <Button
            variant="outline"
            onClick={handleDryRunSync}
            disabled={
              isPushingLocalMemos ||
              isPullingRemoteMemos ||
              isTestingSyncConnection ||
              !syncPreferences.enableRemoteSync ||
              !syncPreferences.remoteServerUrl.trim() ||
              !syncPreferences.remoteAccessToken.trim()
            }
          >
            Dry Run 预览
          </Button>
        </SettingRow>
      </SettingGroup>

      <SettingGroup showSeparator>
        <WebhookSection />
      </SettingGroup>

      <UpdateAccountDialog open={accountDialog.isOpen} onOpenChange={accountDialog.setOpen} />
      <ChangeMemberPasswordDialog open={passwordDialog.isOpen} onOpenChange={passwordDialog.setOpen} user={currentUser} />
    </SettingSection>
  );
};

export default PreferencesSection;
