import { clearAccessToken } from "@/auth-state";
import { ROUTES } from "@/router/routes";

const PUBLIC_ROUTES = [
  ROUTES.AUTH,
  "/memos/",
] as const;

const PRIVATE_ROUTES = [ROUTES.ROOT, ROUTES.ATTACHMENTS, ROUTES.INBOX, ROUTES.ARCHIVED, ROUTES.SETTING] as const;

function isPublicRoute(path: string): boolean {
  return PUBLIC_ROUTES.some((route) => path.startsWith(route));
}

function isPrivateRoute(path: string): boolean {
  return PRIVATE_ROUTES.includes(path as (typeof PRIVATE_ROUTES)[number]);
}

export function redirectOnAuthFailure(): void {
  const currentPath = window.location.pathname;

  if (isPublicRoute(currentPath)) {
    return;
  }

  if (isPrivateRoute(currentPath)) {
    clearAccessToken();
    window.location.replace(ROUTES.AUTH);
  }
}
