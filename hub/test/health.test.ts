// Phase 5 health data: minute, sleep and score samples, upserts, the new read
// endpoints, /v1/days aggregation, exports, sync.partial and the 30–220 bpm rule.

import { afterEach, describe, expect, it, vi } from "vitest";
import { DEV_A, DEV_B, ORIGIN, battery, bearer, call, createAccount, env, hmacHex, ingest, json, live, login, syncBody } from "./helpers";

type Obj = Record<string, unknown>;

function minute(ts: string, steps: number, extra: Obj = {}): Obj {
  return { type: "minute", ts, steps, ...extra };
}

function sleep(ts: string, end: string, extra: Obj = {}): Obj {
  return {
    type: "sleep",
    ts,
    end,
    is_nap: false,
    minutes: { deep: 80, light: 240, rem: 90, awake: 20 },
    wake_count: 3,
    efficiency: 95,
    stages: [
      [0, "light", 20],
      [20, "deep", 40],
      [60, "rem", 30],
    ],
    hr_min: 48,
    spo2_avg: 96.4,
    spo2_min: 91,
    hrv_rmssd: 42,
    ...extra,
  };
}

function score(date: string, ts: string, extra: Obj = {}): Obj {
  return {
    type: "score",
    ts,
    date,
    sleep: 82,
    recovery: 64,
    strain: 11.4,
    rhr: 54,
    hrv_rmssd: 41.5,
    confidence: { sleep: "high", recovery: "medium", strain: "low" },
    contributors: [
      { score: "sleep", key: "duration", weight: 35, value: 431, unit: "min", subscore: 88, baseline: 418 },
      { score: "recovery", key: "hrv", weight: 40, value: null, subscore: null, note: "RR yok" },
    ],
    algo: "freeband-score/1",
    ...extra,
  };
}

async function getJson<T = Obj>(token: string, path: string): Promise<T> {
  const res = await call(path, { headers: bearer(token) });
  expect(res.status, path).toBe(200);
  return (await res.json()) as T;
}

