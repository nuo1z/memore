import defaultDarkThemeContent from "../themes/default-dark.css?raw";
import paperThemeContent from "../themes/paper.css?raw";

// ============================================================================
// Types and Constants
// ============================================================================

const VALID_THEMES = ["default", "default-dark", "paper"] as const;

export type Theme = (typeof VALID_THEMES)[number];

export interface ThemeOption {
  value: string;
  label: string;
}

const STORAGE_KEY = "memos-theme";
const STYLE_ELEMENT_ID = "instance-theme";
const DEFAULT_THEME: Theme = "paper";

const THEME_CONTENT: Record<Theme, string | null> = {
  default: null,
  "default-dark": defaultDarkThemeContent,
  paper: paperThemeContent,
};

export const THEME_OPTIONS: ThemeOption[] = [
  { value: "default", label: "Light" },
  { value: "default-dark", label: "Dark" },
  { value: "paper", label: "Paper" },
];

// ============================================================================
// Theme Validation
// ============================================================================

/**
 * Validates and normalizes a theme string to a valid theme.
 * Falls back to DEFAULT_THEME for invalid themes (including legacy "system").
 */
const validateTheme = (theme: string): Theme => {
  return VALID_THEMES.includes(theme as Theme) ? (theme as Theme) : DEFAULT_THEME;
};

// ============================================================================
// LocalStorage Helpers
// ============================================================================

/**
 * Safely reads the theme from localStorage.
 * Migrates legacy "system" value to DEFAULT_THEME.
 * @returns The stored theme, or null if not found or unavailable
 */
const getStoredTheme = (): Theme | null => {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return null;
    if (stored === "system") return DEFAULT_THEME;
    return VALID_THEMES.includes(stored as Theme) ? (stored as Theme) : null;
  } catch {
    return null;
  }
};

/**
 * Safely stores the theme to localStorage.
 */
const setStoredTheme = (theme: Theme): void => {
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // localStorage might not be available (SSR, private browsing, etc.)
  }
};

// ============================================================================
// Theme Selection with Fallbacks
// ============================================================================

/**
 * Gets the theme for initial page load (before user settings are available).
 * Priority: localStorage -> DEFAULT_THEME (paper)
 */
export const getInitialTheme = (): Theme => {
  return getStoredTheme() ?? DEFAULT_THEME;
};

/**
 * Gets the theme with full fallback chain.
 * Priority:
 * 1. User setting (if logged in and has preference)
 * 2. localStorage (from previous session)
 * 3. DEFAULT_THEME (paper)
 */
export const getThemeWithFallback = (userTheme?: string): Theme => {
  if (userTheme) {
    return validateTheme(userTheme);
  }

  return getStoredTheme() ?? DEFAULT_THEME;
};

// ============================================================================
// DOM Manipulation
// ============================================================================

/**
 * Removes the existing theme style element from the DOM.
 */
const removeThemeStyle = (): void => {
  document.getElementById(STYLE_ELEMENT_ID)?.remove();
};

/**
 * Injects theme CSS into the document head.
 * Skips injection for the default theme (uses base CSS).
 */
const injectThemeStyle = (theme: Theme): void => {
  removeThemeStyle();

  if (theme === "default") {
    return; // Use base CSS for default theme
  }

  const css = THEME_CONTENT[theme];
  if (css) {
    const style = document.createElement("style");
    style.id = STYLE_ELEMENT_ID;
    style.textContent = css;
    document.head.appendChild(style);
  }
};

/**
 * Sets the data-theme attribute on the document element.
 * This allows CSS to react to the current theme.
 */
const setThemeAttribute = (theme: Theme): void => {
  document.documentElement.setAttribute("data-theme", theme);
};

// ============================================================================
// Main Theme Loading
// ============================================================================

/**
 * Loads and applies a theme.
 * This function:
 * 1. Validates the theme
 * 2. Injects theme CSS
 * 3. Sets data-theme attribute
 * 4. Persists to localStorage
 */
export const loadTheme = (themeName: string): void => {
  const theme = validateTheme(themeName);

  injectThemeStyle(theme);
  setThemeAttribute(theme);
  setStoredTheme(theme);
};

/**
 * Applies theme early during initial page load to prevent FOUC.
 * Uses only localStorage (no user settings yet).
 */
export const applyThemeEarly = (): void => {
  const theme = getInitialTheme();
  loadTheme(theme);
};
