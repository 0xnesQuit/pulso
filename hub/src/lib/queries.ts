// Read queries shared by the API and the web panel. Every statement is
// scoped by account_id as its first bound parameter.

import { dayBounds, isoOut } from "./time";
import { HR_MAX, HR_MIN, type Confidence } from "./validate";

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

export interface DayScoreOut {
  sleep: number | null;
  recovery: number | null;
  strain: number | null;
  rhr: number | null;
  hrv_rmssd: number | null;
  confidence: { sleep: Confidence; recovery: Confidence; strain: Confidence };
  algo: string;
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
  /** Present only when a night (not a nap) ended on this local day: deep + light + REM minutes. */
  sleep_minutes?: number;
  /** Present only when a nap ended on this local day. */
  nap_minutes?: number;
  /** Present only when the phone sent a score for this date. */
  score?: DayScoreOut;
}

/** SQL fragment: `col` holds a heart-rate reading (30–220 bpm). */
const hrOk = (col: string): string => `${col} BETWEEN ${HR_MIN} AND ${HR_MAX}`;

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

// ---------------------------------------------------------------------------
// Health tables (minute, sleep, score). Same shape of query for each: an
// account-scoped range on one time column, optional device, keyset cursor
// over the ORDER BY columns, and a limit.

/** Time range on the table's own column; `to` is exclusive. */
export interface HealthQuery<C> {
  from: number;
  to: number;
  device?: string | undefined;
  limit: number;
  after?: C | undefined;
}

interface RangeSpec {
  table: "minutes" | "sleeps" | "scores";
  cols: string;
  /** Column that from/to filter on. */
  rangeCol: string;
  /** ORDER BY columns; also the keyset cursor, in the same order. */
  order: string[];
}

async function queryRange<R>(
  db: D1Database,
  accountId: string,
  spec: RangeSpec,
  q: { from: number | string; to: number | string; device?: string | undefined; limit: number; after?: unknown[] | undefined },
  toInclusive = false,
): Promise<R[]> {
  const where = ["account_id = ?1", `${spec.rangeCol} >= ?2`, `${spec.rangeCol} ${toInclusive ? "<=" : "<"} ?3`];
  const binds: unknown[] = [accountId, q.from, q.to];
  if (q.device) {
    binds.push(q.device);
    where.push(`device_id = ?${binds.length}`);
  }
  if (q.after) {
    const start = binds.length + 1;
    binds.push(...q.after);
    const marks = q.after.map((_, i) => `?${start + i}`).join(", ");
    where.push(`(${spec.order.join(", ")}) > (${marks})`);
  }
  binds.push(q.limit);
  const { results } = await db
    .prepare(
      `SELECT ${spec.cols} FROM ${spec.table} WHERE ${where.join(" AND ")}
       ORDER BY ${spec.order.join(", ")} LIMIT ?${binds.length}`,
    )
    .bind(...binds)
    .all<R>();
  return results;
}