async function ingestOk(token: string, samples: unknown[], device: Obj = {}, extra: Obj = {}) {
  const res = await ingest(token, { ...syncBody(samples, device), ...extra });
  const body = (await res.json()) as Obj;
  expect(res.status, JSON.stringify(body)).toBe(200);
  return body;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ingest of minute, sleep and score", () => {
  it("accepts each type and stores it with its account and device", async () => {
    const { token, account_id } = await createAccount();
    const body = [
      minute("2026-10-13T07:42:00Z", 112, { heart_rate: 96, spo2: 97, stress: 34, active_calories: 6, distance_m: 84 }),
      minute("2026-10-13T07:43:00Z", 0, { heart_rate: 71 }),
      sleep("2026-10-12T20:41:00Z", "2026-10-13T04:12:00Z"),
      score("2026-10-13", "2026-10-12T21:00:00Z"),
      live("2026-10-13T08:00:00Z", 900, 75),
    ];
    expect(await ingestOk(token, body)).toEqual({ accepted: 5, duplicates: 0 });

    const m = await env.DB.prepare("SELECT * FROM minutes WHERE account_id = ? ORDER BY ts").bind(account_id).all();
    expect(m.results).toHaveLength(2);
    expect(m.results[0]).toMatchObject({
      device_id: DEV_A,
      ts: Date.UTC(2026, 9, 13, 7, 42),
      steps: 112,
      heart_rate: 96,
      spo2: 97,
      stress: 34,
      active_calories: 6,
      distance_m: 84,
    });
    expect(m.results[1]).toMatchObject({ steps: 0, heart_rate: 71, spo2: null, stress: null });

    const s = await env.DB.prepare("SELECT * FROM sleeps WHERE account_id = ?").bind(account_id).first();
    expect(s).toMatchObject({
      device_id: DEV_A,
      ts: Date.UTC(2026, 9, 12, 20, 41),
      end_ts: Date.UTC(2026, 9, 13, 4, 12),
      is_nap: 0,
      deep_min: 80,
      light_min: 240,
      rem_min: 90,
      awake_min: 20,
      efficiency: 95,
      hr_min: 48,
      spo2_avg: 96.4,
      spo2_min: 91,
      hrv_rmssd: 42,
    });
    expect(JSON.parse(String(s?.stages))).toEqual([
      [0, "light", 20],
      [20, "deep", 40],
      [60, "rem", 30],
    ]);

    const sc = await env.DB.prepare("SELECT * FROM scores WHERE account_id = ?").bind(account_id).first();
    expect(sc).toMatchObject({
      device_id: DEV_A,
      date: "2026-10-13",
      ts: Date.UTC(2026, 9, 12, 21),
      sleep_score: 82,
      recovery_score: 64,
      strain_score: 11.4,
      conf_recovery: "medium",
      algo: "freeband-score/1",
    });

    const me = await getJson<{ samples: Obj }>(token, "/v1/me");
    expect(me.samples).toEqual({ live: 1, battery: 0, minute: 2, sleep: 1, score: 1, total: 5 });
  });

  it("validates every new field", async () => {
    const { token } = await createAccount();
    const M = "2026-10-13T07:42:00Z";
    const S = () => sleep("2026-10-12T20:41:00Z", "2026-10-13T04:12:00Z");
    const C = () => score("2026-10-13", "2026-10-12T21:00:00Z");
    const cases: Array<[string, Obj | Obj[]]> = [
      ["minute ts seconds", minute("2026-10-13T07:42:30Z", 1)],
      ["minute ts ms", minute("2026-10-13T07:42:00.500Z", 1)],
      ["minute steps missing", { type: "minute", ts: M }],
      ["minute steps 1001", minute(M, 1001)],
      ["minute steps negative", minute(M, -1)],
      ["minute hr 0", minute(M, 1, { heart_rate: 0 })],
      ["minute hr 29", minute(M, 1, { heart_rate: 29 })],
      ["minute hr 221", minute(M, 1, { heart_rate: 221 })],
      ["minute hr float", minute(M, 1, { heart_rate: 70.5 })],
      ["minute spo2 69", minute(M, 1, { spo2: 69 })],
      ["minute spo2 101", minute(M, 1, { spo2: 101 })],
      ["minute stress 0", minute(M, 1, { stress: 0 })],
      ["minute stress 101", minute(M, 1, { stress: 101 })],
      ["minute kcal 101", minute(M, 1, { active_calories: 101 })],
      ["minute distance 1001", minute(M, 1, { distance_m: 1001 })],
      ["sleep end missing", { ...S(), end: undefined }],
      ["sleep end before ts", { ...S(), end: "2026-10-12T20:40:00Z" }],
      ["sleep longer than 24h", { ...S(), end: "2026-10-13T20:42:00Z" }],
      ["sleep is_nap string", { ...S(), is_nap: "no" }],
      ["sleep minutes missing", { ...S(), minutes: undefined }],
      ["sleep minutes.deep negative", { ...S(), minutes: { deep: -1, light: 0, rem: 0, awake: 0 } }],
      ["sleep minutes over a day", { ...S(), minutes: { deep: 600, light: 600, rem: 200, awake: 41 } }],
      ["sleep wake_count", { ...S(), wake_count: 256 }],
      ["sleep efficiency", { ...S(), efficiency: 101 }],
      ["sleep efficiency missing", { ...S(), efficiency: undefined }],
      ["sleep stages missing", { ...S(), stages: undefined }],
      ["sleep stage name", { ...S(), stages: [[0, "dream", 10]] }],
      ["sleep stage shape", { ...S(), stages: [[0, "deep"]] }],
      ["sleep stage zero length", { ...S(), stages: [[0, "deep", 0]] }],
      ["sleep stage outside session", { ...S(), stages: [[400, "deep", 200]] }],
      ["sleep stages unsorted", { ...S(), stages: [[30, "deep", 10], [0, "light", 10]] }],
      ["sleep hr_min 29", { ...S(), hr_min: 29 }],
      ["sleep spo2_avg 69.9", { ...S(), spo2_avg: 69.9 }],
      ["sleep spo2_min above avg", { ...S(), spo2_avg: 92, spo2_min: 95 }],
      ["sleep hrv 0", { ...S(), hrv_rmssd: 0 }],
      ["sleep hrv 301", { ...S(), hrv_rmssd: 301 }],
      ["score date", { ...C(), date: "2026-02-30" }],
      ["score ts far from midnight", { ...C(), ts: "2026-10-13T15:00:00Z" }],
      ["score ts a day off", { ...C(), ts: "2026-10-11T21:00:00Z" }],
      ["score sleep 101", { ...C(), sleep: 101 }],
      ["score recovery -1", { ...C(), recovery: -1 }],
      ["score strain 21.5", { ...C(), strain: 21.5 }],
      ["score rhr 25", { ...C(), rhr: 25 }],
      ["score confidence missing", { ...C(), confidence: undefined }],
      ["score confidence value", { ...C(), confidence: { sleep: "great", recovery: "low", strain: "low" } }],
      ["score contributors missing", { ...C(), contributors: undefined }],
      ["score contributor key", { ...C(), contributors: [{ key: "Duration" }] }],
      ["score contributor weight", { ...C(), contributors: [{ key: "duration", weight: 101 }] }],
      ["score contributor score", { ...C(), contributors: [{ key: "duration", score: "mood" }] }],
      ["score contributors > 32", { ...C(), contributors: Array.from({ length: 33 }, () => ({ key: "x" })) }],
      ["score algo missing", { ...C(), algo: undefined }],
      ["score algo spaces", { ...C(), algo: "my algo" }],
      ["type not a string", { type: 7, ts: M }],
      ["type uppercase", { type: "Minute", ts: M, steps: 1 }],
    ];
    for (const [name, sample] of cases) {
      const res = await ingest(token, syncBody(Array.isArray(sample) ? sample : [sample]));
      expect(res.status, name).toBe(400);
      expect(((await res.json()) as { error: string }).error, name).toBe("invalid_body");
    }
    const bad = await ingest(token, { ...syncBody([]), event: "sync.failed" });
    expect(bad.status).toBe(400);

    const me = await getJson<{ samples: { total: number } }>(token, "/v1/me");
    expect(me.samples.total).toBe(0);
  });

  it("accepts boundary values and nulls for unmeasured fields", async () => {
    const { token } = await createAccount({ tz: "Pacific/Kiritimati" });
    const res = await ingestOk(token, [
      minute("2026-10-13T00:00:00Z", 0, { heart_rate: 30, spo2: 70, stress: 1, active_calories: 0, distance_m: 0 }),
      minute("2026-10-13T00:01:00Z", 1000, { heart_rate: 220, spo2: 100, stress: 100, active_calories: 100, distance_m: 1000 }),
      minute("2026-10-13T00:02:00Z", 5, { heart_rate: null, spo2: null }),
      sleep("2026-10-12T13:00:00Z", "2026-10-12T14:00:00Z", {
        is_nap: true,
        minutes: { deep: 0, light: 60, rem: 0, awake: 0 },
        stages: [[0, "light", 60]],
        efficiency: 100,
        hr_min: null,
        spo2_avg: null,
        spo2_min: null,
        hrv_rmssd: undefined,
      }),
      sleep("2026-10-11T13:00:00Z", "2026-10-12T13:00:00Z", { stages: [], efficiency: 0, wake_count: 0 }),
      // Local midnight of 13 Oct in UTC+14 is 12 Oct 10:00Z.
      score("2026-10-13", "2026-10-12T10:00:00Z", { sleep: null, recovery: null, strain: 21, rhr: null, hrv_rmssd: null, contributors: [] }),
      score("2026-10-14", "2026-10-13T10:00:00Z", { strain: 0, sleep: 0, recovery: 100 }),
    ]);
    expect(res).toEqual({ accepted: 7, duplicates: 0 });

    const sl = await getJson<{ sleep: Obj[] }>(token, "/v1/sleep");
    const nap = sl.sleep.find((x) => x.is_nap === true) as Obj;
    expect(nap).toMatchObject({ hr_min: null, spo2_avg: null, spo2_min: null });
    expect(nap).not.toHaveProperty("hrv_rmssd");
    const m = await getJson<{ minutes: Obj[] }>(token, "/v1/minutes");
    expect(m.minutes[2]).toEqual({ device_id: DEV_A, type: "minute", ts: "2026-10-13T00:02:00Z", steps: 5 });
  });

  it("ignores sample types it does not know and keeps them out of webhooks", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("ok"));
    const { token } = await createAccount();
    const hook = await call("/v1/webhooks", json({ url: "https://hooks.example.org/h" }, bearer(token)));
    expect(hook.status).toBe(201);
    const res = await ingestOk(token, [
      { type: "workout", ts: "garbage", anything: true },
      minute("2026-10-13T07:42:00Z", 3),
      { type: "temperature.skin", value: 33.1 },
    ]);
    expect(res).toEqual({ accepted: 1, duplicates: 0, ignored: 2 });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    const sent = JSON.parse(new TextDecoder().decode(init.body as Uint8Array)) as { samples: Obj[] };
    expect(sent.samples).toEqual([{ type: "minute", ts: "2026-10-13T07:42:00Z", steps: 3 }]);
  });
});

