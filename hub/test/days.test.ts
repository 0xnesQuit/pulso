import { describe, expect, it } from "vitest";
import { DEV_A, DEV_B, battery, bearer, call, createAccount, ingest, live, syncBody } from "./helpers";
import { dayBounds, localDate, startOfLocalDay } from "../src/lib/time";

interface Day {
  date: string;
  device_id: string;
  steps: number | null;
  calories: number | null;
  heart_rate_min: number | null;
  heart_rate_max: number | null;
  heart_rate_avg: number | null;
  battery_last: number | null;
}

async function days(token: string, query: string): Promise<{ tz: string; from: string; to: string; days: Day[] }> {
  const res = await call(`/v1/days?${query}`, { headers: bearer(token) });
  expect(res.status).toBe(200);
  return res.json();
}

describe("time zone helpers", () => {
  it("finds local midnight in Europe/Istanbul (UTC+3)", () => {
    expect(startOfLocalDay("2026-10-14", "Europe/Istanbul")).toBe(Date.UTC(2026, 9, 13, 21, 0, 0));
    expect(localDate(Date.UTC(2026, 9, 13, 20, 59, 59), "Europe/Istanbul")).toBe("2026-10-13");
    expect(localDate(Date.UTC(2026, 9, 13, 21, 0, 0), "Europe/Istanbul")).toBe("2026-10-14");
  });

  it("handles DST days of 23 and 25 hours", () => {
    const [spring] = dayBounds("2026-03-29", "2026-03-29", "Europe/Berlin");
    expect(spring?.[1]).toBe(Date.UTC(2026, 2, 28, 23));
    expect(spring?.[2]).toBe(Date.UTC(2026, 2, 29, 22));
    const [autumn] = dayBounds("2025-10-26", "2025-10-26", "Europe/Berlin");
    expect(autumn?.[1]).toBe(Date.UTC(2025, 9, 25, 22));
    expect(autumn?.[2]).toBe(Date.UTC(2025, 9, 26, 23));
  });
});

