import { describe, expect, it } from "vitest";
import { ORIGIN, bearer, call, createAccount, json, login } from "./helpers";

describe("CSRF protection for cookie-authenticated requests", () => {
  it("rejects state changes without a same-origin Origin", async () => {
    const { token } = await createAccount();
    const cookie = await login(token);
    const body = { url: "https://hooks.example.org/csrf" };
    const variants: Array<Record<string, string>> = [
      {},
      { Origin: "https://evil.example" },
      { Origin: "null" },
      { Origin: "http://freeband.cobanov.dev" },
      { Origin: "https://freeband.cobanov.dev.evil.example" },
      { "Sec-Fetch-Site": "cross-site" },
      { "Sec-Fetch-Site": "same-site" },
      { Origin: "https://evil.example", "Sec-Fetch-Site": "same-origin" },
    ];
    for (const extra of variants) {
      const res = await call("/v1/webhooks", json(body, { Cookie: cookie, ...extra }));
      expect(res.status, JSON.stringify(extra)).toBe(403);
      expect(((await res.json()) as { error: string }).error).toBe("cross_origin");
    }
    for (const [method, path] of [
      ["POST", "/v1/token/rotate"],
      ["DELETE", "/v1/account"],
      ["DELETE", "/v1/webhooks/2c1b8f8e-3a59-4c43-9d3f-4f1f2f0f8c11"],
      ["POST", "/v1/webhooks/2c1b8f8e-3a59-4c43-9d3f-4f1f2f0f8c11/test"],
    ]) {
      const res = await call(path as string, { method, headers: { Cookie: cookie, Origin: "https://evil.example" } });
      expect(res.status, `${method} ${path}`).toBe(403);
    }
    // Nothing changed: the account and token still work, no webhook was added.
    const hooks = (await (await call("/v1/webhooks", { headers: bearer(token) })).json()) as { webhooks: unknown[] };
    expect(hooks.webhooks).toEqual([]);
    expect((await call("/v1/me", { headers: { Cookie: cookie } })).status).toBe(200);
  });

  it("accepts same-origin requests from the panel", async () => {
    const { token } = await createAccount();
    const cookie = await login(token);
    const a = await call("/v1/webhooks", json({ url: "https://hooks.example.org/a" }, { Cookie: cookie, Origin: ORIGIN }));
    expect(a.status).toBe(201);
    const b = await call("/v1/webhooks", json({ url: "https://hooks.example.org/b" }, { Cookie: cookie, "Sec-Fetch-Site": "same-origin" }));
    expect(b.status).toBe(201);
    // Safe methods need no Origin.
    expect((await call("/v1/webhooks", { headers: { Cookie: cookie } })).status).toBe(200);
  });

  it("does not require Origin for bearer-token clients", async () => {
    const { token } = await createAccount();
    const res = await call("/v1/webhooks", json({ url: "https://hooks.example.org/bearer" }, bearer(token)));
    expect(res.status).toBe(201);
  });

  it("refuses cross-origin sign-in and sign-out", async () => {
    const { token } = await createAccount();
    const login1 = await call("/v1/session", json({ token }, { Origin: "https://evil.example" }));
    expect(login1.status).toBe(403);
    expect(login1.headers.get("set-cookie")).toBeNull();
    const login2 = await call("/v1/session", json({ token }));
    expect(login2.status).toBe(403);

    const cookie = await login(token);
    const out = await call("/v1/session", { method: "DELETE", headers: { Cookie: cookie, Origin: "https://evil.example" } });
    expect(out.status).toBe(403);
    expect((await call("/v1/me", { headers: { Cookie: cookie } })).status).toBe(200);
  });
});