describe("upserts", () => {
  it("overwrites minute, sleep and score on (device, type, ts) and counts unchanged rows as duplicates", async () => {
    const { token } = await createAccount();
    const T = "2026-10-13T07:42:00Z";
    const night = () => sleep("2026-10-12T20:41:00Z", "2026-10-13T04:12:00Z");
    const day = () => score("2026-10-13", "2026-10-12T21:00:00Z");
    const first = [minute(T, 10, { heart_rate: 70 }), night(), day()];
    expect(await ingestOk(token, first)).toEqual({ accepted: 3, duplicates: 0 });
    // The same rows again change nothing.
    expect(await ingestOk(token, first)).toEqual({ accepted: 0, duplicates: 3 });

    // Last write wins, and the whole row is replaced: heart_rate is gone.
    const second = [
      minute(T, 12),
      { ...night(), efficiency: 88, stages: [[0, "deep", 30]], hrv_rmssd: undefined },
      { ...day(), recovery: 71, confidence: { sleep: "high", recovery: "high", strain: "none" }, algo: "freeband-score/2" },
    ];
    expect(await ingestOk(token, second)).toEqual({ accepted: 3, duplicates: 0 });

    const m = await getJson<{ minutes: Obj[] }>(token, "/v1/minutes");
    expect(m.minutes).toEqual([{ device_id: DEV_A, type: "minute", ts: T, steps: 12 }]);
    const s = await getJson<{ sleep: Obj[] }>(token, "/v1/sleep");
    expect(s.sleep).toHaveLength(1);
    expect(s.sleep[0]).toMatchObject({ efficiency: 88, stages: [[0, "deep", 30]] });
    expect(s.sleep[0]).not.toHaveProperty("hrv_rmssd");
    const sc = await getJson<{ scores: Obj[] }>(token, "/v1/scores");
    expect(sc.scores).toHaveLength(1);
    expect(sc.scores[0]).toMatchObject({ recovery: 71, algo: "freeband-score/2", confidence: { strain: "none" } });

    // Within one body the last occurrence wins.
    expect(await ingestOk(token, [minute(T, 20), minute(T, 21)])).toEqual({ accepted: 1, duplicates: 1 });
    const m2 = await getJson<{ minutes: Obj[] }>(token, "/v1/minutes");
    expect(m2.minutes.map((x) => x.steps)).toEqual([21]);

    // live and battery stay insert-or-ignore: the first value is kept.
    expect(await ingestOk(token, [live(T, 100, 70), battery(T, 50)])).toEqual({ accepted: 2, duplicates: 0 });
    expect(await ingestOk(token, [live(T, 999, 99), battery(T, 10)])).toEqual({ accepted: 0, duplicates: 2 });
    const samples = await getJson<{ samples: Obj[] }>(token, "/v1/samples");
    expect(samples.samples.map((x) => x.steps ?? x.level)).toEqual([50, 100]);
  });

  it("forwards sync.partial with its own event header, and an unchanged re-send not at all", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("ok"));
    const { token } = await createAccount();
    const hookRes = await call("/v1/webhooks", json({ url: "https://hooks.example.org/p" }, bearer(token)));
    const hook = (await hookRes.json()) as { secret: string };
    const samples = [minute("2026-10-13T07:42:00Z", 3, { heart_rate: 88 }), score("2026-10-13", "2026-10-12T21:00:00Z")];
    const body = { ...syncBody(samples), event: "sync.partial" };
    expect(await (await ingest(token, body)).json()).toEqual({ accepted: 2, duplicates: 0 });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    const headers = new Headers(init.headers);
    const bytes = init.body as Uint8Array;
    expect(headers.get("x-freeband-event")).toBe("sync.partial");
    expect(headers.get("x-freeband-signature")).toBe("sha256=" + (await hmacHex(hook.secret, bytes)));
    // The validated body is forwarded unchanged.
    expect(JSON.parse(new TextDecoder().decode(bytes))).toEqual(body);

    await ingest(token, { ...syncBody(samples), event: "sync.completed" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    await ingest(token, syncBody([minute("2026-10-13T07:42:00Z", 4, { heart_rate: 88 })]));
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(new Headers((fetchSpy.mock.calls[1]?.[1] as RequestInit).headers).get("x-freeband-event")).toBe("sync.completed");
  });
});

