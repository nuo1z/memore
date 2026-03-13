import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "react-hot-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/contexts/AuthContext";
import useCurrentUser from "@/hooks/useCurrentUser";
import { memoKeys } from "@/hooks/useMemoQueries";
import { useMemoreEditorPreferences } from "@/hooks/useMemoreEditorPreferences";
import { userKeys, useTagCounts } from "@/hooks/useUserQueries";
import { handleError } from "@/lib/error";
import { cn } from "@/lib/utils";
import { useTranslate } from "@/utils/i18n";
import { Visibility } from "@/types/proto/api/v1/memo_service_pb";
import { convertVisibilityFromString } from "@/utils/memo";
import {
  EditorContent,
  EditorMetadata,
  EditorToolbar,
  FocusModeOverlay,
  TimestampPopover,
  VditorFocusEditor,
} from "./components";
import { FOCUS_MODE_STYLES } from "./constants";
import type { EditorRefActions } from "./Editor";
import { useAutoSave, useFocusMode, useKeyboard, useMemoInit } from "./hooks";
import { cacheService, errorService, memoService, validationService } from "./services";
import { EditorProvider, useEditorContext } from "./state";
import type { MemoEditorProps } from "./types";

const MemoEditor = (props: MemoEditorProps) => (
  <EditorProvider>
    <MemoEditorImpl {...props} />
  </EditorProvider>
);

