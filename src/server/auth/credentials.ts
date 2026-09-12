/**
 * Participant credentials — the secret in `/d/:decisionId/p/:credential`.
 *
 * A bearer credential, deliberately: no accounts, no recovery. Anyone holding
 * the link can act as that participant (documented limitation). Only the hash
 * is ever persisted, so a leaked database does not yield working links.
 */

const CREDENTIAL_BYTES = 24;

export function newCredential(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(CREDENTIAL_BYTES)));
}

export async function hashCredential(credential: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(credential));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The token from an `Authorization: Bearer …` header, if there is one. */
export function bearerToken(request: Request): string | null {
  return request.headers.get("Authorization")?.match(/^Bearer +(\S+)$/)?.[1] ?? null;
}

/**
 * Whether a presented token is the configured secret.
 *
 * Compared as hashes rather than as strings: two hashes are always the same
 * length and differ from their first bytes, so how long the comparison takes
 * says nothing about how much of the secret a guess got right.
 */
export async function matchesSecret(presented: string | null, secret: string): Promise<boolean> {
  if (!presented) return false;
  const [a, b] = await Promise.all([hashCredential(presented), hashCredential(secret)]);
  return a === b;
}

export function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}