describe("account and device isolation", () => {
  it("keeps health rows per account and per band", async () => {
    const a = await createAccount();
    const b = await createAccount();
    const T = "2026-10-13T07:42:00Z";
    const rows = (steps: number) => [
      minute(T, steps),
      sleep("2026-10-12T20:41:00Z", "2026-10-13T04:12:00Z", { wake_count: steps % 10 }),
      score("2026-10-13", "2026-10-12T21:00:00Z", { sleep: steps % 100 }),
    ];
    expect(await ingestOk(a.token, rows(11))).toEqual({ accepted: 3, duplicates: 0 });
    // Same device id and keys in another account are new rows there, and do not touch A's.
    expect(await ingestOk(b.token, rows(22))).toEqual({ accepted: 3, duplicates: 0 });
    // A second band in A with the same timestamps.
    expect(await ingestOk(a.token, rows(33), { id: DEV_B, model: "band10", name: "Band 10" })).toEqual({ accepted: 3, duplicates: 0 });

    const aMin = await getJson<{ minutes: Obj[] }>(a.token, "/v1/minutes");
    expect(aMin.minutes.map((m) => [m.device_id, m.steps])).toEqual(
      [
        [DEV_A, 11],
        [DEV_B, 33],
      ].sort((x, y) => String(x[0]).localeCompare(String(y[0]))),
    );
    const onlyB = await getJson<{ minutes: Obj[]; sleep: Obj[] }>(a.token, `/v1/minutes?device=${DEV_B.toLowerCase()}`);
    expect(onlyB.minutes.map((m) => m.steps)).toEqual([33]);
    const bMin = await getJson<{ minutes: Obj[] }>(b.token, "/v1/minutes");
    expect(bMin.minutes.map((m) => m.steps)).toEqual([22]);
    const bSleep = await getJson<{ sleep: Obj[] }>(b.token, "/v1/sleep");
    expect(bSleep.sleep.map((s) => s.wake_count)).toEqual([2]);
    const aScores = await getJson<{ scores: Obj[] }>(a.token, `/v1/scores?device=${DEV_A}`);
    expect(aScores.scores.map((s) => s.sleep)).toEqual([11]);

    // A third account sees nothing anywhere.
    const c = await createAccount();
    for (const path of ["/v1/minutes", "/v1/sleep", "/v1/scores", `/v1/minutes?device=${DEV_A}`]) {
      const r = await getJson<Obj>(c.token, path);
      const list = (r.minutes ?? r.sleep ?? r.scores) as unknown[];
      expect(list, path).toEqual([]);
    }
    const cDays = await getJson<{ days: unknown[] }>(c.token, "/v1/days?from=2026-10-01&to=2026-10-14");
    expect(cDays.days).toEqual([]);
    const cExport = await getJson<{ minutes: unknown[]; sleep: unknown[]; scores: unknown[] }>(c.token, "/v1/export.json");
    expect([cExport.minutes, cExport.sleep, cExport.scores]).toEqual([[], [], []]);
    const cookieC = await login(c.token);
    const page = await (await call("/app", { headers: { Cookie: cookieC } })).text();
    expect(page).toContain("Henüz veri gelmedi.");

    // Deleting A removes its health rows and leaves B's.
    const cookieA = await login(a.token);
    expect((await call("/v1/account", { method: "DELETE", headers: { Cookie: cookieA, Origin: ORIGIN } })).status).toBe(200);
    for (const table of ["minutes", "sleeps", "scores"]) {
      const left = await env.DB.prepare(`SELECT account_id FROM ${table} WHERE account_id IN (?, ?)`)
        .bind(a.account_id, b.account_id)
        .all<{ account_id: string }>();
      expect(left.results.map((r) => r.account_id), table).toEqual([b.account_id]);
    }
  });
});