const MemoEditorImpl: React.FC<MemoEditorProps> = ({
  className,
  cacheKey,
  memo,
  parentMemoName,
  autoFocus,
  initialFocusMode = false,
  enableEnhancedFocusMode,
  enableFocusModeByDoubleClick = true,
  enableDraftSave,
  enableDraftRestore,
  placeholder,
  onConfirm,
  onCancel,
}) => {
  const t = useTranslate();
  const queryClient = useQueryClient();
  const currentUser = useCurrentUser();
  const editorRef = useRef<EditorRefActions>(null);
  const { state, actions, dispatch } = useEditorContext();
  const { userGeneralSetting } = useAuth();
  const { preferences } = useMemoreEditorPreferences();
  const { data: tagCount = {} } = useTagCounts(true);
  const [customTagInput, setCustomTagInput] = useState("");
  const [isExiting, setIsExiting] = useState(false);
  const exitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (exitTimerRef.current) clearTimeout(exitTimerRef.current);
    };
  }, []);

  const memoName = memo?.name;
  const isEditingExistingMemo = !!memoName;
  const canUseEnhancedFocusMode =
    (enableEnhancedFocusMode ?? preferences.enableVditorFocusMode) && (!isEditingExistingMemo || preferences.enableEnhancedEditMode);
  const shouldPersistDraft =
    enableDraftSave ?? (isEditingExistingMemo ? preferences.editModeDraftSaveEnabled : preferences.focusModeDraftSaveEnabled);
  const shouldRestoreDraft = enableDraftRestore ?? (isEditingExistingMemo ? false : preferences.focusModeDraftRestoreEnabled);

  // 从用户设置中读取默认可见性，Memore 本地模式下默认为 PRIVATE
  const defaultVisibility = userGeneralSetting?.memoVisibility
    ? convertVisibilityFromString(userGeneralSetting.memoVisibility)
    : Visibility.PRIVATE;

  useMemoInit({
    editorRef,
    memo,
    cacheKey,
    username: currentUser?.name ?? "",
    autoFocus,
    defaultVisibility,
    initialFocusMode: initialFocusMode && (!isEditingExistingMemo || canUseEnhancedFocusMode),
    enableDraftRestore: shouldRestoreDraft,
  });

  // 当启用草稿持久化时，自动将内容保存到 localStorage
  useAutoSave(state.content, currentUser?.name ?? "", cacheKey, shouldPersistDraft);

  // 管理聚焦模式下的页面滚动锁定
  useFocusMode(state.ui.isFocusMode);

  const handleToggleFocusMode = useCallback(() => {
    const nextFocusMode = !state.ui.isFocusMode;

    if (nextFocusMode) {
      if (exitTimerRef.current) {
        clearTimeout(exitTimerRef.current);
        exitTimerRef.current = null;
      }
      setIsExiting(false);
      dispatch(actions.setFocusMode(true));
      return;
    }

    // 退出聚焦模式——先播放退出动画再执行实际操作
    setIsExiting(true);
    exitTimerRef.current = setTimeout(() => {
      setIsExiting(false);
      exitTimerRef.current = null;

      if (isEditingExistingMemo) {
        cacheService.clear(cacheService.key(currentUser?.name ?? "", cacheKey));
        onCancel?.();
        return;
      }

      const cacheStorageKey = cacheService.key(currentUser?.name ?? "", cacheKey);
      if (shouldPersistDraft) {
        cacheService.saveNow(cacheStorageKey, state.content);
      } else {
        cacheService.clear(cacheStorageKey);
      }

      dispatch(actions.setFocusMode(false));
    }, 200);
  }, [actions, cacheKey, currentUser?.name, dispatch, isEditingExistingMemo, onCancel, shouldPersistDraft, state.content, state.ui.isFocusMode]);

  const handleRequestFocusMode = useCallback(() => {
    if (!enableFocusModeByDoubleClick || state.ui.isFocusMode) {
      return;
    }

    dispatch(actions.setFocusMode(true));
  }, [actions, dispatch, enableFocusModeByDoubleClick, state.ui.isFocusMode]);

  const handleVditorContentChange = useCallback(
    (content: string) => {
      dispatch(actions.updateContent(content));
    },
    [actions, dispatch],
  );

  const normalizedCurrentTags = useMemo(() => {
    return new Set(Array.from(state.content.matchAll(/(^|\s)#([\w\u4e00-\u9fa5/-]+)/g), (match) => match[2].toLowerCase()));
  }, [state.content]);

  const suggestedTags = useMemo(() => {
    return Object.entries(tagCount)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([tag]) => tag)
      .filter((tag) => !!tag && !normalizedCurrentTags.has(tag.toLowerCase()))
      .slice(0, 12);
  }, [tagCount, normalizedCurrentTags]);

  const appendTagToContent = useCallback(
    (rawTag: string) => {
      const sanitizedTag = rawTag
        .trim()
        .replace(/^#+/, "")
        .replace(/\s+/g, "-")
        .replace(/^-+|-+$/g, "");
      if (!sanitizedTag) {
        return;
      }

      if (normalizedCurrentTags.has(sanitizedTag.toLowerCase())) {
        return;
      }

      const separator = state.content.trim().length === 0 ? "" : state.content.endsWith("\n") ? "" : "\n";
      dispatch(actions.updateContent(`${state.content}${separator}#${sanitizedTag} `));
    },
    [actions, dispatch, normalizedCurrentTags, state.content],
  );

  const handleCreateTag = useCallback(() => {
    appendTagToContent(customTagInput);
    setCustomTagInput("");
  }, [appendTagToContent, customTagInput]);

  useKeyboard(editorRef, {
    onSave: handleSave,
    enabled: !(state.ui.isFocusMode && canUseEnhancedFocusMode),
  });

  async function handleSave() {
    // 保存前先校验
    const { valid, reason } = validationService.canSave(state);
    if (!valid) {
      toast.error(reason || "Cannot save");
      return;
    }

    dispatch(actions.setLoading("saving", true));

    try {
      const result = await memoService.save(state, { memoName, parentMemoName });

      if (!result.hasChanges) {
        toast.error(t("editor.no-changes-detected"));
        onCancel?.();
        return;
      }

      // 保存成功后清理 localStorage 草稿缓存
      cacheService.clear(cacheService.key(currentUser?.name ?? "", cacheKey));

      // 失效 React Query 缓存，触发全局 memo 列表刷新
      const invalidationPromises = [
        queryClient.invalidateQueries({ queryKey: memoKeys.lists() }),
        queryClient.invalidateQueries({ queryKey: userKeys.stats() }),
      ];

      // 避免 memo 详情页在编辑后继续使用陈旧缓存
      if (memoName) {
        invalidationPromises.push(queryClient.invalidateQueries({ queryKey: memoKeys.detail(memoName) }));
      }

      // 如果当前保存的是评论，同时失效父 memo 的评论查询
      if (parentMemoName) {
        invalidationPromises.push(queryClient.invalidateQueries({ queryKey: memoKeys.comments(parentMemoName) }));
      }

      await Promise.all(invalidationPromises);

      // 重置编辑器状态到初始值
      dispatch(actions.reset());
      if (!memoName && defaultVisibility) {
        dispatch(actions.setMetadata({ visibility: defaultVisibility }));
      }

      // 通知父组件保存成功
      onConfirm?.(result.memoName);
    } catch (error) {
      handleError(error, toast.error, {
        context: "Failed to save memo",
        fallbackMessage: errorService.getErrorMessage(error),
      });
    } finally {
      dispatch(actions.setLoading("saving", false));
    }
  }

  return (
    <>
      <FocusModeOverlay isActive={state.ui.isFocusMode} isExiting={isExiting} onToggle={handleToggleFocusMode} />

      <div
        className={cn(
          "group relative w-full flex flex-col justify-between items-start bg-card px-4 pt-3 pb-1 rounded-lg border border-border gap-2",
          FOCUS_MODE_STYLES.transition,
          state.ui.isFocusMode && cn(FOCUS_MODE_STYLES.container.base, FOCUS_MODE_STYLES.container.spacing),
          state.ui.isFocusMode && !isExiting && "animate-[focus-editor-enter_200ms_ease-out]",
          state.ui.isFocusMode && isExiting && "animate-[focus-editor-exit_200ms_ease-out_forwards]",
          className,
        )}
      >
        {memoName && (
          <div className="w-full -mb-1">
            <TimestampPopover />
          </div>
        )}

        {/*
          聚焦模式下且启用增强能力时切换到 Vditor。
          非聚焦模式仍保持原始 Memos textarea 编辑器。
        */}
        {state.ui.isFocusMode && canUseEnhancedFocusMode ? (
          <div className="w-full h-full flex flex-col flex-1 min-h-0 gap-2">
            <VditorFocusEditor
              value={state.content}
              placeholder={placeholder}
              autoFocus={autoFocus}
              onChange={handleVditorContentChange}
              onSave={handleSave}
              className="flex-1 min-h-0"
            />

            <div className="w-full flex flex-row items-center gap-1 flex-wrap px-1 py-1">
              <span className="text-xs text-muted-foreground shrink-0 mr-0.5">{t("common.tags")}:</span>
              {suggestedTags.map((tag) => (
                <Button
                  key={tag}
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-6 px-1.5 text-xs shrink-0"
                  onClick={() => appendTagToContent(tag)}
                >
                  #{tag}
                </Button>
              ))}
              <Input
                className="h-6 w-20 sm:w-24 px-1.5 text-xs shrink-0"
                value={customTagInput}
                onChange={(event) => setCustomTagInput(event.target.value)}
                placeholder="#new"
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    handleCreateTag();
                  }
                }}
              />
              <Button type="button" variant="outline" size="sm" className="h-6 px-1.5 text-xs shrink-0" onClick={handleCreateTag}>
                +
              </Button>
            </div>
          </div>
        ) : (
          <EditorContent ref={editorRef} placeholder={placeholder} autoFocus={autoFocus} onRequestFocusMode={handleRequestFocusMode} />
        )}

        {/* 底部区域统一展示元数据与工具栏 */}
        <div className="w-full flex flex-col gap-2">
          <EditorMetadata memoName={memoName} />
          <EditorToolbar onSave={handleSave} onCancel={onCancel} memoName={memoName} showSyncButton={!memoName && !parentMemoName} />
        </div>
      </div>
    </>
  );
};

export default MemoEditor;
