import { describe, expect, it } from "vitest";
import { hashCredential, newCredential } from "../../src/server/auth/credentials.ts";
import { DECISION_ID_PATTERN, readCookie, sessionCookie, sessionCookieName } from "../../src/server/auth/sessions.ts";

describe("credentials", () => {
  it("mints distinct URL-safe credentials", () => {
    const credentials = new Set(Array.from({ length: 50 }, newCredential));
    expect(credentials.size).toBe(50);
    for (const c of credentials) expect(c).toMatch(/^[A-Za-z0-9_-]{32}$/);
  });

  it("hashes stably, and only the hash could ever be stored", async () => {
    const credential = newCredential();
    expect(await hashCredential(credential)).toBe(await hashCredential(credential));
    expect(await hashCredential(credential)).not.toContain(credential);
    expect(await hashCredential(credential)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("session cookies", () => {
  it("names the cookie per decision so one browser can hold several", () => {
    expect(sessionCookieName("abc")).not.toBe(sessionCookieName("def"));
  });

  it("is http-only and site-scoped", () => {
    const cookie = sessionCookie("abc", "session-id");
    expect(cookie).toContain("adf_session_abc=session-id");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Path=/"); // the WebSocket lives under /agents/*
    expect(cookie).toContain("SameSite=Lax");
  });

  it("reads one cookie out of a header of many", () => {
    const header = "other=1; adf_session_abc=wanted; adf_session_def=ignored";
    expect(readCookie(header, "adf_session_abc")).toBe("wanted");
    expect(readCookie(header, "adf_session_def")).toBe("ignored");
    expect(readCookie(header, "adf_session_ghi")).toBeNull();
    expect(readCookie(null, "adf_session_abc")).toBeNull();
  });

  it("does not confuse a cookie whose name is a suffix of another", () => {
    expect(readCookie("xadf_session_abc=wrong; adf_session_abc=right", "adf_session_abc")).toBe("right");
  });

  it("only accepts decision ids that are safe as a cookie name and DO name", () => {
    expect(DECISION_ID_PATTERN.test(crypto.randomUUID())).toBe(true);
    for (const bad of ["", "a b", "a;b", "a=b", "../etc", "a".repeat(65)]) {
      expect(DECISION_ID_PATTERN.test(bad)).toBe(false);
    }
  });
});