describe("GET /v1/minutes, /v1/sleep, /v1/scores", () => {
  it("pages minutes with limit, next and after, without gaps across bands", async () => {
    const { token } = await createAccount();
    const ts = Array.from({ length: 15 }, (_, i) => new Date(Date.UTC(2026, 9, 13, 6, i)).toISOString().replace(".000Z", "Z"));
    await ingestOk(token, ts.map((t, i) => minute(t, i)), { id: DEV_A });
    await ingestOk(token, ts.map((t, i) => minute(t, 100 + i)), { id: DEV_B, model: "band10", name: "Band 10" });

    const seen: string[] = [];
    let after = "";
    for (let page = 0; page < 10; page++) {
      const r = await getJson<{ minutes: Obj[]; has_more: boolean; next: string | null }>(
        token,
        `/v1/minutes?limit=7${after ? `&after=${after}` : ""}`,
      );
      seen.push(...r.minutes.map((m) => `${m.ts} ${m.device_id}`));
      if (!r.has_more) {
        expect(r.next).toBeNull();
        break;
      }
      expect(r.minutes).toHaveLength(7);
      after = r.next ?? "";
    }
    expect(seen).toHaveLength(30);
    expect(new Set(seen).size).toBe(30);
    expect(seen).toEqual([...seen].sort());

    const range = await getJson<{ minutes: Obj[] }>(token, `/v1/minutes?device=${DEV_A}&from=2026-10-13T06:05:00Z&to=2026-10-13T06:08:00Z`);
    expect(range.minutes.map((m) => m.steps)).toEqual([5, 6, 7]);
    const def = await getJson<{ minutes: Obj[]; has_more: boolean }>(token, "/v1/minutes");
    expect(def.minutes).toHaveLength(30);
    expect(def.has_more).toBe(false);

    for (const q of ["limit=0", "limit=5001", "after=nope", "after=123_xyz", "from=yesterday", "device=abc", "from=2026-10-10&to=2026-10-01"]) {
      expect((await call(`/v1/minutes?${q}`, { headers: bearer(token) })).status, q).toBe(400);
    }
  });

  it("filters sleep by wake time in the account's time zone", async () => {
    const { token } = await createAccount({ tz: "Europe/Istanbul" });
    await ingestOk(token, [
      // 23:30 on 12 Oct → 07:00 on 13 Oct local: the night of 13 Oct.
      sleep("2026-10-12T20:30:00Z", "2026-10-13T04:00:00Z"),
      // A nap on 13 Oct local.
      sleep("2026-10-13T11:00:00Z", "2026-10-13T11:40:00Z", { is_nap: true, minutes: { deep: 0, light: 35, rem: 0, awake: 5 }, stages: [[0, "light", 35]] }),
      // Ends at 00:30 on 14 Oct local.
      sleep("2026-10-13T19:00:00Z", "2026-10-13T21:30:00Z", { stages: [] }),
    ]);
    const r = await getJson<{ sleep: Obj[]; has_more: boolean }>(token, "/v1/sleep?from=2026-10-13&to=2026-10-13");
    expect(r.sleep.map((s) => [s.ts, s.end, s.is_nap])).toEqual([
      ["2026-10-12T20:30:00Z", "2026-10-13T04:00:00Z", false],
      ["2026-10-13T11:00:00Z", "2026-10-13T11:40:00Z", true],
    ]);
    expect(r.sleep[0]).toEqual({
      device_id: DEV_A,
      type: "sleep",
      ts: "2026-10-12T20:30:00Z",
      end: "2026-10-13T04:00:00Z",
      is_nap: false,
      minutes: { deep: 80, light: 240, rem: 90, awake: 20 },
      wake_count: 3,
      efficiency: 95,
      stages: [
        [0, "light", 20],
        [20, "deep", 40],
        [60, "rem", 30],
      ],
      hr_min: 48,
      spo2_avg: 96.4,
      spo2_min: 91,
      hrv_rmssd: 42,
    });
    const p1 = await getJson<{ sleep: Obj[]; has_more: boolean; next: string }>(token, "/v1/sleep?limit=2");
    expect(p1.has_more).toBe(true);
    const p2 = await getJson<{ sleep: Obj[]; has_more: boolean }>(token, `/v1/sleep?limit=2&after=${p1.next}`);
    expect(p2.sleep.map((s) => s.end)).toEqual(["2026-10-13T21:30:00Z"]);
    expect(p2.has_more).toBe(false);
    expect((await call("/v1/sleep?limit=1001", { headers: bearer(token) })).status).toBe(400);
  });

  it("lists scores by date", async () => {
    const { token } = await createAccount({ tz: "Europe/Istanbul" });
    await ingestOk(token, [
      score("2026-10-11", "2026-10-10T21:00:00Z", { sleep: 70 }),
      score("2026-10-12", "2026-10-11T21:00:00Z", { sleep: 71 }),
      score("2026-10-13", "2026-10-12T21:00:00Z", { sleep: 72 }),
    ]);
    await ingestOk(token, [score("2026-10-12", "2026-10-11T21:00:00Z", { sleep: 50 })], { id: DEV_B, model: "band10", name: "Band 10" });

    const r = await getJson<{ scores: Obj[] }>(token, "/v1/scores?from=2026-10-12&to=2026-10-13");
    expect(r.scores.map((s) => [s.date, s.device_id, s.sleep])).toEqual(
      [
        ["2026-10-12", DEV_A, 71],
        ["2026-10-12", DEV_B, 50],
        ["2026-10-13", DEV_A, 72],
      ].sort((x, y) => `${x[0]}${x[1]}`.localeCompare(`${y[0]}${y[1]}`)),
    );
    expect(r.scores.find((s) => s.date === "2026-10-13")).toEqual({
      device_id: DEV_A,
      type: "score",
      ts: "2026-10-12T21:00:00Z",
      date: "2026-10-13",
      sleep: 72,
      recovery: 64,
      strain: 11.4,
      rhr: 54,
      hrv_rmssd: 41.5,
      confidence: { sleep: "high", recovery: "medium", strain: "low" },
      contributors: [
        { score: "sleep", key: "duration", weight: 35, value: 431, unit: "min", subscore: 88, baseline: 418 },
        { score: "recovery", key: "hrv", weight: 40, value: null, subscore: null, note: "RR yok" },
      ],
      algo: "freeband-score/1",
    });
    const p1 = await getJson<{ scores: Obj[]; next: string }>(token, "/v1/scores?limit=2");
    const p2 = await getJson<{ scores: Obj[]; has_more: boolean }>(token, `/v1/scores?limit=2&after=${p1.next}`);
    expect([...p1.scores, ...p2.scores]).toHaveLength(4);
    expect(p2.has_more).toBe(false);
    for (const q of ["from=2026-10-13T00:00:00Z", "to=13-10-2026", "from=2026-10-14&to=2026-10-01", "limit=1001", "after=2026-10-12"]) {
      expect((await call(`/v1/scores?${q}`, { headers: bearer(token) })).status, q).toBe(400);
    }
  });
});

