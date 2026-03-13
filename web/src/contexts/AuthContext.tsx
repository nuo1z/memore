/**
 * 认证上下文 (AuthContext)
 *
 * 管理当前用户的认证状态：
 * - currentUser：当前登录的用户信息
 * - initialized：认证初始化是否完成
 * - initialize()：刷新当前用户（调用 authServiceClient.getAuthStatus）
 * - logout()：登出并清除令牌
 *
 * 所有需要用户信息的组件都应通过 useAuth() 获取
 */
import { useQueryClient } from "@tanstack/react-query";
import { timestampDate } from "@bufbuild/protobuf/wkt";
import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from "react";
import { clearAccessToken, hasStoredToken, setAccessToken } from "@/auth-state";
import { authServiceClient, shortcutServiceClient, userServiceClient } from "@/connect";
import { userKeys } from "@/hooks/useUserQueries";
import { clearMemoreAutoAuthCredentials, getMemoreAutoAuthCredentials } from "@/lib/memore-auto-auth";
import type { Shortcut } from "@/types/proto/api/v1/shortcut_service_pb";
import type { User, UserSetting_GeneralSetting, UserSetting_WebhooksSetting } from "@/types/proto/api/v1/user_service_pb";

interface AuthState {
  currentUser: User | undefined;
  userGeneralSetting: UserSetting_GeneralSetting | undefined;
  userWebhooksSetting: UserSetting_WebhooksSetting | undefined;
  shortcuts: Shortcut[];
  isInitialized: boolean;
  isLoading: boolean;
}

interface AuthContextValue extends AuthState {
  initialize: () => Promise<void>;
  logout: () => Promise<void>;
  refetchSettings: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [state, setState] = useState<AuthState>({
    currentUser: undefined,
    userGeneralSetting: undefined,
    userWebhooksSetting: undefined,
    shortcuts: [],
    isInitialized: false,
    isLoading: true,
  });

  const fetchUserSettings = useCallback(async (userName: string) => {
    const [{ settings }, { shortcuts }] = await Promise.all([
      userServiceClient.listUserSettings({ parent: userName }),
      shortcutServiceClient.listShortcuts({ parent: userName }),
    ]);

    const generalSetting = settings.find((s) => s.value.case === "generalSetting");
    const webhooksSetting = settings.find((s) => s.value.case === "webhooksSetting");

    return {
      userGeneralSetting: generalSetting?.value.case === "generalSetting" ? generalSetting.value.value : undefined,
      userWebhooksSetting: webhooksSetting?.value.case === "webhooksSetting" ? webhooksSetting.value.value : undefined,
      shortcuts,
    };
  }, []);

  const initialize = useCallback(async () => {
    setState((prev) => ({ ...prev, isLoading: true }));

    const setUnauthenticatedState = () => {
      setState({
        currentUser: undefined,
        userGeneralSetting: undefined,
        userWebhooksSetting: undefined,
        shortcuts: [],
        isInitialized: true,
        isLoading: false,
      });
    };

    const trySignInWithSavedCredentials = async (): Promise<boolean> => {
      const savedCredentials = getMemoreAutoAuthCredentials();
      if (!savedCredentials) {
        return false;
      }

      try {
        const response = await authServiceClient.signIn({
          credentials: {
            case: "passwordCredentials",
            value: savedCredentials,
          },
        });

        if (!response.accessToken) {
          return false;
        }

        setAccessToken(response.accessToken, response.accessTokenExpiresAt ? timestampDate(response.accessTokenExpiresAt) : undefined);
        return true;
      } catch (error) {
        console.warn("[AuthContext] Auto sign-in with saved credentials failed:", error);
        return false;
      }
    };

    const tryLoadCurrentUser = async (): Promise<boolean> => {
      const { user: currentUser } = await authServiceClient.getCurrentUser({});
      if (!currentUser) {
        return false;
      }

      const settings = await fetchUserSettings(currentUser.name);

      setState({
        currentUser,
        ...settings,
        isInitialized: true,
        isLoading: false,
      });

      // Pre-populate React Query cache
      queryClient.setQueryData(userKeys.currentUser(), currentUser);
      queryClient.setQueryData(userKeys.detail(currentUser.name), currentUser);
      return true;
    };

    // If there is no stored token at all, attempt local auto-login first.
    if (!hasStoredToken()) {
      const autoSignedIn = await trySignInWithSavedCredentials();
      if (!autoSignedIn) {
        setUnauthenticatedState();
        return;
      }
    }

    try {
      const loaded = await tryLoadCurrentUser();
      if (loaded) {
        return;
      }
    } catch (error) {
      console.error("Failed to initialize auth:", error);
    }

    clearAccessToken();

    // Fallback: if refresh session failed, try saved local credentials once more.
    const autoSignedIn = await trySignInWithSavedCredentials();
    if (autoSignedIn) {
      try {
        const loaded = await tryLoadCurrentUser();
        if (loaded) {
          return;
        }
      } catch (error) {
        console.error("Failed to initialize auth after auto sign-in:", error);
      }
    }

    setUnauthenticatedState();
  }, [fetchUserSettings, queryClient]);

  const logout = useCallback(async () => {
    try {
      await authServiceClient.signOut({});
    } catch (error) {
      console.error("[AuthContext] Failed to sign out:", error);
    } finally {
      clearAccessToken();
      clearMemoreAutoAuthCredentials();
      setState({
        currentUser: undefined,
        userGeneralSetting: undefined,
        userWebhooksSetting: undefined,
        shortcuts: [],
        isInitialized: true,
        isLoading: false,
      });
      queryClient.clear();
    }
  }, [queryClient]);

  const refetchSettings = useCallback(async () => {
    // Use functional setState to get current user without including state in dependencies
    setState((prev) => {
      if (!prev.currentUser) return prev;

      // Fetch settings asynchronously
      fetchUserSettings(prev.currentUser.name).then((settings) => {
        setState((current) => ({ ...current, ...settings }));
      });

      return prev;
    });
  }, [fetchUserSettings]);

  // Memoize context value to prevent unnecessary re-renders of consumers
  const value = useMemo(
    () => ({
      ...state,
      initialize,
      logout,
      refetchSettings,
    }),
    [state, initialize, logout, refetchSettings],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within AuthProvider");
  }
  return context;
}

// Convenience hook for just the current user
export function useCurrentUserFromAuth() {
  const { currentUser } = useAuth();
  return currentUser;
}
