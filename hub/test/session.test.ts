import { createExecutionContext, createScheduledController, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { ORIGIN, call, createAccount, env, freshIp, json, login, sha256Hex } from "./helpers";

function attrs(setCookie: string): { name: string; value: string; attrs: Map<string, string> } {
  const [pair = "", ...rest] = setCookie.split(";").map((s) => s.trim());
  const i = pair.indexOf("=");
  const map = new Map<string, string>();
  for (const r of rest) {
    const j = r.indexOf("=");
    map.set((j < 0 ? r : r.slice(0, j)).toLowerCase(), j < 0 ? "" : r.slice(j + 1));
  }
  return { name: pair.slice(0, i), value: pair.slice(i + 1), attrs: map };
}

describe("POST /v1/session", () => {
  it("sets an HttpOnly, Secure, SameSite=Strict cookie for 30 days", async () => {
    const { token, account_id } = await createAccount();
    const res = await call("/v1/session", json({ token }, { Origin: ORIGIN }));
    expect(res.status).toBe(200);
    const sc = res.headers.get("set-cookie") ?? "";
    const c = attrs(sc);
    expect(c.name).toBe("__Host-ob_session");
    expect(c.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(c.attrs.has("httponly")).toBe(true);
    expect(c.attrs.has("secure")).toBe(true);
    expect(c.attrs.get("samesite")).toBe("Strict");
    expect(c.attrs.get("path")).toBe("/");
    expect(c.attrs.get("max-age")).toBe(String(30 * 86_400));
    expect(c.attrs.has("domain")).toBe(false);

    // Only the hash of the cookie value is stored.
    const row = await env.DB.prepare("SELECT * FROM sessions WHERE account_id = ?").bind(account_id).first<Record<string, unknown>>();
    expect(row?.id_hash).toBe(await sha256Hex(c.value));
    expect(JSON.stringify(row)).not.toContain(c.value);
    expect(Number(row?.expires_at) - Number(row?.created_at)).toBe(30 * 86_400_000);

    const body = (await res.json()) as Record<string, unknown>;
    expect(JSON.stringify(body)).not.toContain(token);
  });

  it("rejects a wrong token without setting a cookie", async () => {
    for (const token of ["ob_" + "Z".repeat(43), "nope", "", 42]) {
      const res = await call("/v1/session", json({ token }, { Origin: ORIGIN }));
      expect(res.status).toBe(401);
      expect(res.headers.get("set-cookie")).toBeNull();
    }
  });

  it("opens the panel with the cookie and redirects without it", async () => {
    const { token } = await createAccount();
    const cookie = await login(token);
    const page = await call("/app", { headers: { Cookie: cookie } });
    expect(page.status).toBe(200);
    expect(page.headers.get("cache-control")).toBe("no-store");
    const anon = await call("/app", { redirect: "manual" });
    expect(anon.status).toBe(303);
    expect(anon.headers.get("location")).toBe("/");
  });

  it("expires sessions after their lifetime", async () => {
    const { token, account_id } = await createAccount();
    const cookie = await login(token);
    await env.DB.prepare("UPDATE sessions SET expires_at = ? WHERE account_id = ?").bind(Date.now() - 1, account_id).run();
    expect((await call("/v1/me", { headers: { Cookie: cookie } })).status).toBe(401);
  });

  it("keeps at most 20 sessions per account", async () => {
    const { token, account_id } = await createAccount();
    for (let i = 0; i < 22; i++) await login(token);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM sessions WHERE account_id = ?").bind(account_id).first<{ n: number }>();
    expect(n?.n).toBe(20);
  });

  it("rate limits sign-in attempts per IP", async () => {
    const ip = freshIp();
    for (let i = 0; i < 20; i++) {
      const res = await call("/v1/session", { ...json({ token: "ob_" + "Q".repeat(43) }, { Origin: ORIGIN }), ip });
      expect(res.status).toBe(401);
    }
    const blocked = await call("/v1/session", { ...json({ token: "ob_" + "Q".repeat(43) }, { Origin: ORIGIN }), ip });
    expect(blocked.status).toBe(429);
  });
});

describe("DELETE /v1/session", () => {
  it("clears the cookie and ends the session", async () => {
    const { token } = await createAccount();
    const cookie = await login(token);
    const res = await call("/v1/session", { method: "DELETE", headers: { Cookie: cookie, Origin: ORIGIN } });
    expect(res.status).toBe(200);
    const c = attrs(res.headers.get("set-cookie") ?? "");
    expect(c.name).toBe("__Host-ob_session");
    expect(c.value).toBe("");
    expect(c.attrs.get("max-age")).toBe("0");
    expect((await call("/v1/me", { headers: { Cookie: cookie } })).status).toBe(401);
  });
});

describe("scheduled cleanup", () => {
  it("removes expired sessions and stale rate-limit windows", async () => {
    const { token, account_id } = await createAccount();
    await login(token);
    await login(token);
    await env.DB.prepare("UPDATE sessions SET expires_at = ? WHERE rowid IN (SELECT rowid FROM sessions WHERE account_id = ? LIMIT 1)")
      .bind(Date.now() - 1, account_id)
      .run();
    const old = Math.floor(Date.now() / 1000) - 3 * 86_400;
    await env.DB.prepare("INSERT INTO rate_limits (key, window_start, count) VALUES ('test:old:60', ?, 1)").bind(old).run();

    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController({ scheduledTime: new Date(), cron: "17 3 * * *" }), env, ctx);
    await waitOnExecutionContext(ctx);

    const s = await env.DB.prepare("SELECT COUNT(*) AS n FROM sessions WHERE account_id = ?").bind(account_id).first<{ n: number }>();
    expect(s?.n).toBe(1);
    const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM rate_limits WHERE key = 'test:old:60'").first<{ n: number }>();
    expect(r?.n).toBe(0);
  });
});
