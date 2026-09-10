/**
 * Browser-local sessions. The participant credential is exchanged once, at
 * `/d/:decisionId/p/:credential`, for an HTTP-only session cookie; the
 * credential itself never travels again and never reaches JavaScript.
 *
 * The cookie is named per decision so one browser can hold sessions for
 * several decisions — and be a different participant in each — at once. It is
 * `Path=/` because the Agents SDK WebSocket lives under `/agents/*`, not
 * under `/d/*`.
 */

import { newCredential } from "./credentials.ts";

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Decision ids appear in a cookie name and a DO instance name; keep them boring. */
export const DECISION_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function sessionCookieName(decisionId: string): string {
  return `adf_session_${decisionId}`;
}

export const newSessionId = newCredential;

export function sessionCookie(decisionId: string, sessionId: string): string {
  const attrs = [
    `${sessionCookieName(decisionId)}=${sessionId}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`
  ];
  return attrs.join("; ");
}

/** Reads one cookie out of a `Cookie:` header. */
export function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const pair of header.split(";")) {
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    if (pair.slice(0, eq).trim() === name) return pair.slice(eq + 1).trim();
  }
  return null;
}

export function readSessionId(request: Request, decisionId: string): string | null {
  return readCookie(request.headers.get("Cookie"), sessionCookieName(decisionId));
}