describe("GET /v1/days with health data", () => {
  it("adds sleep, naps, scores and minute data around midnight in Europe/Istanbul", async () => {
    const { token } = await createAccount({ tz: "Europe/Istanbul" });
    await ingestOk(token, [
      minute("2026-10-12T20:59:00Z", 50, { heart_rate: 60 }), // 23:59 on 12 Oct local
      minute("2026-10-12T21:00:00Z", 30, { heart_rate: 100 }), // 00:00 on 13 Oct local
      minute("2026-10-13T20:59:00Z", 20, { heart_rate: 80 }), // 23:59 on 13 Oct local
      minute("2026-10-13T21:00:00Z", 7), // 00:00 on 14 Oct local
      // Live: cumulative 40 steps is below the minute sum (50); HR 0, 25 and 240 are not readings.
      live("2026-10-13T09:00:00Z", 40, 0),
      live("2026-10-13T09:01:00Z", 40, 25),
      live("2026-10-13T09:02:00Z", 40, 240),
      live("2026-10-13T09:03:00Z", 40, 90),
      battery("2026-10-13T09:00:00Z", 77),
      // The night of 13 Oct (wake 07:00 local) and a nap.
      sleep("2026-10-12T20:30:00Z", "2026-10-13T04:00:00Z"),
      sleep("2026-10-13T11:00:00Z", "2026-10-13T11:40:00Z", { is_nap: true, minutes: { deep: 0, light: 35, rem: 0, awake: 5 }, stages: [] }),
      // Wakes at 00:30 on 14 Oct local.
      sleep("2026-10-13T19:00:00Z", "2026-10-13T21:30:00Z", { minutes: { deep: 30, light: 100, rem: 20, awake: 0 }, stages: [] }),
      score("2026-10-13", "2026-10-12T21:00:00Z"),
      // A day with nothing but a score.
      score("2026-10-15", "2026-10-14T21:00:00Z", { sleep: null, recovery: 55 }),
    ]);

    const r = await getJson<{ days: Obj[] }>(token, "/v1/days?from=2026-10-12&to=2026-10-15");
    expect(r.days.map((d) => d.date)).toEqual(["2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15"]);
    const [d12, d13, d14, d15] = r.days;
    expect(d12).toEqual({
      date: "2026-10-12",
      device_id: DEV_A,
      steps: 50,
      calories: null,
      heart_rate_min: 60,
      heart_rate_max: 60,
      heart_rate_avg: 60,
      battery_last: null,
    });
    expect(d13).toEqual({
      date: "2026-10-13",
      device_id: DEV_A,
      steps: 50,
      calories: 1,
      heart_rate_min: 80,
      heart_rate_max: 100,
      heart_rate_avg: 90,
      battery_last: 77,
      sleep_minutes: 410,
      nap_minutes: 35,
      score: {
        sleep: 82,
        recovery: 64,
        strain: 11.4,
        rhr: 54,
        hrv_rmssd: 41.5,
        confidence: { sleep: "high", recovery: "medium", strain: "low" },
        algo: "freeband-score/1",
      },
    });
    expect(d14).toEqual({
      date: "2026-10-14",
      device_id: DEV_A,
      steps: 7,
      calories: null,
      heart_rate_min: null,
      heart_rate_max: null,
      heart_rate_avg: null,
      battery_last: null,
      sleep_minutes: 150,
    });
    expect(d15).toMatchObject({ date: "2026-10-15", steps: null, heart_rate_avg: null, score: { sleep: null, recovery: 55 } });
    expect(d15).not.toHaveProperty("sleep_minutes");

    // The same instants fall on other days for a UTC account.
    const utc = await createAccount({ tz: "UTC" });
    await ingestOk(utc.token, [minute("2026-10-12T21:00:00Z", 30), sleep("2026-10-13T19:00:00Z", "2026-10-13T21:30:00Z", { stages: [] })], {
      tz: undefined,
    });
    const u = await getJson<{ days: Obj[] }>(utc.token, "/v1/days?from=2026-10-12&to=2026-10-14");
    expect(u.days.map((d) => [d.date, d.steps, d.sleep_minutes])).toEqual([
      ["2026-10-12", 30, undefined],
      ["2026-10-13", null, 410],
    ]);

    // ?device= narrows every source.
    await ingestOk(token, [minute("2026-10-13T10:00:00Z", 999), score("2026-10-13", "2026-10-12T21:00:00Z", { sleep: 1 })], {
      id: DEV_B,
      model: "band10",
      name: "Band 10",
    });
    const onlyB = await getJson<{ days: Obj[] }>(token, `/v1/days?from=2026-10-13&to=2026-10-13&device=${DEV_B}`);
    expect(onlyB.days).toEqual([
      {
        date: "2026-10-13",
        device_id: DEV_B,
        steps: 999,
        calories: null,
        heart_rate_min: null,
        heart_rate_max: null,
        heart_rate_avg: null,
        battery_last: null,
        score: expect.objectContaining({ sleep: 1 }),
      },
    ]);
  });
});

