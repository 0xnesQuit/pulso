import { describe, expect, it } from "vitest";
import { DEV_A, ORIGIN, battery, bearer, call, createAccount, env, ingest, json, live, login, syncBody } from "./helpers";

describe("cross-account isolation", () => {
  it("never shows one account's data to another", async () => {
    const a = await createAccount();
    const b = await createAccount();

    const samples = [live("2026-10-13T10:00:00Z", 5000, 80), battery("2026-10-13T10:00:01Z", 55)];
    expect((await ingest(a.token, syncBody(samples))).status).toBe(200);
    const hook = await call("/v1/webhooks", json({ url: "https://hooks.example.org/a" }, bearer(a.token)));
    expect(hook.status).toBe(201);
    const hookId = ((await hook.json()) as { id: string }).id;

    const asB = (path: string, init: RequestInit = {}) =>
      call(path, { ...init, headers: { ...bearer(b.token), ...(init.headers as Record<string, string>) } });

    const me = (await (await asB("/v1/me")).json()) as { devices: unknown[]; samples: { total: number } };
    expect(me.devices).toEqual([]);
    expect(me.samples.total).toBe(0);

    for (const path of ["/v1/samples", `/v1/samples?device=${DEV_A}`, `/v1/samples?device=${DEV_A.toLowerCase()}`]) {
      const s = (await (await asB(path)).json()) as { samples: unknown[] };
      expect(s.samples, path).toEqual([]);
    }
    const days = (await (await asB(`/v1/days?device=${DEV_A}&from=2026-10-01&to=2026-10-14`)).json()) as { days: unknown[] };
    expect(days.days).toEqual([]);

    const csv = await (await asB("/v1/export.csv")).text();
    expect(csv.trim().split("\n")).toHaveLength(1);
    const exp = (await (await asB("/v1/export.json")).json()) as { samples: unknown[]; devices: unknown[] };
    expect(exp.samples).toEqual([]);
    expect(exp.devices).toEqual([]);

    const hooks = (await (await asB("/v1/webhooks")).json()) as { webhooks: unknown[] };
    expect(hooks.webhooks).toEqual([]);
    expect((await asB(`/v1/webhooks/${hookId}`)).status).toBe(404);
    expect((await asB(`/v1/webhooks/${hookId}`, { method: "DELETE" })).status).toBe(404);
    expect((await asB(`/v1/webhooks/${hookId}/test`, { method: "POST" })).status).toBe(404);

    // A's data is intact.
    const aHooks = (await (await call("/v1/webhooks", { headers: bearer(a.token) })).json()) as { webhooks: unknown[] };
    expect(aHooks.webhooks).toHaveLength(1);
    const aSamples = (await (await call("/v1/samples", { headers: bearer(a.token) })).json()) as { samples: unknown[] };
    expect(aSamples.samples).toHaveLength(2);
  });

  it("keeps the same device id separate per account", async () => {
    const a = await createAccount();
    const b = await createAccount();
    const body = syncBody([live("2026-10-13T11:00:00Z", 100)]);
    expect(await (await ingest(a.token, body)).json()).toEqual({ accepted: 1, duplicates: 0 });
    // Same device id and timestamp in another account is not a duplicate there.
    expect(await (await ingest(b.token, syncBody([live("2026-10-13T11:00:00Z", 999)]))).json()).toEqual({
      accepted: 1,
      duplicates: 0,
    });
    const aRows = (await (await call("/v1/samples", { headers: bearer(a.token) })).json()) as { samples: Array<{ steps: number }> };
    expect(aRows.samples.map((s) => s.steps)).toEqual([100]);
  });

  it("scopes sessions to their own account", async () => {
    const a = await createAccount();
    const b = await createAccount();
    await ingest(a.token, syncBody([live("2026-10-13T12:00:00Z", 321)]));
    const cookieB = await login(b.token);
    const res = (await (await call("/v1/samples", { headers: { Cookie: cookieB } })).json()) as { samples: unknown[] };
    expect(res.samples).toEqual([]);
    const page = await (await call("/app", { headers: { Cookie: cookieB } })).text();
    expect(page).not.toContain("Xiaomi Smart Band 10 Pro D9B9");
  });

  it("deleting or rotating one account leaves the other untouched", async () => {
    const a = await createAccount();
    const b = await createAccount();
    await ingest(a.token, syncBody([live("2026-10-13T13:00:00Z", 1)]));
    await ingest(b.token, syncBody([live("2026-10-13T13:00:00Z", 2)]));
    expect((await call("/v1/token/rotate", { method: "POST", headers: bearer(b.token) })).status).toBe(200);
    const cookieA = await login(a.token);
    expect((await call("/v1/account", { method: "DELETE", headers: { Cookie: cookieA, Origin: ORIGIN } })).status).toBe(200);
    const left = await env.DB.prepare("SELECT account_id, steps FROM samples").all<{ account_id: string; steps: number }>();
    expect(left.results.filter((r) => r.account_id === a.account_id)).toEqual([]);
    expect(left.results.filter((r) => r.account_id === b.account_id).map((r) => r.steps)).toEqual([2]);
  });
});
