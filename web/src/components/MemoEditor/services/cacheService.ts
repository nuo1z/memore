import { debounce } from "lodash-es";

export const CACHE_DEBOUNCE_DELAY = 500;

const persistDraft = (key: string, content: string) => {
  if (content.trim()) {
    localStorage.setItem(key, content);
  } else {
    localStorage.removeItem(key);
  }
};

export const cacheService = {
  key: (username: string, cacheKey?: string): string => {
    return `${username}-${cacheKey || ""}`;
  },

  save: debounce((key: string, content: string) => {
    persistDraft(key, content);
  }, CACHE_DEBOUNCE_DELAY),

  saveNow(key: string, content: string): void {
    cacheService.save.cancel();
    persistDraft(key, content);
  },

  load(key: string): string {
    return localStorage.getItem(key) || "";
  },

  clear(key: string): void {
    localStorage.removeItem(key);
  },
};
