import { useEffect, useState } from "react";
import { Outlet } from "react-router-dom";
import DesktopTitleBar from "./components/DesktopTitleBar";
import { useInstance } from "./contexts/InstanceContext";
import { MemoFilterProvider } from "./contexts/MemoFilterContext";
import useNavigateTo from "./hooks/useNavigateTo";
import { useUserLocale } from "./hooks/useUserLocale";
import { useUserTheme } from "./hooks/useUserTheme";

const detectAndroidCapacitorRuntimeSync = (): boolean => {
  if (typeof window === "undefined") {
    return false;
  }

  const maybeCapacitor = (
    window as Window & {
      Capacitor?: {
        isNativePlatform?: () => boolean;
        getPlatform?: () => string;
      };
    }
  ).Capacitor;

  try {
    if (maybeCapacitor?.isNativePlatform && maybeCapacitor?.getPlatform) {
      return maybeCapacitor.isNativePlatform() && maybeCapacitor.getPlatform() === "android";
    }
  } catch {
    // Fallback to user-agent heuristic below.
  }

  const ua = window.navigator.userAgent.toLowerCase();
  const isAndroid = ua.includes("android");
  const isWebView = ua.includes("wv") || ua.includes("capacitor");
  return isAndroid && isWebView;
};

const isCapacitorAndroid = async (): Promise<boolean> => {
  if (detectAndroidCapacitorRuntimeSync()) {
    return true;
  }

  try {
    const { Capacitor } = await import("@capacitor/core");
    return Capacitor.isNativePlatform() && Capacitor.getPlatform() === "android";
  } catch {
    return false;
  }
};

const measureSafeAreaTopInset = (): number => {
  const probe = document.createElement("div");
  probe.style.position = "fixed";
  probe.style.top = "0";
  probe.style.left = "0";
  probe.style.visibility = "hidden";
  probe.style.pointerEvents = "none";
  probe.style.paddingTop = "env(safe-area-inset-top)";
  document.body.appendChild(probe);
  const inset = Number.parseFloat(window.getComputedStyle(probe).paddingTop || "0");
  probe.remove();
  return Number.isFinite(inset) ? inset : 0;
};

const toHexColor = (cssColor: string): string | null => {
  const normalized = cssColor.trim();
  if (!normalized) {
    return null;
  }

  if (normalized.startsWith("#")) {
    if (normalized.length === 4) {
      const r = normalized[1];
      const g = normalized[2];
      const b = normalized[3];
      return `#${r}${r}${g}${g}${b}${b}`;
    }
    return normalized;
  }

  const rgbMatch = normalized.match(/^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/i);
  if (!rgbMatch) {
    return null;
  }

  const toChannel = (value: string): string => {
    const clamped = Math.max(0, Math.min(255, Number.parseInt(value, 10)));
    return clamped.toString(16).padStart(2, "0");
  };

  return `#${toChannel(rgbMatch[1])}${toChannel(rgbMatch[2])}${toChannel(rgbMatch[3])}`;
};