describe("exports with health data", () => {
  it("includes minutes, sleep and scores in JSON, and has a CSV per type", async () => {
    const { token } = await createAccount({ tz: "Europe/Istanbul" });
    await ingestOk(token, [
      live("2026-10-13T10:00:00Z", 100, 70),
      minute("2026-10-13T07:42:00Z", 112, { heart_rate: 96, spo2: 97 }),
      minute("2026-10-13T07:43:00Z", 4),
      sleep("2026-10-12T20:41:00Z", "2026-10-13T04:12:00Z"),
      score("2026-10-13", "2026-10-12T21:00:00Z"),
    ]);

    const doc = await getJson<{ samples: Obj[]; minutes: Obj[]; sleep: Obj[]; scores: Obj[] }>(token, "/v1/export.json");
    expect(doc.samples).toHaveLength(1);
    expect(doc.minutes).toEqual((await getJson<{ minutes: Obj[] }>(token, "/v1/minutes")).minutes);
    expect(doc.sleep).toEqual((await getJson<{ sleep: Obj[] }>(token, "/v1/sleep")).sleep);
    expect(doc.scores).toEqual((await getJson<{ scores: Obj[] }>(token, "/v1/scores")).scores);
    expect(doc.minutes).toHaveLength(2);

    const onlyMin = await getJson<{ samples: Obj[]; minutes: Obj[]; sleep: Obj[]; scores: Obj[] }>(token, "/v1/export.json?type=minute");
    expect([onlyMin.samples.length, onlyMin.minutes.length, onlyMin.sleep.length, onlyMin.scores.length]).toEqual([0, 2, 0, 0]);
    const ranged = await getJson<{ samples: Obj[]; minutes: Obj[]; sleep: Obj[]; scores: Obj[] }>(
      token,
      "/v1/export.json?from=2026-10-13T07:43:00Z&to=2026-10-13T12:00:00Z",
    );
    expect([ranged.samples.length, ranged.minutes.length, ranged.sleep.length, ranged.scores.length]).toEqual([1, 1, 0, 0]);

    // The default CSV is unchanged: live and battery only.
    const csv = (await (await call("/v1/export.csv", { headers: bearer(token) })).text()).trim().split("\n");
    expect(csv).toEqual(["device_id,type,ts,steps,calories,heart_rate,standing_hours,level", `${DEV_A},live,2026-10-13T10:00:00Z,100,4,70,3,`]);

    const minRes = await call("/v1/export.csv?type=minute", { headers: bearer(token) });
    expect(minRes.headers.get("content-disposition")).toMatch(/^attachment; filename="freeband-minute-\d{4}-\d{2}-\d{2}\.csv"$/);
    expect((await minRes.text()).trim().split("\n")).toEqual([
      "device_id,type,ts,steps,heart_rate,spo2,stress,active_calories,distance_m",
      `${DEV_A},minute,2026-10-13T07:42:00Z,112,96,97,,,`,
      `${DEV_A},minute,2026-10-13T07:43:00Z,4,,,,,`,
    ]);

    const sleepCsv = (await (await call("/v1/export.csv?type=sleep", { headers: bearer(token) })).text()).trim().split("\n");
    expect(sleepCsv).toEqual([
      "device_id,type,ts,end,is_nap,deep,light,rem,awake,wake_count,efficiency,hr_min,spo2_avg,spo2_min,hrv_rmssd,stages",
      `${DEV_A},sleep,2026-10-12T20:41:00Z,2026-10-13T04:12:00Z,false,80,240,90,20,3,95,48,96.4,91,42,"[[0,""light"",20],[20,""deep"",40],[60,""rem"",30]]"`,
    ]);

    const scoreCsv = (await (await call("/v1/export.csv?type=score", { headers: bearer(token) })).text()).trim().split("\n");
    expect(scoreCsv[0]).toBe(
      "device_id,type,ts,date,sleep,recovery,strain,rhr,hrv_rmssd,confidence_sleep,confidence_recovery,confidence_strain,algo,contributors",
    );
    expect(scoreCsv[1]?.startsWith(`${DEV_A},score,2026-10-12T21:00:00Z,2026-10-13,82,64,11.4,54,41.5,high,medium,low,freeband-score/1,"[{`)).toBe(true);
    expect(scoreCsv).toHaveLength(2);

    expect((await call("/v1/export.csv?type=steps", { headers: bearer(token) })).status).toBe(400);
  });
});

