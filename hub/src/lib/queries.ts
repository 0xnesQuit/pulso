// Read queries shared by the API and the web panel. Every statement is
// scoped by account_id as its first bound parameter.

import { dayBounds, isoOut } from "./time";

export interface DeviceOut {
  id: string;
  name: string;
  model: string;
  last_seen: string;
}

export interface SampleDbRow {
  device_id: string;
  type: "live" | "battery";
  ts: number;
  steps: number | null;
  calories: number | null;
  heart_rate: number | null;
  standing_hours: number | null;
  level: number | null;
}

export interface DayOut {
  date: string;
  device_id: string;
  steps: number | null;
  calories: number | null;
  heart_rate_min: number | null;
  heart_rate_max: number | null;
  heart_rate_avg: number | null;
  battery_last: number | null;
}

export async function listDevices(db: D1Database, accountId: string): Promise<DeviceOut[]> {
  const { results } = await db
    .prepare("SELECT id, name, model, last_seen FROM devices WHERE account_id = ?1 ORDER BY last_seen DESC, id")
    .bind(accountId)
    .all<{ id: string; name: string; model: string; last_seen: number }>();
  return results.map((d) => ({ id: d.id, name: d.name, model: d.model, last_seen: isoOut(d.last_seen) }));
}

export interface SampleQuery {
  from: number;
  to: number;
  device?: string | undefined;
  type?: "live" | "battery" | undefined;
  limit: number;
  /** Keyset cursor: rows strictly after (ts, device_id, type). */
  after?: [number, string, string] | undefined;
}

const SAMPLE_COLS = "device_id, type, ts, steps, calories, heart_rate, standing_hours, level";

export async function querySamples(db: D1Database, accountId: string, q: SampleQuery): Promise<SampleDbRow[]> {
  const where = ["account_id = ?1", "ts >= ?2", "ts < ?3"];
  const binds: unknown[] = [accountId, q.from, q.to];
  if (q.device) {
    binds.push(q.device);
    where.push(`device_id = ?${binds.length}`);
  }
  if (q.type) {
    binds.push(q.type);
    where.push(`type = ?${binds.length}`);
  }
  if (q.after) {
    binds.push(...q.after);
    const n = binds.length;
    where.push(`(ts, device_id, type) > (?${n - 2}, ?${n - 1}, ?${n})`);
  }
  binds.push(q.limit);
  const { results } = await db
    .prepare(
      `SELECT ${SAMPLE_COLS} FROM samples WHERE ${where.join(" AND ")}
       ORDER BY ts, device_id, type LIMIT ?${binds.length}`,
    )
    .bind(...binds)
    .all<SampleDbRow>();
  return results;
}

export async function countSamples(
  db: D1Database,
  accountId: string,
  q: Pick<SampleQuery, "from" | "to" | "device" | "type">,
): Promise<number> {
  const where = ["account_id = ?1", "ts >= ?2", "ts < ?3"];
  const binds: unknown[] = [accountId, q.from, q.to];
  if (q.device) {
    binds.push(q.device);
    where.push(`device_id = ?${binds.length}`);
  }
  if (q.type) {
    binds.push(q.type);
    where.push(`type = ?${binds.length}`);
  }
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM samples WHERE ${where.join(" AND ")}`)
    .bind(...binds)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export function sampleOut(r: SampleDbRow): Record<string, unknown> {
  const base = { device_id: r.device_id, type: r.type, ts: isoOut(r.ts) };
  if (r.type === "battery") return { ...base, level: r.level };
  const out: Record<string, unknown> = {
    ...base,
    steps: r.steps,
    calories: r.calories,
    heart_rate: r.heart_rate,
  };
  if (r.standing_hours !== null) out.standing_hours = r.standing_hours;
  return out;
}

/**
 * Daily summary per device in the account's time zone. Local-day boundaries
 * are computed in JS (DST-aware) and joined in SQL, so aggregation stays in D1.
 * steps/calories are cumulative per day, so the day's value is the maximum.
 * Heart-rate aggregates ignore 0 (not measured).
 */
export async function daySummaries(
  db: D1Database,
  accountId: string,
  tz: string,
  from: string,
  to: string,
  device?: string,
): Promise<DayOut[]> {
  const bounds = dayBounds(from, to, tz);
  const binds: unknown[] = [accountId, JSON.stringify(bounds)];
  let deviceFilter = "";
  if (device) {
    binds.push(device);
    deviceFilter = "AND x.device_id = ?3";
  }
  const { results } = await db
    .prepare(
      `WITH d (date, s, e) AS (
         SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]')
           FROM json_each(?2)
       )
       SELECT d.date AS date,
              x.device_id AS device_id,
              MAX(CASE WHEN x.type = 'live' THEN x.steps END) AS steps,
              MAX(CASE WHEN x.type = 'live' THEN x.calories END) AS calories,
              MIN(CASE WHEN x.type = 'live' AND x.heart_rate > 0 THEN x.heart_rate END) AS heart_rate_min,
              MAX(CASE WHEN x.type = 'live' AND x.heart_rate > 0 THEN x.heart_rate END) AS heart_rate_max,
              AVG(CASE WHEN x.type = 'live' AND x.heart_rate > 0 THEN x.heart_rate END) AS heart_rate_avg,
              (SELECT b.level FROM samples b
                WHERE b.account_id = ?1 AND b.device_id = x.device_id AND b.type = 'battery'
                  AND b.ts >= d.s AND b.ts < d.e
                ORDER BY b.ts DESC LIMIT 1) AS battery_last
         FROM d
         JOIN samples x ON x.account_id = ?1 AND x.ts >= d.s AND x.ts < d.e ${deviceFilter}
        GROUP BY d.date, x.device_id
        ORDER BY d.date, x.device_id`,
    )
    .bind(...binds)
    .all<DayOut>();
  return results.map((r) => ({
    ...r,
    heart_rate_avg: r.heart_rate_avg === null ? null : Math.round(r.heart_rate_avg),
  }));
}
