import { describe, expect, it } from "vitest";
import { ORIGIN, bearer, call, createAccount, env, freshIp, json, sha256Hex } from "./helpers";

describe("POST /v1/accounts", () => {
  it("creates an account and returns the token exactly once", async () => {
    const acct = await createAccount({ tz: "Europe/Istanbul", name: "Band 10 Pro D9B9" });
    expect(acct.token).toMatch(/^ob_[A-Za-z0-9_-]{43}$/);
    expect(acct.account_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(acct.web_url).toBe(`${ORIGIN}/login`);

    const me = await call("/v1/me", { headers: bearer(acct.token) });
    expect(me.status).toBe(200);
    const body = (await me.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      account_id: acct.account_id,
      name: "Band 10 Pro D9B9",
      tz: "Europe/Istanbul",
      devices: [],
      samples: { live: 0, battery: 0, total: 0 },
      webhooks: 0,
    });
    expect(JSON.stringify(body)).not.toContain(acct.token);
  });

  it("stores only the SHA-256 of the token", async () => {
    const acct = await createAccount();
    const row = await env.DB.prepare("SELECT * FROM accounts WHERE id = ?").bind(acct.account_id).first();
    expect(row).not.toBeNull();
    expect(row?.token_hash).toBe(await sha256Hex(acct.token));
    expect(JSON.stringify(row)).not.toContain(acct.token);
    expect(JSON.stringify(row)).not.toContain(acct.token.slice(3));
  });

  it("issues distinct tokens with 32 random bytes each", async () => {
    const a = await createAccount();
    const b = await createAccount();
    expect(a.token).not.toBe(b.token);
    expect(a.account_id).not.toBe(b.account_id);
    // base64url of 32 bytes decodes back to 32 bytes
    const raw = atob(a.token.slice(3).replace(/-/g, "+").replace(/_/g, "/") + "=");
    expect(raw.length).toBe(32);
  });

  it("validates the body", async () => {
    const cases: Array<[unknown, number]> = [
      [{ device_name: "Band", tz: "Mars/Olympus" }, 400],
      [{ device_name: "Band", tz: "" }, 400],
      [{ device_name: "Band" }, 400],
      [{ tz: "Europe/Istanbul" }, 400],
      [{ device_name: "", tz: "Europe/Istanbul" }, 400],
      [{ device_name: "x".repeat(101), tz: "Europe/Istanbul" }, 400],
      [{ device_name: "bad\u0000name", tz: "Europe/Istanbul" }, 400],
      [["not", "an", "object"], 400],
    ];
    for (const [body, status] of cases) {
      const res = await call("/v1/accounts", json(body));
      expect(res.status, JSON.stringify(body)).toBe(status);
      expect(((await res.json()) as { error: string }).error).toBe("invalid_body");
    }

    const wrongType = await call("/v1/accounts", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({ device_name: "Band", tz: "UTC" }),
    });
    expect(wrongType.status).toBe(415);

    const notJson = await call("/v1/accounts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{nope",
    });
    expect(notJson.status).toBe(400);
    expect(((await notJson.json()) as { error: string }).error).toBe("invalid_json");

    const huge = await call("/v1/accounts", json({ device_name: "Band", tz: "UTC", pad: "x".repeat(9000) }));
    expect(huge.status).toBe(413);
  });

  it("rate limits account creation per IP", async () => {
    const ip = freshIp();
    for (let i = 0; i < 10; i++) {
      const res = await call("/v1/accounts", { ...json({ device_name: "Band", tz: "UTC" }), ip });
      expect(res.status).toBe(201);
    }
    const blocked = await call("/v1/accounts", { ...json({ device_name: "Band", tz: "UTC" }), ip });
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(((await blocked.json()) as { error: string }).error).toBe("rate_limited");

    // Another IP is unaffected.
    const other = await call("/v1/accounts", { ...json({ device_name: "Band", tz: "UTC" }), ip: freshIp() });
    expect(other.status).toBe(201);

    // Counters hold a keyed hash, never the raw IP.
    const { results } = await env.DB.prepare("SELECT key FROM rate_limits").all<{ key: string }>();
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) expect(r.key).not.toContain(ip);
  });
});
