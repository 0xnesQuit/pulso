import { describe, expect, it } from "vitest";
import { DEV_A, DEV_B, battery, bearer, call, createAccount, env, ingest, live, syncBody } from "./helpers";

const T0 = Date.UTC(2026, 9, 10, 0, 0, 0);
const iso = (ms: number) => new Date(ms).toISOString().replace(".000Z", "Z");

describe("POST /v1/ingest", () => {
  it("accepts samples and ignores duplicates on (device, type, ts)", async () => {
    const { token } = await createAccount();
    const samples = [live("2026-10-13T20:59:41Z", 8421, 74), battery("2026-10-13T20:59:40Z", 46)];
    expect(await (await ingest(token, syncBody(samples))).json()).toEqual({ accepted: 2, duplicates: 0 });
    expect(await (await ingest(token, syncBody(samples))).json()).toEqual({ accepted: 0, duplicates: 2 });

    // Partial overlap: one new sample.
    const more = [...samples, live("2026-10-13T21:05:00Z", 8500, 80)];
    expect(await (await ingest(token, syncBody(more))).json()).toEqual({ accepted: 1, duplicates: 2 });

    // Same (type, ts) twice in one body counts once.
    const twice = [live("2026-10-13T22:00:00Z", 1, 60), live("2026-10-13T22:00:00Z", 2, 61)];
    expect(await (await ingest(token, syncBody(twice))).json()).toEqual({ accepted: 1, duplicates: 1 });

    // Same type and ts with a different type is a different sample.
    const otherType = [battery("2026-10-13T20:59:41Z", 45)];
    expect(await (await ingest(token, syncBody(otherType))).json()).toEqual({ accepted: 1, duplicates: 0 });
  });

  it("stores the same timestamp separately for each band", async () => {
    const { token } = await createAccount();
    const s = [live("2026-10-13T08:00:00Z", 1000, 70)];
    expect(await (await ingest(token, syncBody(s, { id: DEV_A }))).json()).toEqual({ accepted: 1, duplicates: 0 });
    expect(await (await ingest(token, syncBody(s, { id: DEV_B, model: "band10", name: "Band 10" }))).json()).toEqual({
      accepted: 1,
      duplicates: 0,
    });
    const all = (await (await call("/v1/samples", { headers: bearer(token) })).json()) as {
      samples: Array<{ device_id: string }>;
    };
    expect(all.samples.map((x) => x.device_id).sort()).toEqual([DEV_B, DEV_A].sort());
    const onlyB = (await (await call(`/v1/samples?device=${DEV_B}`, { headers: bearer(token) })).json()) as {
      samples: Array<{ device_id: string }>;
    };
    expect(onlyB.samples).toHaveLength(1);
    expect(onlyB.samples[0]?.device_id).toBe(DEV_B);
  });

  it("upserts devices and reports them in /v1/me", async () => {
    const { token } = await createAccount();
    await ingest(token, syncBody([live("2026-10-13T08:00:00Z", 1)], { id: DEV_A.toLowerCase(), name: "Eski ad" }));
    await ingest(token, syncBody([live("2026-10-13T09:00:00Z", 2)], { id: DEV_A, name: "Yeni ad" }));
    await ingest(token, syncBody([live("2026-10-13T09:00:00Z", 2)], { id: DEV_B, name: "Band 10 4F21", model: "band10" }));
    const me = (await (await call("/v1/me", { headers: bearer(token) })).json()) as {
      devices: Array<{ id: string; name: string; model: string; last_seen: string }>;
      samples: { live: number; total: number };
    };
    expect(me.devices).toHaveLength(2);
    const a = me.devices.find((d) => d.id === DEV_A);
    expect(a).toMatchObject({ id: DEV_A, name: "Yeni ad", model: "band10pro" });
    expect(Date.parse(a?.last_seen ?? "")).toBeGreaterThan(Date.now() - 60_000);
    expect(me.devices.find((d) => d.id === DEV_B)?.model).toBe("band10");
    expect(me.samples).toMatchObject({ live: 3, total: 3 });
  });

  it("updates the account time zone from the phone", async () => {
    const { token } = await createAccount({ tz: "Europe/Istanbul" });
    await ingest(token, syncBody([], { tz: "America/New_York" }));
    const me = (await (await call("/v1/me", { headers: bearer(token) })).json()) as { tz: string };
    expect(me.tz).toBe("America/New_York");
  });

  it("validates every field", async () => {
    const { token } = await createAccount();
    const base = () => syncBody([live("2026-10-13T10:00:00Z", 100, 70)]);
    const future = iso(Date.now() + 3 * 86_400_000);
    const mutations: Array<[string, (b: ReturnType<typeof base>) => void]> = [
      ["schema", (b) => ((b as Record<string, unknown>).schema = "freeband.v2")],
      ["event", (b) => ((b as Record<string, unknown>).event = "ping")],
      ["device missing", (b) => delete (b as Record<string, unknown>).device],
      ["device.id", (b) => (b.device.id = "AA:BB:CC:DD:EE:FF")],
      ["device.model", (b) => (b.device.model = "band9")],
      ["device.name empty", (b) => (b.device.name = "  ")],
      ["device.name long", (b) => (b.device.name = "x".repeat(101))],
      ["device.tz", (b) => (b.device.tz = "Not/AZone")],
      ["sent_at", (b) => ((b as Record<string, unknown>).sent_at = "yesterday")],
      ["summary.battery", (b) => ((b.summary as Record<string, unknown>).battery = 101)],
      ["summary.date", (b) => ((b.summary as Record<string, unknown>).date = "2026-13-01")],
      ["samples not array", (b) => ((b as Record<string, unknown>).samples = {})],
      ["type", (b) => ((b.samples[0] as Record<string, unknown>).type = "sleep")],
      ["heart_rate 251", (b) => ((b.samples[0] as Record<string, unknown>).heart_rate = 251)],
      ["heart_rate -1", (b) => ((b.samples[0] as Record<string, unknown>).heart_rate = -1)],
      ["heart_rate float", (b) => ((b.samples[0] as Record<string, unknown>).heart_rate = 74.5)],
      ["heart_rate string", (b) => ((b.samples[0] as Record<string, unknown>).heart_rate = "74")],
      ["steps negative", (b) => ((b.samples[0] as Record<string, unknown>).steps = -5)],
      ["steps missing", (b) => delete (b.samples[0] as Record<string, unknown>).steps],
      ["standing_hours", (b) => ((b.samples[0] as Record<string, unknown>).standing_hours = 25)],
      ["ts future", (b) => ((b.samples[0] as Record<string, unknown>).ts = future)],
      ["ts format", (b) => ((b.samples[0] as Record<string, unknown>).ts = "2026-10-13 10:00:00")],
      ["ts offset", (b) => ((b.samples[0] as Record<string, unknown>).ts = "2026-10-13T10:00:00+03:00")],
      ["ts overflow", (b) => ((b.samples[0] as Record<string, unknown>).ts = "2026-02-30T10:00:00Z")],
      ["ts ancient", (b) => ((b.samples[0] as Record<string, unknown>).ts = "2019-12-31T23:59:59Z")],
      ["level 101", (b) => (b.samples[0] = battery("2026-10-13T10:00:00Z", 101))],
      ["sample not object", (b) => ((b as { samples: unknown[] }).samples = [42])],
    ];
    for (const [name, mutate] of mutations) {
      const b = base();
      mutate(b);
      const res = await ingest(token, b);
      expect(res.status, name).toBe(400);
      expect(((await res.json()) as { error: string }).error, name).toBe("invalid_body");
    }
    // Nothing was stored by the rejected bodies.
    const me = (await (await call("/v1/me", { headers: bearer(token) })).json()) as { samples: { total: number }; devices: unknown[] };
    expect(me.samples.total).toBe(0);
    expect(me.devices).toEqual([]);
  });

  it("accepts boundary values", async () => {
    const { token } = await createAccount();
    const nearFuture = iso(Date.now() + 86_400_000);
    const s = [
      live("2026-10-13T10:00:00Z", 0, 0),
      live("2026-10-13T10:00:01Z", 200_000, 250),
      battery("2026-10-13T10:00:02Z", 0),
      battery("2026-10-13T10:00:03Z", 100),
      live(nearFuture, 1, 60),
      { type: "live", ts: "2026-10-13T10:00:04.250Z", steps: 1, calories: 0, heart_rate: 60 },
    ];
    expect(await (await ingest(token, syncBody(s))).json()).toEqual({ accepted: 6, duplicates: 0 });
  });

  it("enforces the 5000-sample and 512 KB limits", async () => {
    const { token } = await createAccount();
    const big = Array.from({ length: 5000 }, (_, i) => battery(iso(T0 + i * 1000), 50));
    const ok = await ingest(token, syncBody(big));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ accepted: 5000, duplicates: 0 });

    const tooMany = Array.from({ length: 5001 }, (_, i) => battery(iso(T0 + i * 1000), 50));
    const r1 = await ingest(token, syncBody(tooMany));
    expect(r1.status).toBe(413);
    expect(((await r1.json()) as { error: string }).error).toBe("too_many_samples");

    // > 512 KB with a Content-Length header.
    const padded = JSON.stringify(syncBody([live("2026-10-13T10:00:00Z", 1)])) + " ".repeat(512 * 1024);
    const r2 = await call("/v1/ingest", {
      method: "POST",
      headers: { ...bearer(token), "Content-Type": "application/json" },
      body: padded,
    });
    expect(r2.status).toBe(413);
    expect(((await r2.json()) as { error: string }).error).toBe("body_too_large");

    // > 512 KB streamed without a Content-Length header.
    const chunk = new TextEncoder().encode(" ".repeat(64 * 1024));
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent++ < 10) controller.enqueue(chunk);
        else controller.close();
      },
    });
    const r3 = await call("/v1/ingest", {
      method: "POST",
      headers: { ...bearer(token), "Content-Type": "application/json" },
      body: stream,
    });
    expect(r3.status).toBe(413);
  });

  it("requires a JSON content type and valid JSON", async () => {
    const { token } = await createAccount();
    const body = JSON.stringify(syncBody([]));
    const r1 = await call("/v1/ingest", { method: "POST", headers: { ...bearer(token), "Content-Type": "text/plain" }, body });
    expect(r1.status).toBe(415);
    const r2 = await call("/v1/ingest", { method: "POST", headers: { ...bearer(token), "Content-Type": "application/json" }, body: "{" });
    expect(r2.status).toBe(400);
    const r3 = await call("/v1/ingest", {
      method: "POST",
      headers: { ...bearer(token), "Content-Type": "application/json" },
      body: new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]),
    });
    expect(r3.status).toBe(400);
  });

  it("caps the number of bands per account", async () => {
    const { token } = await createAccount();
    for (let i = 0; i < 10; i++) {
      const id = `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
      expect((await ingest(token, syncBody([], { id }))).status).toBe(200);
    }
    const res = await ingest(token, syncBody([], { id: "00000000-0000-4000-8000-000000000099" }));
    expect(res.status).toBe(409);
    // A known band still syncs.
    expect((await ingest(token, syncBody([], { id: "00000000-0000-4000-8000-000000000003" }))).status).toBe(200);
  });

  it("rate limits ingest per token", async () => {
    const { token } = await createAccount();
    for (let i = 0; i < 120; i++) {
      const res = await ingest(token, syncBody([]));
      expect(res.status).toBe(200);
    }
    const blocked = await ingest(token, syncBody([]));
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).not.toBeNull();
    // Another account is not affected.
    const other = await createAccount();
    expect((await ingest(other.token, syncBody([]))).status).toBe(200);
  });

  it("writes each sample once with its account and device", async () => {
    const { token, account_id } = await createAccount();
    await ingest(token, syncBody([live("2026-10-13T10:00:00Z", 10, 70)], { id: DEV_B, model: "band10" }));
    const row = await env.DB.prepare("SELECT * FROM samples WHERE account_id = ?").bind(account_id).first();
    expect(row).toMatchObject({ device_id: DEV_B, type: "live", ts: Date.UTC(2026, 9, 13, 10), steps: 10, heart_rate: 70 });
  });
});
