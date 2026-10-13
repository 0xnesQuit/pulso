import { describe, expect, it } from "vitest";
import { ORIGIN, bearer, call, createAccount, ingest, json, live, login, syncBody } from "./helpers";

const PROTECTED: Array<[string, string]> = [
  ["GET", "/v1/me"],
  ["GET", "/v1/samples"],
  ["GET", "/v1/days"],
  ["GET", "/v1/export.csv"],
  ["GET", "/v1/export.json"],
  ["GET", "/v1/webhooks"],
  ["POST", "/v1/webhooks"],
  ["DELETE", "/v1/webhooks/2c1b8f8e-3a59-4c43-9d3f-4f1f2f0f8c11"],
  ["POST", "/v1/webhooks/2c1b8f8e-3a59-4c43-9d3f-4f1f2f0f8c11/test"],
  ["POST", "/v1/ingest"],
  ["POST", "/v1/token/rotate"],
  ["DELETE", "/v1/account"],
];

describe("authentication failures", () => {
  it("rejects every protected endpoint without credentials", async () => {
    for (const [method, path] of PROTECTED) {
      const res = await call(path, { method });
      expect(res.status, `${method} ${path}`).toBe(401);
      expect(res.headers.get("www-authenticate")).toContain("Bearer");
      expect(((await res.json()) as { error: string }).error).toBe("unauthorized");
    }
  });

  it("rejects malformed, unknown and wrong-scheme tokens", async () => {
    const { token } = await createAccount();
    const unknown = "ob_" + "A".repeat(43);
    const headers = [
      "Bearer",
      "Bearer ",
      `Basic ${btoa("user:" + token)}`,
      `Token ${token}`,
      `Bearer ${token.slice(0, -1)}`,
      `Bearer ${token}x`,
      `Bearer ${token.slice(3)}`,
      `Bearer ${unknown}`,
      `Bearer ${token} extra`,
    ];
    for (const h of headers) {
      const res = await call("/v1/me", { headers: { Authorization: h } });
      expect(res.status, h).toBe(401);
    }
    const ok = await call("/v1/me", { headers: { Authorization: `bearer ${token}` } });
    expect(ok.status).toBe(200);
  });

  it("does not accept the web session cookie for ingest", async () => {
    const { token } = await createAccount();
    const cookie = await login(token);
    const res = await call("/v1/ingest", json(syncBody([live("2026-10-13T10:00:00Z", 10)]), { Cookie: cookie, Origin: ORIGIN }));
    expect(res.status).toBe(401);
    // ...but the token works.
    expect((await ingest(token, syncBody([live("2026-10-13T10:00:00Z", 10)]))).status).toBe(200);
  });

  it("does not fall back to the cookie when an Authorization header is invalid", async () => {
    const { token } = await createAccount();
    const cookie = await login(token);
    const res = await call("/v1/me", { headers: { Cookie: cookie, Authorization: "Bearer ob_wrong" } });
    expect(res.status).toBe(401);
    const viaCookie = await call("/v1/me", { headers: { Cookie: cookie } });
    expect(viaCookie.status).toBe(200);
  });

  it("rejects forged or malformed session cookies", async () => {
    for (const cookie of [
      "__Host-ob_session=" + "A".repeat(43),
      "__Host-ob_session=short",
      "__Host-ob_session=" + "A".repeat(43) + "';--",
      "ob_session=" + "A".repeat(43),
    ]) {
      const res = await call("/v1/me", { headers: { Cookie: cookie } });
      expect(res.status, cookie).toBe(401);
    }
  });

  it("keeps working with a valid token after failures", async () => {
    const { token } = await createAccount();
    await call("/v1/me", { headers: bearer("ob_" + "B".repeat(43)) });
    expect((await call("/v1/me", { headers: bearer(token) })).status).toBe(200);
  });
});