async function countRange(
  db: D1Database,
  accountId: string,
  table: RangeSpec["table"],
  rangeCol: string,
  q: { from: number; to: number; device?: string | undefined },
): Promise<number> {
  const binds: unknown[] = [accountId, q.from, q.to];
  let dev = "";
  if (q.device) {
    binds.push(q.device);
    dev = " AND device_id = ?4";
  }
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE account_id = ?1 AND ${rangeCol} >= ?2 AND ${rangeCol} < ?3${dev}`)
    .bind(...binds)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

// --- minute

export interface MinuteDbRow {
  device_id: string;
  ts: number;
  steps: number;
  heart_rate: number | null;
  spo2: number | null;
  stress: number | null;
  active_calories: number | null;
  distance_m: number | null;
}

export type MinuteCursor = [number, string];

const MINUTE_SPEC: RangeSpec = {
  table: "minutes",
  cols: "device_id, ts, steps, heart_rate, spo2, stress, active_calories, distance_m",
  rangeCol: "ts",
  order: ["ts", "device_id"],
};

export const queryMinutes = (db: D1Database, accountId: string, q: HealthQuery<MinuteCursor>) =>
  queryRange<MinuteDbRow>(db, accountId, MINUTE_SPEC, q);
export const countMinutes = (db: D1Database, accountId: string, q: { from: number; to: number; device?: string | undefined }) =>
  countRange(db, accountId, "minutes", "ts", q);
export const minuteCursor = (r: MinuteDbRow): MinuteCursor => [r.ts, r.device_id];

export function minuteOut(r: MinuteDbRow): Record<string, unknown> {
  const out: Record<string, unknown> = { device_id: r.device_id, type: "minute", ts: isoOut(r.ts), steps: r.steps };
  if (r.heart_rate !== null) out.heart_rate = r.heart_rate;
  if (r.spo2 !== null) out.spo2 = r.spo2;
  if (r.stress !== null) out.stress = r.stress;
  if (r.active_calories !== null) out.active_calories = r.active_calories;
  if (r.distance_m !== null) out.distance_m = r.distance_m;
  return out;
}

// --- sleep (filtered and ordered by wake time: a night belongs to the day it ends)

export interface SleepDbRow {
  device_id: string;
  ts: number;
  end_ts: number;
  is_nap: number;
  deep_min: number;
  light_min: number;
  rem_min: number;
  awake_min: number;
  wake_count: number;
  efficiency: number;
  stages: string;
  hr_min: number | null;
  spo2_avg: number | null;
  spo2_min: number | null;
  hrv_rmssd: number | null;
}

export type SleepCursor = [number, string, number];

const SLEEP_SPEC: RangeSpec = {
  table: "sleeps",
  cols:
    "device_id, ts, end_ts, is_nap, deep_min, light_min, rem_min, awake_min, wake_count, efficiency, stages, hr_min, spo2_avg, spo2_min, hrv_rmssd",
  rangeCol: "end_ts",
  order: ["end_ts", "device_id", "ts"],
};

export const querySleeps = (db: D1Database, accountId: string, q: HealthQuery<SleepCursor>) =>
  queryRange<SleepDbRow>(db, accountId, SLEEP_SPEC, q);
export const countSleeps = (db: D1Database, accountId: string, q: { from: number; to: number; device?: string | undefined }) =>
  countRange(db, accountId, "sleeps", "end_ts", q);
export const sleepCursor = (r: SleepDbRow): SleepCursor => [r.end_ts, r.device_id, r.ts];

export function sleepOut(r: SleepDbRow): Record<string, unknown> {
  const out: Record<string, unknown> = {
    device_id: r.device_id,
    type: "sleep",
    ts: isoOut(r.ts),
    end: isoOut(r.end_ts),
    is_nap: r.is_nap === 1,
    minutes: { deep: r.deep_min, light: r.light_min, rem: r.rem_min, awake: r.awake_min },
    wake_count: r.wake_count,
    efficiency: r.efficiency,
    stages: JSON.parse(r.stages) as unknown,
    hr_min: r.hr_min,
    spo2_avg: r.spo2_avg,
    spo2_min: r.spo2_min,
  };
  if (r.hrv_rmssd !== null) out.hrv_rmssd = r.hrv_rmssd;
  return out;
}

// --- score

export interface ScoreDbRow {
  device_id: string;
  ts: number;
  date: string;
  sleep_score: number | null;
  recovery_score: number | null;
  strain_score: number | null;
  rhr: number | null;
  hrv_rmssd: number | null;
  conf_sleep: Confidence;
  conf_recovery: Confidence;
  conf_strain: Confidence;
  contributors: string;
  algo: string;
}

export type ScoreCursor = [string, string, number];

const SCORE_COLS =
  "device_id, ts, date, sleep_score, recovery_score, strain_score, rhr, hrv_rmssd, conf_sleep, conf_recovery, conf_strain, contributors, algo";
const SCORE_ORDER = ["date", "device_id", "ts"];

/** Scores by calendar date (both ends inclusive), as /v1/scores and /v1/days see them. */
export const queryScoresByDate = (
  db: D1Database,
  accountId: string,
  q: { from: string; to: string; device?: string | undefined; limit: number; after?: ScoreCursor | undefined },
) => queryRange<ScoreDbRow>(db, accountId, { table: "scores", cols: SCORE_COLS, rangeCol: "date", order: SCORE_ORDER }, q, true);

/** Scores by their ts instant (exports, where from/to are instants). */
export const queryScoresByTs = (db: D1Database, accountId: string, q: HealthQuery<ScoreCursor>) =>
  queryRange<ScoreDbRow>(db, accountId, { table: "scores", cols: SCORE_COLS, rangeCol: "ts", order: SCORE_ORDER }, q);
export const countScores = (db: D1Database, accountId: string, q: { from: number; to: number; device?: string | undefined }) =>
  countRange(db, accountId, "scores", "ts", q);
export const scoreCursor = (r: ScoreDbRow): ScoreCursor => [r.date, r.device_id, r.ts];

export function scoreOut(r: ScoreDbRow): Record<string, unknown> {
  return {
    device_id: r.device_id,
    type: "score",
    ts: isoOut(r.ts),
    date: r.date,
    sleep: r.sleep_score,
    recovery: r.recovery_score,
    strain: r.strain_score,
    rhr: r.rhr,
    hrv_rmssd: r.hrv_rmssd,
    confidence: { sleep: r.conf_sleep, recovery: r.conf_recovery, strain: r.conf_strain },
    contributors: JSON.parse(r.contributors) as unknown,
    algo: r.algo,
  };
}

// ---------------------------------------------------------------------------
// Daily summary

interface HrAgg {
  hr_min: number | null;
  hr_max: number | null;
  hr_sum: number | null;
  hr_n: number;
}

/**
 * Daily summary per device in the account's time zone. Local-day boundaries
 * are computed in JS (DST-aware) and joined in SQL, so aggregation stays in D1.
 *
 * - steps: the larger of the live samples' cumulative maximum and the sum of
 *   minute steps (both undercount until the day is fully synced).
 * - calories, battery_last: live and battery samples only.
 * - heart rate: live samples and minutes; only 30–220 bpm counts as a reading.
 * - sleep_minutes / nap_minutes: sessions whose wake time falls on the day.
 * - score: the phone's score for that date (the latest one received).
 * A day appears when any of these sources has data for it.
 */
export async function daySummaries(
  db: D1Database,
  accountId: string,
  tz: string,
  from: string,
  to: string,
  device?: string,
): Promise<DayOut[]> {
  const bounds = JSON.stringify(dayBounds(from, to, tz));
  const binds: unknown[] = device ? [accountId, bounds, device] : [accountId, bounds];
  const devFilter = device ? "AND x.device_id = ?3" : "";
  const days = `WITH d (date, s, e) AS (
         SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]')
           FROM json_each(?2)
       )`;
  const liveHr = (fn: string) => `${fn}(CASE WHEN x.type = 'live' AND ${hrOk("x.heart_rate")} THEN x.heart_rate END)`;
  const minHr = (fn: string) => `${fn}(CASE WHEN ${hrOk("x.heart_rate")} THEN x.heart_rate END)`;
  const asleep = "x.deep_min + x.light_min + x.rem_min";

  const [samples, minutes, sleeps, scores] = await db.batch([
    db
      .prepare(
        `${days}
         SELECT d.date AS date,
                x.device_id AS device_id,
                MAX(CASE WHEN x.type = 'live' THEN x.steps END) AS steps,
                MAX(CASE WHEN x.type = 'live' THEN x.calories END) AS calories,
                ${liveHr("MIN")} AS hr_min,
                ${liveHr("MAX")} AS hr_max,
                ${liveHr("SUM")} AS hr_sum,
                ${liveHr("COUNT")} AS hr_n,
                (SELECT b.level FROM samples b
                  WHERE b.account_id = ?1 AND b.device_id = x.device_id AND b.type = 'battery'
                    AND b.ts >= d.s AND b.ts < d.e
                  ORDER BY b.ts DESC LIMIT 1) AS battery_last
           FROM d
           JOIN samples x ON x.account_id = ?1 AND x.ts >= d.s AND x.ts < d.e ${devFilter}
          GROUP BY d.date, x.device_id`,
      )
      .bind(...binds),
    db
      .prepare(
        `${days}
         SELECT d.date AS date, x.device_id AS device_id, SUM(x.steps) AS steps,
                ${minHr("MIN")} AS hr_min, ${minHr("MAX")} AS hr_max, ${minHr("SUM")} AS hr_sum, ${minHr("COUNT")} AS hr_n
           FROM d
           JOIN minutes x ON x.account_id = ?1 AND x.ts >= d.s AND x.ts < d.e ${devFilter}
          GROUP BY d.date, x.device_id`,
      )
      .bind(...binds),
    db
      .prepare(
        `${days}
         SELECT d.date AS date, x.device_id AS device_id,
                SUM(CASE WHEN x.is_nap = 0 THEN ${asleep} END) AS sleep_minutes,
                SUM(CASE WHEN x.is_nap = 1 THEN ${asleep} END) AS nap_minutes
           FROM d
           JOIN sleeps x ON x.account_id = ?1 AND x.end_ts >= d.s AND x.end_ts < d.e ${devFilter}
          GROUP BY d.date, x.device_id`,
      )
      .bind(...binds),
    db
      .prepare(
        `SELECT ${SCORE_COLS} FROM scores x
          WHERE x.account_id = ?1 AND x.date >= ?2 AND x.date <= ?3 ${device ? "AND x.device_id = ?4" : ""}
          ORDER BY x.date, x.device_id, x.received_at, x.ts`,
      )
      .bind(...(device ? [accountId, from, to, device] : [accountId, from, to])),
  ]);

  type Acc = DayOut & { hr: HrAgg[] };
  const byKey = new Map<string, Acc>();
  const acc = (date: string, deviceId: string): Acc => {
    const k = `${date} ${deviceId}`;
    let a = byKey.get(k);
    if (!a) {
      a = {
        date,
        device_id: deviceId,
        steps: null,
        calories: null,
        heart_rate_min: null,
        heart_rate_max: null,
        heart_rate_avg: null,
        battery_last: null,
        hr: [],
      };
      byKey.set(k, a);
    }
    return a;
  };
  const maxOf = (a: number | null, b: number | null): number | null => (a === null ? b : b === null ? a : Math.max(a, b));

  for (const r of (samples?.results ?? []) as Array<HrAgg & { date: string; device_id: string; steps: number | null; calories: number | null; battery_last: number | null }>) {
    const a = acc(r.date, r.device_id);
    a.steps = maxOf(a.steps, r.steps);
    a.calories = r.calories;
    a.battery_last = r.battery_last;
    a.hr.push(r);
  }
  for (const r of (minutes?.results ?? []) as Array<HrAgg & { date: string; device_id: string; steps: number | null }>) {
    const a = acc(r.date, r.device_id);
    a.steps = maxOf(a.steps, r.steps);
    a.hr.push(r);
  }
  for (const r of (sleeps?.results ?? []) as Array<{ date: string; device_id: string; sleep_minutes: number | null; nap_minutes: number | null }>) {
    const a = acc(r.date, r.device_id);
    if (r.sleep_minutes !== null) a.sleep_minutes = r.sleep_minutes;
    if (r.nap_minutes !== null) a.nap_minutes = r.nap_minutes;
  }
  // Ordered by received_at, so the latest score for a date wins.
  for (const r of (scores?.results ?? []) as ScoreDbRow[]) {
    acc(r.date, r.device_id).score = {
      sleep: r.sleep_score,
      recovery: r.recovery_score,
      strain: r.strain_score,
      rhr: r.rhr,
      hrv_rmssd: r.hrv_rmssd,
      confidence: { sleep: r.conf_sleep, recovery: r.conf_recovery, strain: r.conf_strain },
      algo: r.algo,
    };
  }

  const out: DayOut[] = [];
  for (const a of byKey.values()) {
    let n = 0;
    let sum = 0;
    let lo: number | null = null;
    let hi: number | null = null;
    for (const h of a.hr) {
      if (h.hr_n > 0) {
        n += h.hr_n;
        sum += h.hr_sum ?? 0;
        lo = lo === null ? h.hr_min : Math.min(lo, h.hr_min ?? lo);
        hi = hi === null ? h.hr_max : Math.max(hi, h.hr_max ?? hi);
      }
    }
    const day: DayOut = {
      date: a.date,
      device_id: a.device_id,
      steps: a.steps,
      calories: a.calories,
      heart_rate_min: lo,
      heart_rate_max: hi,
      heart_rate_avg: n > 0 ? Math.round(sum / n) : null,
      battery_last: a.battery_last,
    };
    if (a.sleep_minutes !== undefined) day.sleep_minutes = a.sleep_minutes;
    if (a.nap_minutes !== undefined) day.nap_minutes = a.nap_minutes;
    if (a.score !== undefined) day.score = a.score;
    out.push(day);
  }
  return out.sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : x.device_id < y.device_id ? -1 : x.device_id > y.device_id ? 1 : 0));
}
