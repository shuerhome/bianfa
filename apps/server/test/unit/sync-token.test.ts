import { describe, expect, it } from "vitest";
import { SYNC_TOKEN_TTL_SECONDS, signSyncToken, verifySyncToken } from "../../src/sync/token.js";

const SECRET = "0123456789abcdef0123456789abcdef-test-secret";

describe("sync token", () => {
  it("round-trips claims with a 60 s TTL", async () => {
    const now = 1_800_000_000;
    const { token, expiresIn, expiresAt } = await signSyncToken(
      SECRET,
      { sub: "u1", did: "d1", sid: "s1", msv: 1 },
      now,
    );
    expect(expiresIn).toBe(SYNC_TOKEN_TTL_SECONDS);
    expect(expiresAt).toBe((now + 60) * 1000);
    const r = await verifySyncToken(SECRET, token);
    expect(r.ok && r.claims.sub).toBe("u1");
    expect(r.ok && r.claims.did).toBe("d1");
    expect(r.ok && r.claims.exp).toBe(now + 60);
    expect(r.ok && r.claims.jti.length).toBeGreaterThan(10);
  });
  it("rejects wrong secret / tampered token as bad_token and stale as expired", async () => {
    const { token } = await signSyncToken(SECRET, { sub: "u1", did: null, sid: null, msv: 1 });
    expect(await verifySyncToken(`${SECRET}x`, token)).toEqual({ ok: false, reason: "bad_token" });
    expect(await verifySyncToken(SECRET, `${token}x`)).toEqual({ ok: false, reason: "bad_token" });
    const old = await signSyncToken(
      SECRET,
      { sub: "u1", did: null, sid: null, msv: 1 },
      Math.floor(Date.now() / 1000) - 600,
    );
    expect(await verifySyncToken(SECRET, old.token)).toEqual({ ok: false, reason: "expired" });
  });
  it("refuses short secrets", async () => {
    await expect(signSyncToken("short", { sub: "u", did: null, sid: null, msv: 1 })).rejects.toThrow();
  });
});
