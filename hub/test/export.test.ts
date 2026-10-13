import { describe, expect, it } from "vitest";
import { DEV_A, DEV_B, battery, bearer, call, createAccount, ingest, live, syncBody } from "./helpers";

const T0 = Date.UTC(2026, 9, 1, 0, 0, 0);
const iso = (ms: number) => new Date(ms).toISOString().replace(".000Z", "Z");

describe("exports", () => {
  it("exports CSV and JSON with device_id on every row", async () => {
    const { token } = await createAccount({ tz: "Europe/Istanbul" });
    await ingest(token, syncBody([live("2026-10-13T10:00:00Z", 100, 70), battery("2026-10-13T10:00:01Z", 50)], { id: DEV_A }));
    await ingest(token, syncBody([{ type: "live", ts: "2026-10-13T11:00:00Z", steps: 7, calories: 0, heart_rate: 0 }], { id: DEV_B, model: "band10" }));

    const csvRes = await call("/v1/export.csv", { headers: bearer(token) });
    expect(csvRes.status).toBe(200);
    expect(csvRes.headers.get("content-type")).toContain("text/csv");
    expect(csvRes.headers.get("content-disposition")).toMatch(/^attachment; filename="freeband-\d{4}-\d{2}-\d{2}\.csv"$/);
    const lines = (await csvRes.text()).trim().split("\n");
    expect(lines).toEqual([
      "device_id,type,ts,steps,calories,heart_rate,standing_hours,level",
      `${DEV_A},live,2026-10-13T10:00:00Z,100,4,70,3,`,
      `${DEV_A},battery,2026-10-13T10:00:01Z,,,,,50`,
      `${DEV_B},live,2026-10-13T11:00:00Z,7,0,0,,`,
    ]);

    const onlyB = (await (await call(`/v1/export.csv?device=${DEV_B}`, { headers: bearer(token) })).text()).trim().split("\n");
    expect(onlyB).toHaveLength(2);

    const jsonRes = await call("/v1/export.json?from=2026-10-13&to=2026-10-13", { headers: bearer(token) });
    const doc = (await jsonRes.json()) as {
      schema: string;
      tz: string;
      devices: Array<{ id: string }>;
      samples: Array<{ device_id: string; type: string }>;
    };
    expect(doc.schema).toBe("freeband.v1");
    expect(doc.tz).toBe("Europe/Istanbul");
    expect(doc.devices.map((d) => d.id).sort()).toEqual([DEV_A, DEV_B].sort());
    expect(doc.samples).toHaveLength(3);
    for (const s of doc.samples) expect([DEV_A, DEV_B]).toContain(s.device_id);
    expect(doc.samples[1]).toEqual({ device_id: DEV_A, type: "battery", ts: "2026-10-13T10:00:01Z", level: 50 });
  });

  it("streams across chunk boundaries without gaps or repeats", async () => {
    const { token } = await createAccount();
    // Many identical timestamps across devices and types exercise the keyset cursor.
    const ts = Array.from({ length: 5000 }, (_, i) => iso(T0 + i * 60_000));
    expect((await ingest(token, syncBody(ts.map((t) => battery(t, 50)), { id: DEV_A }))).status).toBe(200);
    expect((await ingest(token, syncBody(ts.map((t) => battery(t, 60)), { id: DEV_B, model: "band10" }))).status).toBe(200);
    expect((await ingest(token, syncBody(ts.slice(0, 1500).map((t) => live(t, 1, 0)), { id: DEV_A }))).status).toBe(200);

    const text = await (await call("/v1/export.csv", { headers: bearer(token) })).text();
    const rows = text.trim().split("\n").slice(1);
    expect(rows).toHaveLength(11_500);
    const keys = rows.map((r) => r.split(",").slice(0, 3).join(","));
    expect(new Set(keys).size).toBe(11_500);
    const sorted = [...rows].sort((a, b) => {
      const [da, ta, tsa] = a.split(",") as [string, string, string];
      const [db, tb, tsb] = b.split(",") as [string, string, string];
      return tsa.localeCompare(tsb) || da.localeCompare(db) || ta.localeCompare(tb);
    });
    expect(rows).toEqual(sorted);

    const doc = (await (await call("/v1/export.json", { headers: bearer(token) })).json()) as { samples: unknown[] };
    expect(doc.samples).toHaveLength(11_500);
  });

  it("pages raw samples with limit and has_more", async () => {
    const { token } = await createAccount();
    await ingest(token, syncBody(Array.from({ length: 30 }, (_, i) => live(iso(T0 + i * 1000), i))));
    const p1 = (await (await call("/v1/samples?limit=10", { headers: bearer(token) })).json()) as {
      samples: Array<{ ts: string; steps: number }>;
      has_more: boolean;
    };
    expect(p1.samples).toHaveLength(10);
    expect(p1.has_more).toBe(true);
    expect(p1.samples.map((s) => s.steps)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const last = p1.samples[9]?.ts ?? "";
    const next = (await (await call(`/v1/samples?from=${encodeURIComponent(new Date(Date.parse(last) + 1).toISOString())}&limit=100`, {
      headers: bearer(token),
    })).json()) as { samples: unknown[]; has_more: boolean };
    expect(next.samples).toHaveLength(20);
    expect(next.has_more).toBe(false);

    for (const q of ["limit=0", "limit=5001", "limit=abc", "type=sleep", "from=yesterday", "from=2026-10-10&to=2026-10-01"]) {
      expect((await call(`/v1/samples?${q}`, { headers: bearer(token) })).status, q).toBe(400);
    }
  });
});
