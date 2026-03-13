interface SavedCredentials {
  username: string;
  password: string;
}

const MEMORE_CREDENTIALS_KEY = "memore_saved_credentials_v1";

const isObject = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null;
};

export const saveMemoreAutoAuthCredentials = (username: string, password: string): void => {
  const normalizedUsername = username.trim();
  if (!normalizedUsername || !password) {
    return;
  }

  try {
    const payload: SavedCredentials = {
      username: normalizedUsername,
      password,
    };
    localStorage.setItem(MEMORE_CREDENTIALS_KEY, JSON.stringify(payload));
  } catch (error) {
    console.warn("[Memore] Failed to save auto-auth credentials:", error);
  }
};

export const getMemoreAutoAuthCredentials = (): SavedCredentials | null => {
  try {
    const raw = localStorage.getItem(MEMORE_CREDENTIALS_KEY);
    if (!raw) {
      return null;
    }

    const parsed: unknown = JSON.parse(raw);
    if (!isObject(parsed)) {
      return null;
    }

    const username = typeof parsed.username === "string" ? parsed.username.trim() : "";
    const password = typeof parsed.password === "string" ? parsed.password : "";

    if (!username || !password) {
      return null;
    }

    return { username, password };
  } catch (error) {
    console.warn("[Memore] Failed to read auto-auth credentials:", error);
    return null;
  }
};

export const clearMemoreAutoAuthCredentials = (): void => {
  try {
    localStorage.removeItem(MEMORE_CREDENTIALS_KEY);
  } catch (error) {
    console.warn("[Memore] Failed to clear auto-auth credentials:", error);
  }
};