describe("GET /v1/days", () => {
  it("buckets by the account's local day around midnight in Europe/Istanbul", async () => {
    const { token } = await createAccount({ tz: "Europe/Istanbul" });
    const samples = [
      live("2026-10-12T20:59:59Z", 7000, 66), // 23:59:59 on 12 Oct local
      live("2026-10-12T21:30:00Z", 100, 0), // 00:30 on 13 Oct local
      battery("2026-10-13T09:00:00Z", 70),
      live("2026-10-13T10:00:00Z", 5000, 80),
      battery("2026-10-13T20:59:00Z", 46),
      { type: "live", ts: "2026-10-13T20:59:59Z", steps: 8421, calories: 312, heart_rate: 60 }, // 23:59:59 on 13 Oct
      live("2026-10-13T21:00:00Z", 12, 90), // 00:00 on 14 Oct local
      live("2026-10-14T05:00:00Z", 900, 0),
    ];
    expect(await (await ingest(token, syncBody(samples))).json()).toEqual({ accepted: 8, duplicates: 0 });

    const r = await days(token, "from=2026-10-12&to=2026-10-14");
    expect(r.tz).toBe("Europe/Istanbul");
    expect(r.days.map((d) => d.date)).toEqual(["2026-10-12", "2026-10-13", "2026-10-14"]);
    const [d12, d13, d14] = r.days;
    expect(d12).toMatchObject({ device_id: DEV_A, steps: 7000, heart_rate_min: 66, heart_rate_max: 66, battery_last: null });
    // Max of the cumulative values; heart-rate 0 ignored; latest battery of the day.
    expect(d13).toEqual({
      date: "2026-10-13",
      device_id: DEV_A,
      steps: 8421,
      calories: 312,
      heart_rate_min: 60,
      heart_rate_max: 80,
      heart_rate_avg: 70,
      battery_last: 46,
    });
    expect(d14).toMatchObject({ steps: 900, heart_rate_min: 90, heart_rate_max: 90, heart_rate_avg: 90, battery_last: null });

    // The same instants bucket differently for a UTC account.
    const utc = await createAccount({ tz: "UTC" });
    await ingest(utc.token, syncBody(samples, { tz: undefined }));
    const u = await days(utc.token, "from=2026-10-12&to=2026-10-14");
    expect(u.days.map((d) => [d.date, d.steps])).toEqual([
      ["2026-10-12", 7000],
      ["2026-10-13", 8421],
      ["2026-10-14", 900],
    ]);
    // 12 Oct UTC holds the 21:30Z sample whose steps are below the day's max, and its HR 0 is ignored.
    expect(u.days[0]).toMatchObject({ heart_rate_min: 66, heart_rate_max: 66 });
  });

  it("returns a row per device and filters by ?device=", async () => {
    const { token } = await createAccount({ tz: "Europe/Istanbul" });
    await ingest(token, syncBody([live("2026-10-13T10:00:00Z", 4000, 70)], { id: DEV_A }));
    await ingest(token, syncBody([live("2026-10-13T11:00:00Z", 2500, 90)], { id: DEV_B, model: "band10" }));
    const all = await days(token, "from=2026-10-13&to=2026-10-13");
    expect(all.days.map((d) => [d.device_id, d.steps]).sort()).toEqual(
      [
        [DEV_A, 4000],
        [DEV_B, 2500],
      ].sort(),
    );
    const onlyB = await days(token, `from=2026-10-13&to=2026-10-13&device=${DEV_B.toLowerCase()}`);
    expect(onlyB.days).toHaveLength(1);
    expect(onlyB.days[0]).toMatchObject({ device_id: DEV_B, steps: 2500, heart_rate_avg: 90 });
  });

  it("follows DST transitions in Europe/Berlin", async () => {
    const { token } = await createAccount({ tz: "Europe/Berlin" });
    const tz = { tz: "Europe/Berlin" };
    await ingest(
      token,
      syncBody(
        [
          live("2026-03-28T22:59:59Z", 2, 60), // 23:59:59 CET, 28 Mar
          live("2026-03-28T23:00:00Z", 3, 60), // 00:00 CET, 29 Mar
          live("2026-03-29T21:59:59Z", 444, 60), // 23:59:59 CEST, 29 Mar (23-hour day)
          live("2026-03-29T22:00:00Z", 9, 60), // 00:00 CEST, 30 Mar
          live("2025-10-26T22:30:00Z", 555, 60), // 23:30 CET, 26 Oct 2025 (25-hour day)
          live("2025-10-26T23:00:00Z", 7, 60), // 00:00 CET, 27 Oct 2025
        ],
        tz,
      ),
    );
    const spring = await days(token, "from=2026-03-28&to=2026-03-30");
    expect(spring.days.map((d) => [d.date, d.steps])).toEqual([
      ["2026-03-28", 2],
      ["2026-03-29", 444],
      ["2026-03-30", 9],
    ]);
    const autumn = await days(token, "from=2025-10-26&to=2025-10-27");
    expect(autumn.days.map((d) => [d.date, d.steps])).toEqual([
      ["2025-10-26", 555],
      ["2025-10-27", 7],
    ]);
  });

  it("defaults to the last 14 days and validates the range", async () => {
    const { token } = await createAccount({ tz: "Europe/Istanbul" });
    const r = await days(token, "");
    const today = localDate(Date.now(), "Europe/Istanbul");
    expect(r.to).toBe(today);
    expect(Date.parse(r.to) - Date.parse(r.from)).toBe(13 * 86_400_000);
    for (const q of ["from=2026-10-14&to=2026-10-01", "from=2024-01-01&to=2026-01-02", "from=13-10-2026", "to=2026-02-30", "device=xyz"]) {
      const res = await call(`/v1/days?${q}`, { headers: bearer(token) });
      expect(res.status, q).toBe(400);
    }
  });
});
