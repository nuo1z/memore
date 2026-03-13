import { useEffect } from "react";
import { cacheService } from "../services";

export const useAutoSave = (content: string, username: string, cacheKey: string | undefined, enabled: boolean = true) => {
  useEffect(() => {
    if (!enabled) {
      cacheService.save.cancel();
      return;
    }

    const key = cacheService.key(username, cacheKey);
    cacheService.save(key, content);

    return () => {
      cacheService.save.cancel();
    };
  }, [content, username, cacheKey, enabled]);
};
