import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import "vditor/dist/index.css";

interface VditorFocusEditorProps {
  value: string;
  placeholder?: string;
  autoFocus?: boolean;
  onChange: (value: string) => void;
  onSave?: () => void;
  className?: string;
}

interface VditorInstance {
  getValue: () => string;
  setValue: (value: string) => void;
  focus: () => void;
  destroy: () => void;
  setTheme?: (theme: "dark" | "classic", contentTheme?: string, codeTheme?: string) => void;
}

type VditorConstructor = new (element: HTMLElement, options: Record<string, unknown>) => VditorInstance;

const resolveVditorTheme = (): "dark" | "classic" => {
  const theme = document.documentElement.getAttribute("data-theme");
  return theme === "default-dark" ? "dark" : "classic";
};

const resolveVditorContentTheme = (): string => {
  return resolveVditorTheme() === "dark" ? "dark" : "light";
};

const isAndroidCapacitorRuntime = (): boolean => {
  return document.documentElement.classList.contains("mobile-capacitor-android");
};

export const VditorFocusEditor = ({ value, placeholder, autoFocus, onChange, onSave, className }: VditorFocusEditorProps) => {
  const editorContainerRef = useRef<HTMLDivElement | null>(null);
  const vditorRef = useRef<VditorInstance | null>(null);
  const syncingFromExternalValueRef = useRef(false);
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    onSaveRef.current = onSave;
  }, [onSave]);

  useEffect(() => {
    let cancelled = false;

    const initializeVditor = async () => {
      if (!editorContainerRef.current) {
        return;
      }

      const module = await import("vditor");
      if (cancelled || !editorContainerRef.current) {
        return;
      }

      const Vditor = module.default as unknown as VditorConstructor;
      const theme = resolveVditorTheme();
      const isAndroid = isAndroidCapacitorRuntime();

      vditorRef.current = new Vditor(editorContainerRef.current, {
        value,
        // 安卓端固定所见即所得；Web/Windows 默认即时渲染（IR）。
        mode: isAndroid ? "wysiwyg" : "ir",
        minHeight: 300,
        height: "100%",
        placeholder: placeholder || "",
        cache: {
          enable: false,
        },
        theme,
        icon: "material",
        preview: {
          mode: "both",
          delay: 120,
          theme: {
            current: resolveVditorContentTheme(),
          },
        },
        toolbar: isAndroid
          ? [
              "headings",
              "bold",
              "italic",
              "strike",
              "quote",
              "line",
              "list",
              "ordered-list",
              "check",
              "outdent",
              "indent",
              "link",
              "table",
              "code",
              "inline-code",
              "undo",
              "redo",
              "fullscreen",
            ]
          : [
              "headings",
              "bold",
              "italic",
              "strike",
              "|",
              "quote",
              "line",
              "list",
              "ordered-list",
              "check",
              "outdent",
              "indent",
              "|",
              "link",
              "table",
              "code",
              "inline-code",
              "|",
              "undo",
              "redo",
              "fullscreen",
              "edit-mode",
            ],
        input(markdown: string) {
          if (syncingFromExternalValueRef.current) {
            return;
          }
          onChangeRef.current(markdown);
        },
        ctrlEnter() {
          onSaveRef.current?.();
        },
        after() {
          if (autoFocus) {
            vditorRef.current?.focus();
          }
        },
      });
    };

    initializeVditor();

    return () => {
      cancelled = true;
      const vditor = vditorRef.current;
      vditorRef.current = null;
      if (!vditor) {
        return;
      }
      try {
        vditor.destroy();
      } catch (error) {
        // Android WebView 下偶发 destroy 时序错误，忽略避免阻断返回流程。
        console.warn("[Memore] Ignore Vditor destroy error:", error);
      }
    };
    // 在聚焦编辑器挂载时仅初始化一次。
    // `value` 的后续变化由下方专用 effect 同步。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoFocus, placeholder]);

  useEffect(() => {
    const vditor = vditorRef.current;
    if (!vditor) {
      return;
    }

    const currentValue = vditor.getValue();
    if (currentValue === value) {
      return;
    }

    syncingFromExternalValueRef.current = true;
    vditor.setValue(value);
    syncingFromExternalValueRef.current = false;
  }, [value]);

  useEffect(() => {
    const applyTheme = () => {
      const vditor = vditorRef.current;
      if (!vditor || !vditor.setTheme) {
        return;
      }

      vditor.setTheme(resolveVditorTheme(), resolveVditorContentTheme());
    };

    applyTheme();

    const observer = new MutationObserver((mutations) => {
      const hasThemeMutation = mutations.some((mutation) => mutation.attributeName === "data-theme");
      if (hasThemeMutation) {
        applyTheme();
      }
    });

    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });

    return () => observer.disconnect();
  }, []);

  return (
    <div className={cn("memore-vditor-host w-full h-full min-h-[22rem] rounded-md border border-border overflow-hidden", className)}>
      <div ref={editorContainerRef} className="w-full h-full" />
    </div>
  );
};
