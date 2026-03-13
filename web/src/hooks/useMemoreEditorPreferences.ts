import { useCallback, useEffect, useMemo, useState } from "react";

const MEMORE_EDITOR_PREFERENCES_STORAGE_KEY = "memore-editor-preferences";
const MEMORE_EDITOR_PREFERENCES_EVENT = "memore-editor-preferences-updated";

export interface MemoreEditorPreferences {
  enableVditorFocusMode: boolean;
  enableEnhancedEditMode: boolean;
  enableDoubleClickEdit: boolean;
  focusModeDraftSaveEnabled: boolean;
  focusModeDraftRestoreEnabled: boolean;
  editModeDraftSaveEnabled: boolean;
  customFontFamily: string;
}

const DEFAULT_MEMORE_EDITOR_PREFERENCES: MemoreEditorPreferences = {
  enableVditorFocusMode: true,
  enableEnhancedEditMode: true,
  enableDoubleClickEdit: true,
  focusModeDraftSaveEnabled: true,
  focusModeDraftRestoreEnabled: true,
  editModeDraftSaveEnabled: false,
  customFontFamily: "",
};

const parsePreferences = (rawValue: string | null): MemoreEditorPreferences => {
  if (!rawValue) {
    return DEFAULT_MEMORE_EDITOR_PREFERENCES;
  }

  try {
    const parsed = JSON.parse(rawValue) as Partial<MemoreEditorPreferences>;
    return {
      enableVditorFocusMode: parsed.enableVditorFocusMode ?? DEFAULT_MEMORE_EDITOR_PREFERENCES.enableVditorFocusMode,
      enableEnhancedEditMode: parsed.enableEnhancedEditMode ?? DEFAULT_MEMORE_EDITOR_PREFERENCES.enableEnhancedEditMode,
      enableDoubleClickEdit: parsed.enableDoubleClickEdit ?? DEFAULT_MEMORE_EDITOR_PREFERENCES.enableDoubleClickEdit,
      focusModeDraftSaveEnabled: parsed.focusModeDraftSaveEnabled ?? DEFAULT_MEMORE_EDITOR_PREFERENCES.focusModeDraftSaveEnabled,
      focusModeDraftRestoreEnabled: parsed.focusModeDraftRestoreEnabled ?? DEFAULT_MEMORE_EDITOR_PREFERENCES.focusModeDraftRestoreEnabled,
      editModeDraftSaveEnabled: parsed.editModeDraftSaveEnabled ?? DEFAULT_MEMORE_EDITOR_PREFERENCES.editModeDraftSaveEnabled,
      customFontFamily: parsed.customFontFamily ?? DEFAULT_MEMORE_EDITOR_PREFERENCES.customFontFamily,
    };
  } catch {
    return DEFAULT_MEMORE_EDITOR_PREFERENCES;
  }
};

export const getMemoreEditorPreferences = (): MemoreEditorPreferences => {
  try {
    return parsePreferences(localStorage.getItem(MEMORE_EDITOR_PREFERENCES_STORAGE_KEY));
  } catch {
    return DEFAULT_MEMORE_EDITOR_PREFERENCES;
  }
};

const persistMemoreEditorPreferences = (preferences: MemoreEditorPreferences) => {
  try {
    localStorage.setItem(MEMORE_EDITOR_PREFERENCES_STORAGE_KEY, JSON.stringify(preferences));
  } catch {
    // 忽略 localStorage 异常（隐私模式、配额超限等）
  }

  window.dispatchEvent(
    new CustomEvent<MemoreEditorPreferences>(MEMORE_EDITOR_PREFERENCES_EVENT, {
      detail: preferences,
    }),
  );
};

/**
 * 将自定义字体应用到全局 DOM。空字符串表示恢复默认字体。
 */
const applyCustomFont = (fontFamily: string) => {
  const root = document.documentElement;
  if (fontFamily.trim()) {
    root.style.setProperty("--memore-custom-font", fontFamily);
    root.style.fontFamily = `${fontFamily}, var(--font-sans, sans-serif)`;
  } else {
    root.style.removeProperty("--memore-custom-font");
    root.style.removeProperty("font-family");
  }
};

export const useMemoreEditorPreferences = () => {
  const [preferences, setPreferences] = useState<MemoreEditorPreferences>(() => getMemoreEditorPreferences());

  useEffect(() => {
    applyCustomFont(preferences.customFontFamily);
  }, [preferences.customFontFamily]);

  useEffect(() => {
    const handlePreferencesUpdated = (event: Event) => {
      const customEvent = event as CustomEvent<MemoreEditorPreferences>;
      if (customEvent.detail) {
        setPreferences(customEvent.detail);
        return;
      }

      setPreferences(getMemoreEditorPreferences());
    };

    const handleStorageChanged = (event: StorageEvent) => {
      if (event.key !== MEMORE_EDITOR_PREFERENCES_STORAGE_KEY) {
        return;
      }

      setPreferences(getMemoreEditorPreferences());
    };

    window.addEventListener(MEMORE_EDITOR_PREFERENCES_EVENT, handlePreferencesUpdated as EventListener);
    window.addEventListener("storage", handleStorageChanged);

    return () => {
      window.removeEventListener(MEMORE_EDITOR_PREFERENCES_EVENT, handlePreferencesUpdated as EventListener);
      window.removeEventListener("storage", handleStorageChanged);
    };
  }, []);

  const updatePreferences = useCallback((partial: Partial<MemoreEditorPreferences>) => {
    setPreferences((previous: MemoreEditorPreferences) => {
      const next = {
        ...previous,
        ...partial,
      };
      persistMemoreEditorPreferences(next);
      return next;
    });
  }, []);

  const resetPreferences = useCallback(() => {
    setPreferences(DEFAULT_MEMORE_EDITOR_PREFERENCES);
    persistMemoreEditorPreferences(DEFAULT_MEMORE_EDITOR_PREFERENCES);
  }, []);

  return useMemo(
    () => ({
      preferences,
      updatePreferences,
      resetPreferences,
    }),
    [preferences, resetPreferences, updatePreferences],
  );
};