const App = () => {
  const navigateTo = useNavigateTo();
  const { profile: instanceProfile, profileLoaded, generalSetting: instanceGeneralSetting } = useInstance();
  const [isAndroidRuntime, setIsAndroidRuntime] = useState<boolean>(() => detectAndroidCapacitorRuntimeSync());
  const [androidSafeTopHeight, setAndroidSafeTopHeight] = useState<number>(() => (detectAndroidCapacitorRuntimeSync() ? 24 : 0));
  const [androidSafeTopFill, setAndroidSafeTopFill] = useState<string>("#FAFAFA");

  // Apply user preferences reactively
  useUserLocale();
  useUserTheme();

  // Redirect to sign up page if instance not initialized (no admin account exists yet).
  // Guard with profileLoaded so a fetch failure doesn't incorrectly trigger the redirect.
  useEffect(() => {
    if (profileLoaded && !instanceProfile.admin) {
      navigateTo("/auth/signup");
    }
  }, [profileLoaded, instanceProfile.admin, navigateTo]);

  useEffect(() => {
    if (instanceGeneralSetting.additionalStyle) {
      const styleEl = document.createElement("style");
      styleEl.innerHTML = instanceGeneralSetting.additionalStyle;
      styleEl.setAttribute("type", "text/css");
      document.body.insertAdjacentElement("beforeend", styleEl);
    }
  }, [instanceGeneralSetting.additionalStyle]);

  useEffect(() => {
    if (instanceGeneralSetting.additionalScript) {
      const scriptEl = document.createElement("script");
      scriptEl.innerHTML = instanceGeneralSetting.additionalScript;
      document.head.appendChild(scriptEl);
    }
  }, [instanceGeneralSetting.additionalScript]);

  // Dynamic update metadata with customized profile
  useEffect(() => {
    if (!instanceGeneralSetting.customProfile) {
      return;
    }

    document.title = instanceGeneralSetting.customProfile.title;
    const link = document.querySelector("link[rel~='icon']") as HTMLLinkElement;
    link.href = instanceGeneralSetting.customProfile.logoUrl || "/logo.webp";
  }, [instanceGeneralSetting.customProfile]);

  useEffect(() => {
    let cleanup: (() => void) | undefined;

    const setupAndroidViewport = async () => {
      const runtime = detectAndroidCapacitorRuntimeSync() || (await isCapacitorAndroid());
      if (!runtime) {
        return;
      }

      setIsAndroidRuntime(true);
      document.documentElement.classList.add("mobile-capacitor-android");
      // 先写入一个稳定兜底值，避免状态栏插件尚未就绪时顶部安全区高度为 0。
      document.documentElement.style.setProperty("--memore-status-bar-height", "24px");
      document.documentElement.style.setProperty("--memore-android-safe-top", "24px");
      setAndroidSafeTopHeight(24);
      const initialBackground = window.getComputedStyle(document.body).backgroundColor;
      if (initialBackground && initialBackground !== "rgba(0, 0, 0, 0)") {
        document.documentElement.style.setProperty("--memore-status-bar-fill", initialBackground);
        setAndroidSafeTopFill(initialBackground);
      }
      const updateViewportOffset = () => {
        const viewport = window.visualViewport;
        if (!viewport) {
          document.documentElement.style.setProperty("--memore-visual-viewport-offset", "0px");
          return;
        }

        const offset = Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop);
        document.documentElement.style.setProperty("--memore-visual-viewport-offset", `${offset}px`);
      };

      updateViewportOffset();
      window.visualViewport?.addEventListener("resize", updateViewportOffset);
      window.visualViewport?.addEventListener("scroll", updateViewportOffset);

      cleanup = () => {
        window.visualViewport?.removeEventListener("resize", updateViewportOffset);
        window.visualViewport?.removeEventListener("scroll", updateViewportOffset);
        document.documentElement.classList.remove("mobile-capacitor-android");
        document.documentElement.style.removeProperty("--memore-visual-viewport-offset");
        document.documentElement.style.removeProperty("--memore-android-safe-top");
        setIsAndroidRuntime(false);
      };
    };

    void setupAndroidViewport();

    return () => cleanup?.();
  }, []);

  useEffect(() => {
    let observer: MutationObserver | undefined;

    const setupStatusBar = async () => {
      const runtime = detectAndroidCapacitorRuntimeSync() || (await isCapacitorAndroid());
      if (!runtime) {
        return;
      }
      setIsAndroidRuntime(true);
      document.documentElement.classList.add("mobile-capacitor-android");

      const [{ StatusBar, Style }] = await Promise.all([import("@capacitor/status-bar")]);

      const applyStatusBarTheme = async () => {
        const isDark = document.documentElement.getAttribute("data-theme") === "default-dark";
        const fallbackWebColor = isDark ? "rgb(18, 18, 18)" : "rgb(250, 250, 250)";
        const computedBackground = window.getComputedStyle(document.body).backgroundColor;
        const webFillColor =
          computedBackground && computedBackground !== "rgba(0, 0, 0, 0)" ? computedBackground : fallbackWebColor;
        const nativeBackgroundColor = toHexColor(webFillColor) ?? (isDark ? "#121212" : "#FAFAFA");

        try {
          await StatusBar.setOverlaysWebView({ overlay: false });
          // Capacitor StatusBar style 枚举语义与命名相反：
          // Style.Dark = 浅色文字，Style.Light = 深色文字。
          await StatusBar.setStyle({ style: isDark ? Style.Dark : Style.Light });
          await StatusBar.setBackgroundColor({ color: nativeBackgroundColor });
          await StatusBar.getInfo();
        } catch (error) {
          // 某些机型上插件调用会偶发失败；保留兜底安全区，避免顶栏消失。
          console.warn("[Memore] Failed to apply status bar via Capacitor, using fallback:", error);
        }

        const fallbackTopInset = measureSafeAreaTopInset();
        // 安卓端统一保留至少 24px 的安全顶栏，避免出现“顶栏填充消失”。
        const measuredInset = Math.round(fallbackTopInset);
        const statusBarHeight = Math.max(24, measuredInset);
        document.documentElement.style.setProperty("--memore-status-bar-height", `${statusBarHeight}px`);
        document.documentElement.style.setProperty("--memore-android-safe-top", `${statusBarHeight}px`);
        document.documentElement.style.setProperty("--memore-status-bar-fill", webFillColor);
        setAndroidSafeTopHeight(statusBarHeight);
        setAndroidSafeTopFill(webFillColor);
      };

      await applyStatusBarTheme();
      observer = new MutationObserver((mutations) => {
        const hasThemeMutation = mutations.some((mutation) => mutation.attributeName === "data-theme");
        if (hasThemeMutation) {
          void applyStatusBarTheme();
        }
      });
      observer.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["data-theme"],
      });
    };

    void setupStatusBar();

    return () => observer?.disconnect();
  }, []);

  useEffect(() => {
    const setupSplash = async () => {
      if (!(await isCapacitorAndroid())) {
        return;
      }

      const { SplashScreen } = await import("@capacitor/splash-screen");
      window.setTimeout(() => {
        void SplashScreen.hide({ fadeOutDuration: 250 });
      }, 450);
    };

    void setupSplash();
  }, []);

  useEffect(() => {
    let initialized = false;
    let cleanup: (() => void) | undefined;

    const setupAndroidBackHandler = async () => {
      if (!(await isCapacitorAndroid())) {
        return;
      }

      initialized = true;
      const win = window as Window & { __memoreHandleAndroidBack?: () => boolean };
      win.__memoreHandleAndroidBack = () => {
        const focusOverlay = document.querySelector<HTMLElement>(".memore-focus-overlay");
        if (focusOverlay) {
          focusOverlay.click();
          return true;
        }

        const openSheetOverlays = document.querySelectorAll<HTMLElement>('[data-slot="sheet-overlay"][data-state="open"]');
        const latestSheetOverlay = openSheetOverlays.item(openSheetOverlays.length - 1);
        if (latestSheetOverlay) {
          latestSheetOverlay.click();
          return true;
        }

        const openDialogOverlays = document.querySelectorAll<HTMLElement>('[data-slot="dialog-overlay"][data-state="open"]');
        const latestDialogOverlay = openDialogOverlays.item(openDialogOverlays.length - 1);
        if (latestDialogOverlay) {
          latestDialogOverlay.click();
          return true;
        }

        return false;
      };

      cleanup = () => {
        delete win.__memoreHandleAndroidBack;
      };
    };

    void setupAndroidBackHandler();

    return () => {
      if (initialized) {
        cleanup?.();
      }
    };
  }, []);

  return (
    <MemoFilterProvider>
      {isAndroidRuntime && (
        <div
          className="memore-android-safe-top-fill"
          style={{
            height: `${androidSafeTopHeight}px`,
            background: androidSafeTopFill,
          }}
        />
      )}
      <div
        className="memore-mobile-safe-layout"
        style={
          isAndroidRuntime
            ? {
                paddingTop: `${androidSafeTopHeight}px`,
              }
            : undefined
        }
      >
        <DesktopTitleBar />
        <Outlet />
      </div>
    </MemoFilterProvider>
  );
};

export default App;
