import { useCallback } from "react";
import { useMemoreEditorPreferences } from "@/hooks/useMemoreEditorPreferences";
import useNavigateTo from "@/hooks/useNavigateTo";

interface UseMemoHandlersOptions {
  memoName: string;
  parentPage: string;
  readonly: boolean;
  openEditor: () => void;
  openEditorInFocusMode: () => void;
  openPreview: (url: string) => void;
}

export const useMemoHandlers = (options: UseMemoHandlersOptions) => {
  const { memoName, parentPage, readonly, openEditorInFocusMode, openPreview } = options;
  const navigateTo = useNavigateTo();
  const { preferences } = useMemoreEditorPreferences();

  const handleGotoMemoDetailPage = useCallback(() => {
    navigateTo(`/${memoName}`, { state: { from: parentPage } });
  }, [memoName, parentPage, navigateTo]);

  const handleMemoContentClick = useCallback(
    (e: React.MouseEvent) => {
      const targetEl = e.target as HTMLElement;
      if (targetEl.tagName === "IMG") {
        const linkElement = targetEl.closest("a");
        if (linkElement) return;
        const imgUrl = targetEl.getAttribute("src");
        if (imgUrl) openPreview(imgUrl);
      }
    },
    [openPreview],
  );

  const handleMemoContentDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      if (readonly || !preferences.enableDoubleClickEdit) return;
      e.preventDefault();
      openEditorInFocusMode();
    },
    [readonly, openEditorInFocusMode, preferences.enableDoubleClickEdit],
  );

  return { handleGotoMemoDetailPage, handleMemoContentClick, handleMemoContentDoubleClick };
};