describe("heart rate readings are 30–220 bpm", () => {
  it("ignores out-of-range live values in the panel and in days", async () => {
    const { token } = await createAccount({ tz: "Europe/Istanbul" });
    await ingestOk(token, [
      live("2026-10-13T10:00:00Z", 100, 0),
      live("2026-10-13T10:05:00Z", 200, 25),
      live("2026-10-13T10:10:00Z", 300, 240),
      live("2026-10-13T10:15:00Z", 400, 75),
      live("2026-10-13T10:20:00Z", 500, 29),
    ]);
    const days = await getJson<{ days: Obj[] }>(token, "/v1/days?from=2026-10-13&to=2026-10-13");
    expect(days.days[0]).toMatchObject({ heart_rate_min: 75, heart_rate_max: 75, heart_rate_avg: 75 });

    const cookie = await login(token);
    const page = await (await call("/app?date=2026-10-13", { headers: { Cookie: cookie } })).text();
    expect(page).toContain('<span class="label">nabız aralığı</span><span class="fig">75<span class="unit">bpm</span>');
    expect(page).toContain('class="hr"');
    // The last reading is 75 at 13:15 local, not the later 29.
    expect(page).toContain("son nabız 75");
  });

  it("panel tells where to enter a rotated key in the app", async () => {
    const { token } = await createAccount();
    const cookie = await login(token);
    const page = await (await call("/app", { headers: { Cookie: cookie } })).text();
    expect(page).toContain("Ayarlar → Web erişimi → API anahtarını gir");
    expect(page).toContain("Settings → Web access → Enter API key");
    expect(page).not.toContain("yeni anahtarı girene kadar");
  });
});

describe("documentation", () => {
  it("documents the new types and endpoints on /docs and /privacy", async () => {
    const docs = await (await call("/docs")).text();
    for (const s of ["/v1/minutes", "/v1/sleep", "/v1/scores", "sync.partial", "sleep_minutes", "type=minute", "after=", "API anahtarını gir"]) {
      expect(docs, s).toContain(s);
    }
    const privacy = await (await call("/tr/privacy")).text();
    for (const s of ["Dakikalık veri", "Uyku", "Skorlar"]) expect(privacy, s).toContain(s);
  });
});
