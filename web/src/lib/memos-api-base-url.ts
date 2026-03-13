declare global {
  interface Window {
    __MEMOS_API_BASE_URL__?: string;
  }
}

const MEMOS_FALLBACK_API_BASE_URL = "http://127.0.0.1:8081";

export const normalizeMemosApiBaseUrl = (rawUrl?: string): string | undefined => {
  if (!rawUrl) {
    return undefined;
  }

  const trimmed = rawUrl.trim();
  if (!trimmed) {
    return undefined;
  }

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return undefined;
    }

    return `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, "");
  } catch {
    return undefined;
  }
};

const getWindowApiBaseUrl = (): string | undefined => {
  if (typeof window === "undefined") {
    return undefined;
  }

  return normalizeMemosApiBaseUrl(window.__MEMOS_API_BASE_URL__);
};

const getEnvApiBaseUrl = (): string | undefined => {
  return normalizeMemosApiBaseUrl(import.meta.env.VITE_MEMOS_API_BASE_URL);
};

const getOriginApiBaseUrl = (): string | undefined => {
  if (typeof window === "undefined") {
    return undefined;
  }

  return normalizeMemosApiBaseUrl(window.location.origin);
};

export const getMemosApiBaseUrl = (): string => {
  return getWindowApiBaseUrl() ?? getEnvApiBaseUrl() ?? getOriginApiBaseUrl() ?? MEMOS_FALLBACK_API_BASE_URL;
};

export const buildMemosApiUrl = (path: string): string => {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${getMemosApiBaseUrl()}${normalizedPath}`;
};

export {};
