import { describe, expect, it } from "vitest";
import { ORIGIN, battery, bearer, call, createAccount, env, ingest, json, live, login, sha256Hex, syncBody } from "./helpers";

describe("POST /v1/token/rotate", () => {
  it("issues a new token and invalidates the old one immediately", async () => {
    const { token, account_id } = await createAccount();
    const res = await call("/v1/token/rotate", { method: "POST", headers: bearer(token) });
    expect(res.status).toBe(200);
    const { token: fresh } = (await res.json()) as { token: string };
    expect(fresh).toMatch(/^fb_[A-Za-z0-9_-]{43}$/);
    expect(fresh).not.toBe(token);

    expect((await call("/v1/me", { headers: bearer(token) })).status).toBe(401);
    expect((await ingest(token, syncBody([]))).status).toBe(401);
    expect((await call("/v1/me", { headers: bearer(fresh) })).status).toBe(200);

    const row = await env.DB.prepare("SELECT token_hash, token_rotated_at FROM accounts WHERE id = ?")
      .bind(account_id)
      .first<{ token_hash: string; token_rotated_at: number }>();
    expect(row?.token_hash).toBe(await sha256Hex(fresh));
    expect(row?.token_rotated_at).toBeGreaterThan(0);
  });

  it("signs out every web session when rotated with the token", async () => {
    const { token } = await createAccount();
    const c1 = await login(token);
    const c2 = await login(token);
    await call("/v1/token/rotate", { method: "POST", headers: bearer(token) });
    expect((await call("/v1/me", { headers: { Cookie: c1 } })).status).toBe(401);
    expect((await call("/v1/me", { headers: { Cookie: c2 } })).status).toBe(401);
  });

  it("keeps only the current session when rotated from the panel", async () => {
    const { token } = await createAccount();
    const current = await login(token);
    const other = await login(token);
    const res = await call("/v1/token/rotate", { method: "POST", headers: { Cookie: current, Origin: ORIGIN } });
    expect(res.status).toBe(200);
    expect((await call("/v1/me", { headers: { Cookie: current } })).status).toBe(200);
    expect((await call("/v1/me", { headers: { Cookie: other } })).status).toBe(401);
    expect((await call("/v1/me", { headers: bearer(token) })).status).toBe(401);
  });
});

describe("DELETE /v1/account", () => {
  it("removes the account and every row that belongs to it", async () => {
    const keep = await createAccount();
    await ingest(keep.token, syncBody([live("2026-10-13T10:00:00Z", 5)]));

    const { token, account_id } = await createAccount();
    await ingest(token, syncBody([live("2026-10-13T10:00:00Z", 10), battery("2026-10-13T10:00:01Z", 40)]));
    const hook = await call("/v1/webhooks", json({ url: "https://hooks.example.org/x" }, bearer(token)));
    expect(hook.status).toBe(201);
    await login(token);
    await ingest(token, syncBody([])); // leaves an ingest rate-limit counter

    const res = await call("/v1/account", { method: "DELETE", headers: bearer(token) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true });
    expect(res.headers.get("set-cookie")).toContain("Max-Age=0");

    expect((await call("/v1/me", { headers: bearer(token) })).status).toBe(401);
    for (const [table, col] of [
      ["accounts", "id"],
      ["devices", "account_id"],
      ["samples", "account_id"],
      ["webhooks", "account_id"],
      ["sessions", "account_id"],
    ] as const) {
      const n = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${col} = ?`).bind(account_id).first<{ n: number }>();
      expect(n?.n, table).toBe(0);
    }
    const rl = await env.DB.prepare("SELECT COUNT(*) AS n FROM rate_limits WHERE key LIKE ?").bind(`%${account_id}%`).first<{ n: number }>();
    expect(rl?.n).toBe(0);

    // The other account is untouched.
    const other = (await (await call("/v1/samples", { headers: bearer(keep.token) })).json()) as { samples: unknown[] };
    expect(other.samples).toHaveLength(1);
  });

  it("signs the web session out when deleted from the panel", async () => {
    const { token } = await createAccount();
    const cookie = await login(token);
    const res = await call("/v1/account", { method: "DELETE", headers: { Cookie: cookie, Origin: ORIGIN } });
    expect(res.status).toBe(200);
    expect((await call("/v1/me", { headers: { Cookie: cookie } })).status).toBe(401);
    const page = await call("/app", { headers: { Cookie: cookie }, redirect: "manual" });
    expect(page.status).toBe(303);
  });
});
