// REST API under /v1 (docs/API.md).

import { Hono, type Context } from "hono";
import type { AppEnv } from "../types";
import {
  MAX_SESSIONS_PER_ACCOUNT,
  SESSION_COOKIE,
  SESSION_TTL_SEC,
  accountForToken,
  clearSessionCookie,
  requireAuth,
  sessionCookie,
} from "../lib/auth";
import {
  UUID_RE,
  encryptSecret,
  hasHubSecret,
  ipKey,
  newSessionId,
  newToken,
  newWebhookSecret,
  sha256Hex,
  SESSION_RE,
  timingSafeEqualStr,
} from "../lib/crypto";
import { HttpError, LIMITS, clientIp, getCookie, isSameOrigin, readJson } from "../lib/http";
import { RATE_LIMITS, enforce } from "../lib/ratelimit";
import {
  countMinutes,
  countSamples,
  countScores,
  countSleeps,
  daySummaries,
  listDevices,
  minuteCursor,
  minuteOut,
  queryMinutes,
  querySamples,
  queryScoresByDate,
  queryScoresByTs,
  querySleeps,
  sampleOut,
  scoreCursor,
  scoreOut,
  sleepCursor,
  sleepOut,
  type MinuteCursor,
  type MinuteDbRow,
  type SampleDbRow,
  type ScoreCursor,
  type ScoreDbRow,
  type SleepCursor,
  type SleepDbRow,
} from "../lib/queries";
import { addDays, daysBetween, isDate, isValidTz, isoOut, localDate, parseIsoInstant, startOfLocalDay } from "../lib/time";
import { text, validateIngest, SCHEMA, type SampleRow } from "../lib/validate";
import {
  MAX_WEBHOOKS,
  checkWebhookUrl,
  deliver,
  forwardIngest,
  hookAad,
  type HookRow,
} from "../lib/webhooks";

export const api = new Hono<AppEnv>();

const bearerOnly = requireAuth({ session: false });
const anyAuth = requireAuth({ session: true });

const MAX_DEVICES_PER_ACCOUNT = 10;
const DEFAULT_SAMPLE_LIMIT = 1000;
const EXPORT_CHUNK = 5000;
const EXPORT_MAX_ROWS = 200_000;
const MAX_DAY_SPAN = 366;
const FAR_FUTURE_SLACK_MS = 3 * 86_400_000;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** True when `invite` matches one of the configured codes (case-insensitive, constant time). */
async function inviteAccepted(configured: string | undefined, invite: unknown): Promise<boolean> {
  if (typeof invite !== "string" || invite.length === 0 || invite.length > 64) return false;
  const given = invite.trim().toUpperCase();
  const codes = (configured ?? "").split(",").map((c) => c.trim().toUpperCase()).filter(Boolean);
  let ok = false;
  for (const code of codes) {
    if (await timingSafeEqualStr(given, code)) ok = true;
  }
  return ok;
}

function bad(message: string): HttpError {
  return new HttpError(400, "invalid_query", message);
}

// ---------------------------------------------------------------------------
// Accounts

api.post("/accounts", async (c) => {
  const db = c.env.DB;
  await enforce(db, RATE_LIMITS.accountsPerIp, await ipKey(c.env, clientIp(c.req.raw)));
  await enforce(db, RATE_LIMITS.accountsGlobal, "all");

  const raw = await readJson(c.req.raw, LIMITS.smallBytes);
  if (!isObject(raw)) throw new HttpError(400, "invalid_body", "$: nesne olmalı");
  const name = text(raw.device_name, "device_name", 100) as string;
  if (!isValidTz(raw.tz)) throw new HttpError(400, "invalid_body", "tz: geçerli bir IANA saat dilimi olmalı");
  if (!(await inviteAccepted(c.env.HUB_INVITE_CODES, raw.invite))) {
    throw new HttpError(403, "invalid_invite", "Davet kodu geçersiz.");
  }

  const id = crypto.randomUUID();
  const token = newToken();
  await db
    .prepare("INSERT INTO accounts (id, token_hash, tz, name, created_at) VALUES (?1, ?2, ?3, ?4, ?5)")
    .bind(id, await sha256Hex(token), raw.tz, name, Date.now())
    .run();

  console.log(JSON.stringify({ message: "account created", account_id: id }));
  return c.json({ account_id: id, token, web_url: `${new URL(c.req.url).origin}/login` }, 201);
});

api.get("/me", anyAuth, async (c) => {
  const a = c.get("account");
  const db = c.env.DB;
  const [counts, devices, hooks] = await Promise.all([
    db
      .prepare(
        `SELECT type, COUNT(*) AS n FROM samples WHERE account_id = ?1 GROUP BY type
         UNION ALL SELECT 'minute', COUNT(*) FROM minutes WHERE account_id = ?1
         UNION ALL SELECT 'sleep', COUNT(*) FROM sleeps WHERE account_id = ?1
         UNION ALL SELECT 'score', COUNT(*) FROM scores WHERE account_id = ?1`,
      )
      .bind(a.id)
      .all<{ type: string; n: number }>(),
    listDevices(db, a.id),
    db.prepare("SELECT COUNT(*) AS n FROM webhooks WHERE account_id = ?1").bind(a.id).first<{ n: number }>(),
  ]);
  const byType: Record<string, number> = { live: 0, battery: 0, minute: 0, sleep: 0, score: 0 };
  for (const r of counts.results) byType[r.type] = r.n;
  const total = Object.values(byType).reduce((x, y) => x + y, 0);
  return c.json({
    account_id: a.id,
    name: a.name,
    tz: a.tz,
    created_at: isoOut(a.created_at),
    samples: { ...byType, total },
    devices,
    webhooks: hooks?.n ?? 0,
  });
});

api.delete("/account", anyAuth, async (c) => {
  const a = c.get("account");
  const db = c.env.DB;
  // Explicit deletes (not only FK cascades) so nothing survives even if
  // foreign-key enforcement were off. One batch = one transaction.
  await db.batch([
    db.prepare("DELETE FROM samples WHERE account_id = ?1").bind(a.id),
    db.prepare("DELETE FROM minutes WHERE account_id = ?1").bind(a.id),
    db.prepare("DELETE FROM sleeps WHERE account_id = ?1").bind(a.id),
    db.prepare("DELETE FROM scores WHERE account_id = ?1").bind(a.id),
    db.prepare("DELETE FROM devices WHERE account_id = ?1").bind(a.id),
    db.prepare("DELETE FROM webhooks WHERE account_id = ?1").bind(a.id),
    db.prepare("DELETE FROM sessions WHERE account_id = ?1").bind(a.id),
    db.prepare("DELETE FROM rate_limits WHERE key LIKE ?1").bind(`%:${a.id}:%`),
    db.prepare("DELETE FROM accounts WHERE id = ?1").bind(a.id),
  ]);
  console.log(JSON.stringify({ message: "account deleted", account_id: a.id }));
  c.header("Set-Cookie", clearSessionCookie());
  return c.json({ deleted: true });
});

api.post("/token/rotate", anyAuth, async (c) => {
  const a = c.get("account");
  const db = c.env.DB;
  const token = newToken();
  const keep = c.get("sessionHash") ?? "";
  await db.batch([
    db
      .prepare("UPDATE accounts SET token_hash = ?1, token_rotated_at = ?2 WHERE id = ?3")
      .bind(await sha256Hex(token), Date.now(), a.id),
    // Sign out every other web session; keep the one that asked, if any.
    db.prepare("DELETE FROM sessions WHERE account_id = ?1 AND id_hash <> ?2").bind(a.id, keep),
  ]);
  return c.json({ token });
});

// ---------------------------------------------------------------------------
// Ingest

api.post("/ingest", bearerOnly, async (c) => {
  const a = c.get("account");
  const db = c.env.DB;
  await enforce(db, RATE_LIMITS.ingestPerAccount, a.id);

  const raw = await readJson(c.req.raw, LIMITS.ingestBytes);
  const now = Date.now();
  const { body, rows, count, ignored } = validateIngest(raw, now);
  if (count > 0) await enforce(db, RATE_LIMITS.samplesPerAccount, a.id, count);

  const dev = body.device;
  const known = await db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM devices WHERE account_id = ?1) AS n,
              EXISTS (SELECT 1 FROM devices WHERE account_id = ?1 AND id = ?2) AS known`,
    )
    .bind(a.id, dev.id)
    .first<{ n: number; known: number }>();
  if (!known?.known && (known?.n ?? 0) >= MAX_DEVICES_PER_ACCOUNT) {
    throw new HttpError(409, "too_many_devices", `Bir hesapta en fazla ${MAX_DEVICES_PER_ACCOUNT} bant olabilir.`);
  }

  const stmts: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO devices (account_id, id, name, model, app_version, first_seen, last_seen)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
         ON CONFLICT (account_id, id) DO UPDATE SET
           name = excluded.name,
           model = excluded.model,
           app_version = COALESCE(excluded.app_version, devices.app_version),
           last_seen = excluded.last_seen`,
      )
      .bind(a.id, dev.id, dev.name, dev.model, dev.app_version ?? null, now),
  ];
  // Each table gets one statement: rows travel as a single JSON parameter
  // and are expanded by json_each(). Statement indexes that write samples:
  const writes: number[] = [];
  const add = (stmt: D1PreparedStatement) => {
    writes.push(stmts.length);
    stmts.push(stmt);
  };
  if (rows.samples.length > 0) add(insertSamples(db, a.id, dev.id, now, rows.samples));
  if (rows.minutes.length > 0) add(upsertHealth(db, MINUTES_UPSERT, a.id, dev.id, now, rows.minutes));
  if (rows.sleeps.length > 0) add(upsertHealth(db, SLEEPS_UPSERT, a.id, dev.id, now, rows.sleeps));
  if (rows.scores.length > 0) add(upsertHealth(db, SCORES_UPSERT, a.id, dev.id, now, rows.scores));
  // The phone is the source of truth for the user's time zone.
  if (dev.tz && dev.tz !== a.tz) {
    stmts.push(db.prepare("UPDATE accounts SET tz = ?1 WHERE id = ?2").bind(dev.tz, a.id));
  }
  const results = await db.batch(stmts);
  const accepted = writes.reduce((n, i) => n + (results[i]?.meta.changes ?? 0), 0);
  const duplicates = count - accepted;

  if (accepted > 0) c.executionCtx.waitUntil(forwardIngest(c.env, a.id, body));
  return c.json(ignored > 0 ? { accepted, duplicates, ignored } : { accepted, duplicates });
});

/** live/battery: insert-or-ignore on (device, type, ts). */
function insertSamples(db: D1Database, accountId: string, deviceId: string, now: number, rows: SampleRow[]) {
  return db
    .prepare(
      `INSERT INTO samples (account_id, device_id, type, ts, steps, calories, heart_rate, standing_hours, level, received_at)
       SELECT ?1, ?2,
              json_extract(j.value, '$[0]'), json_extract(j.value, '$[1]'), json_extract(j.value, '$[2]'),
              json_extract(j.value, '$[3]'), json_extract(j.value, '$[4]'), json_extract(j.value, '$[5]'),
              json_extract(j.value, '$[6]'), ?3
         FROM json_each(?4) AS j
        WHERE 1
       ON CONFLICT (account_id, device_id, type, ts) DO NOTHING`,
    )
    .bind(accountId, deviceId, now, JSON.stringify(rows));
}

/**
 * Upsert SQL for a health table: the last write wins, but a row that arrives
 * unchanged is left alone, so it counts as a duplicate (meta.changes = 0)
 * and an identical re-sync does not fire webhooks again.
 */
function healthUpsert(table: string, cols: string[]): string {
  const values = cols.map((_, i) => `json_extract(j.value, '$[${i}]')`).join(", ");
  const data = cols.filter((c) => c !== "ts");
  return `INSERT INTO ${table} (account_id, device_id, ${cols.join(", ")}, received_at)
     SELECT ?1, ?2, ${values}, ?3
       FROM json_each(?4) AS j
      WHERE 1
     ON CONFLICT (account_id, device_id, ts) DO UPDATE SET
       ${data.map((c) => `${c} = excluded.${c}`).join(", ")}, received_at = excluded.received_at
     WHERE ${data.map((c) => `${table}.${c} IS NOT excluded.${c}`).join(" OR ")}`;
}

// Column order matches MinuteRow / SleepRow / ScoreRow in lib/validate.ts.
const MINUTES_UPSERT = healthUpsert("minutes", ["ts", "steps", "heart_rate", "spo2", "stress", "active_calories", "distance_m"]);
const SLEEPS_UPSERT = healthUpsert("sleeps", [
  "ts", "end_ts", "is_nap", "deep_min", "light_min", "rem_min", "awake_min", "wake_count", "efficiency", "stages",
  "hr_min", "spo2_avg", "spo2_min", "hrv_rmssd",
]);
const SCORES_UPSERT = healthUpsert("scores", [
  "ts", "date", "sleep_score", "recovery_score", "strain_score", "rhr", "hrv_rmssd",
  "conf_sleep", "conf_recovery", "conf_strain", "contributors", "algo",
]);

function upsertHealth(db: D1Database, sql: string, accountId: string, deviceId: string, now: number, rows: unknown[]) {
  return db.prepare(sql).bind(accountId, deviceId, now, JSON.stringify(rows));
}

// ---------------------------------------------------------------------------
// Reading data

function optDevice(c: Context<AppEnv>): string | undefined {
  const v = c.req.query("device");
  if (v === undefined || v === "") return undefined;
  if (!UUID_RE.test(v)) throw bad("device: UUID olmalı");
  return v.toUpperCase();
}

function optType(c: Context<AppEnv>): "live" | "battery" | undefined {
  const v = c.req.query("type");
  if (v === undefined || v === "") return undefined;
  if (v !== "live" && v !== "battery") throw bad('type: "live" ya da "battery" olmalı');
  return v;
}

/**
 * from/to accept an ISO 8601 instant (from inclusive, to exclusive) or a
 * YYYY-MM-DD date in the account's time zone (whole days, both inclusive).
 */
function timeRange(c: Context<AppEnv>, tz: string): { from: number; to: number } {
  const f = c.req.query("from");
  const t = c.req.query("to");
  let from = 0;
  let to = Date.now() + FAR_FUTURE_SLACK_MS;
  if (f) {
    const v = isDate(f) ? startOfLocalDay(f, tz) : parseIsoInstant(f);
    if (v === null) throw bad("from: YYYY-MM-DD ya da ISO 8601 zaman olmalı");
    from = v;
  }
  if (t) {
    const v = isDate(t) ? startOfLocalDay(addDays(t, 1), tz) : parseIsoInstant(t);
    if (v === null) throw bad("to: YYYY-MM-DD ya da ISO 8601 zaman olmalı");
    to = v;
  }
  if (from > to) throw bad("from, to'dan sonra olamaz");
  return { from, to };
}

function limitParam(c: Context<AppEnv>, def: number, max: number): number {
  const v = c.req.query("limit");
  if (v === undefined) return def;
  if (!/^\d+$/.test(v) || Number(v) < 1 || Number(v) > max) throw bad(`limit: 1 ile ${max} arasında olmalı`);
  return Number(v);
}

api.get("/samples", anyAuth, async (c) => {
  const a = c.get("account");
  const { from, to } = timeRange(c, a.tz);
  const limit = limitParam(c, DEFAULT_SAMPLE_LIMIT, LIMITS.maxSamples);
  const rows = await querySamples(c.env.DB, a.id, {
    from,
    to,
    device: optDevice(c),
    type: optType(c),
    limit: limit + 1,
  });
  const hasMore = rows.length > limit;
  return c.json({ samples: rows.slice(0, limit).map(sampleOut), has_more: hasMore });
});

api.get("/days", anyAuth, async (c) => {
  const a = c.get("account");
  const today = localDate(Date.now(), a.tz);
  const to = c.req.query("to") || today;
  const from = c.req.query("from") || addDays(to, -13);
  if (!isDate(from)) throw bad("from: YYYY-MM-DD olmalı");
  if (!isDate(to)) throw bad("to: YYYY-MM-DD olmalı");
  const span = daysBetween(from, to);
  if (span < 0) throw bad("from, to'dan sonra olamaz");
  if (span >= MAX_DAY_SPAN) throw bad(`En fazla ${MAX_DAY_SPAN} gün istenebilir`);
  const days = await daySummaries(c.env.DB, a.id, a.tz, from, to, optDevice(c));
  return c.json({ tz: a.tz, from, to, days });
});

// ---------------------------------------------------------------------------
// Health data: minutes, sleep sessions, daily scores

/**
 * `next` is an opaque cursor: pass it back as `after` to get the following
 * page. Built from the ORDER BY columns, so pages never skip or repeat rows,
 * even when several bands share a timestamp.
 */
function paged<R>(rows: R[], limit: number, cursorOf: (r: R) => Array<string | number>) {
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  const hasMore = rows.length > limit;
  return { items, has_more: hasMore, next: hasMore && last !== undefined ? cursorOf(last).join("_") : null };
}

function parseAfter<C>(c: Context<AppEnv>, re: RegExp, build: (m: RegExpExecArray) => C): C | undefined {
  const v = c.req.query("after");
  if (v === undefined || v === "") return undefined;
  const m = re.exec(v);
  if (!m) throw bad("after: önceki cevabın next değeri olmalı");
  return build(m);
}

const DEV = "([0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12})";
const MINUTE_AFTER = new RegExp(`^(\\d{1,15})_${DEV}$`);
const SLEEP_AFTER = new RegExp(`^(\\d{1,15})_${DEV}_(\\d{1,15})$`);
const SCORE_AFTER = new RegExp(`^(\\d{4}-\\d{2}-\\d{2})_${DEV}_(\\d{1,15})$`);
const up = (s: string | undefined): string => (s ?? "").toUpperCase();

api.get("/minutes", anyAuth, async (c) => {
  const a = c.get("account");
  const { from, to } = timeRange(c, a.tz);
  const limit = limitParam(c, 1440, LIMITS.maxSamples);
  const after = parseAfter(c, MINUTE_AFTER, (m): MinuteCursor => [Number(m[1]), up(m[2])]);
  const rows = await queryMinutes(c.env.DB, a.id, { from, to, device: optDevice(c), limit: limit + 1, after });
  const p = paged(rows, limit, minuteCursor);
  return c.json({ minutes: p.items.map(minuteOut), has_more: p.has_more, next: p.next });
});

/** Sessions are filtered and ordered by wake time (`end`): a night belongs to the day it ends. */
api.get("/sleep", anyAuth, async (c) => {
  const a = c.get("account");
  const { from, to } = timeRange(c, a.tz);
  const limit = limitParam(c, 100, 1000);
  const after = parseAfter(c, SLEEP_AFTER, (m): SleepCursor => [Number(m[1]), up(m[2]), Number(m[3])]);
  const rows = await querySleeps(c.env.DB, a.id, { from, to, device: optDevice(c), limit: limit + 1, after });
  const p = paged(rows, limit, sleepCursor);
  return c.json({ sleep: p.items.map(sleepOut), has_more: p.has_more, next: p.next });
});

/** Daily scores by their own `date` (the phone's local day); from/to are YYYY-MM-DD, both inclusive. */
api.get("/scores", anyAuth, async (c) => {
  const a = c.get("account");
  const from = c.req.query("from") || "0000-01-01";
  const to = c.req.query("to") || "9999-12-31";
  if (c.req.query("from") && !isDate(from)) throw bad("from: YYYY-MM-DD olmalı");
  if (c.req.query("to") && !isDate(to)) throw bad("to: YYYY-MM-DD olmalı");
  if (from > to) throw bad("from, to'dan sonra olamaz");
  const limit = limitParam(c, 366, 1000);
  const after = parseAfter(c, SCORE_AFTER, (m): ScoreCursor => [m[1] ?? "", up(m[2]), Number(m[3])]);
  const rows = await queryScoresByDate(c.env.DB, a.id, { from, to, device: optDevice(c), limit: limit + 1, after });
  const p = paged(rows, limit, scoreCursor);
  return c.json({ scores: p.items.map(scoreOut), has_more: p.has_more, next: p.next });
});

// ---------------------------------------------------------------------------
// Export (streamed in keyset-paginated chunks)

const EXPORT_TYPES = ["live", "battery", "minute", "sleep", "score"] as const;
type ExportType = (typeof EXPORT_TYPES)[number];

interface ExportQuery {
  from: number;
  to: number;
  device?: string | undefined;
  type?: ExportType | undefined;
}

function optExportType(c: Context<AppEnv>): ExportType | undefined {
  const v = c.req.query("type");
  if (v === undefined || v === "") return undefined;
  if (!(EXPORT_TYPES as readonly string[]).includes(v)) throw bad(`type: ${EXPORT_TYPES.join(", ")} olmalı`);
  return v as ExportType;
}

/** Which tables an export covers: everything, or the one holding `type`. */
function exportParts(type: ExportType | undefined) {
  return {
    samples: !type || type === "live" || type === "battery",
    minutes: !type || type === "minute",
    sleep: !type || type === "sleep",
    scores: !type || type === "score",
  };
}

const sampleType = (t: ExportType | undefined): "live" | "battery" | undefined =>
  t === "live" || t === "battery" ? t : undefined;

async function* chunks<R, C>(fetch: (after: C | undefined) => Promise<R[]>, cursorOf: (r: R) => C): AsyncGenerator<R[]> {
  let after: C | undefined;
  for (;;) {
    const rows = await fetch(after);
    if (rows.length > 0) yield rows;
    if (rows.length < EXPORT_CHUNK) return;
    after = cursorOf(rows[rows.length - 1] as R);
  }
}

const exportSamples = (db: D1Database, accountId: string, q: ExportQuery) =>
  chunks<SampleDbRow, [number, string, string]>(
    (after) => querySamples(db, accountId, { ...q, type: sampleType(q.type), limit: EXPORT_CHUNK, after }),
    (r) => [r.ts, r.device_id, r.type],
  );
const exportMinutes = (db: D1Database, accountId: string, q: ExportQuery) =>
  chunks<MinuteDbRow, MinuteCursor>((after) => queryMinutes(db, accountId, { ...q, limit: EXPORT_CHUNK, after }), minuteCursor);
const exportSleeps = (db: D1Database, accountId: string, q: ExportQuery) =>
  chunks<SleepDbRow, SleepCursor>((after) => querySleeps(db, accountId, { ...q, limit: EXPORT_CHUNK, after }), sleepCursor);
const exportScores = (db: D1Database, accountId: string, q: ExportQuery) =>
  chunks<ScoreDbRow, ScoreCursor>((after) => queryScoresByTs(db, accountId, { ...q, limit: EXPORT_CHUNK, after }), scoreCursor);

function textStream(gen: AsyncGenerator<string>): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await gen.next();
        if (done) controller.close();
        else controller.enqueue(enc.encode(value));
      } catch (err) {
        controller.error(err);
      }
    },
    async cancel() {
      await gen.return(undefined);
    },
  });
}

/** RFC 4180 cell: quoted only when it holds a comma, quote or line break (JSON columns). */
const csvCell = (v: unknown): string => {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

async function* csvLines<R>(header: string, gen: AsyncGenerator<R[]>, cells: (r: R) => unknown[]): AsyncGenerator<string> {
  yield header + "\n";
  for await (const rows of gen) {
    let chunk = "";
    for (const r of rows) chunk += cells(r).map(csvCell).join(",") + "\n";
    yield chunk;
  }
}

async function prepareExport(c: Context<AppEnv>) {
  const a = c.get("account");
  const db = c.env.DB;
  const { from, to } = timeRange(c, a.tz);
  const q: ExportQuery = { from, to, device: optDevice(c), type: optExportType(c) };
  const parts = exportParts(q.type);
  const counts = await Promise.all([
    parts.samples ? countSamples(db, a.id, { ...q, type: sampleType(q.type) }) : 0,
    parts.minutes ? countMinutes(db, a.id, q) : 0,
    parts.sleep ? countSleeps(db, a.id, q) : 0,
    parts.scores ? countScores(db, a.id, q) : 0,
  ]);
  const n = counts.reduce((x, y) => x + y, 0);
  if (n > EXPORT_MAX_ROWS) {
    throw new HttpError(
      413,
      "export_too_large",
      `Bu aralıkta ${n} örnek var; tek seferde en fazla ${EXPORT_MAX_ROWS}. from/to ile aralığı daralt.`,
    );
  }
  const stamp = localDate(Date.now(), a.tz);
  return { a, q, parts, stamp };
}

/**
 * CSV is one flat table per file: live and battery samples by default (or
 * with type=live|battery), and minute, sleep or score with type=…
 */
api.get("/export.csv", anyAuth, async (c) => {
  const { a, q, stamp } = await prepareExport(c);
  const db = c.env.DB;
  let lines: AsyncGenerator<string>;
  let name = `freeband-${stamp}.csv`;
  if (q.type === "minute") {
    name = `freeband-minute-${stamp}.csv`;
    lines = csvLines("device_id,type,ts,steps,heart_rate,spo2,stress,active_calories,distance_m", exportMinutes(db, a.id, q), (r) => [
      r.device_id, "minute", isoOut(r.ts), r.steps, r.heart_rate, r.spo2, r.stress, r.active_calories, r.distance_m,
    ]);
  } else if (q.type === "sleep") {
    name = `freeband-sleep-${stamp}.csv`;
    lines = csvLines(
      "device_id,type,ts,end,is_nap,deep,light,rem,awake,wake_count,efficiency,hr_min,spo2_avg,spo2_min,hrv_rmssd,stages",
      exportSleeps(db, a.id, q),
      (r) => [
        r.device_id, "sleep", isoOut(r.ts), isoOut(r.end_ts), r.is_nap === 1, r.deep_min, r.light_min, r.rem_min, r.awake_min,
        r.wake_count, r.efficiency, r.hr_min, r.spo2_avg, r.spo2_min, r.hrv_rmssd, r.stages,
      ],
    );
  } else if (q.type === "score") {
    name = `freeband-score-${stamp}.csv`;
    lines = csvLines(
      "device_id,type,ts,date,sleep,recovery,strain,rhr,hrv_rmssd,confidence_sleep,confidence_recovery,confidence_strain,algo,contributors",
      exportScores(db, a.id, q),
      (r) => [
        r.device_id, "score", isoOut(r.ts), r.date, r.sleep_score, r.recovery_score, r.strain_score, r.rhr, r.hrv_rmssd,
        r.conf_sleep, r.conf_recovery, r.conf_strain, r.algo, r.contributors,
      ],
    );
  } else {
    lines = csvLines("device_id,type,ts,steps,calories,heart_rate,standing_hours,level", exportSamples(db, a.id, q), (r) => [
      r.device_id, r.type, isoOut(r.ts), r.steps, r.calories, r.heart_rate, r.standing_hours, r.level,
    ]);
  }
  return new Response(textStream(lines), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${name}"`,
    },
  });
});

async function* jsonArray<R>(name: string, gen: AsyncGenerator<R[]> | null, out: (r: R) => unknown): AsyncGenerator<string> {
  yield `,"${name}":[`;
  let first = true;
  if (gen) {
    for await (const rows of gen) {
      yield (first ? "\n" : ",\n") + rows.map((r) => JSON.stringify(out(r))).join(",\n");
      first = false;
    }
  }
  yield first ? "]" : "\n]";
}

/** JSON holds every type: samples (live, battery), minutes, sleep and scores, each as in /v1/... */
api.get("/export.json", anyAuth, async (c) => {
  const { a, q, parts, stamp } = await prepareExport(c);
  const db = c.env.DB;
  const devices = await listDevices(db, a.id);
  async function* doc(): AsyncGenerator<string> {
    const head = {
      schema: SCHEMA,
      exported_at: isoOut(Date.now()),
      account_id: a.id,
      tz: a.tz,
      from: isoOut(q.from),
      to: isoOut(q.to),
      devices: q.device ? devices.filter((d) => d.id === q.device) : devices,
    };
    yield JSON.stringify(head).slice(0, -1);
    yield* jsonArray("samples", parts.samples ? exportSamples(db, a.id, q) : null, sampleOut);
    yield* jsonArray("minutes", parts.minutes ? exportMinutes(db, a.id, q) : null, minuteOut);
    yield* jsonArray("sleep", parts.sleep ? exportSleeps(db, a.id, q) : null, sleepOut);
    yield* jsonArray("scores", parts.scores ? exportScores(db, a.id, q) : null, scoreOut);
    yield "}\n";
  }
  return new Response(textStream(doc()), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="freeband-${stamp}.json"`,
    },
  });
});

// ---------------------------------------------------------------------------
// Webhooks

interface HookPublic {
  id: string;
  url: string;
  created_at: number;
  last_delivery_at: number | null;
  last_status: number | null;
  last_error: string | null;
}

const HOOK_PUBLIC_COLS = "id, url, created_at, last_delivery_at, last_status, last_error";

function hookOut(h: HookPublic) {
  return {
    id: h.id,
    url: h.url,
    created_at: isoOut(h.created_at),
    last_delivery_at: h.last_delivery_at === null ? null : isoOut(h.last_delivery_at),
    last_status: h.last_status,
    last_error: h.last_error,
  };
}

function hookId(c: Context<AppEnv>): string {
  const id = c.req.param("id") ?? "";
  if (!UUID_RE.test(id)) throw new HttpError(404, "not_found", "Webhook bulunamadı.");
  return id.toLowerCase();
}

function ownHosts(c: Context<AppEnv>): string[] {
  return [c.env.PUBLIC_HOSTNAME, new URL(c.req.url).hostname];
}

api.get("/webhooks", anyAuth, async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT ${HOOK_PUBLIC_COLS} FROM webhooks WHERE account_id = ?1 ORDER BY created_at`,
  )
    .bind(c.get("account").id)
    .all<HookPublic>();
  return c.json({ webhooks: results.map(hookOut) });
});

api.get("/webhooks/:id", anyAuth, async (c) => {
  const row = await c.env.DB.prepare(`SELECT ${HOOK_PUBLIC_COLS} FROM webhooks WHERE id = ?1 AND account_id = ?2`)
    .bind(hookId(c), c.get("account").id)
    .first<HookPublic>();
  if (!row) throw new HttpError(404, "not_found", "Webhook bulunamadı.");
  return c.json(hookOut(row));
});

api.post("/webhooks", anyAuth, async (c) => {
  if (!hasHubSecret(c.env)) {
    throw new HttpError(503, "not_configured", "Webhook'lar bu sunucuda henüz yapılandırılmadı.");
  }
  const a = c.get("account");
  const db = c.env.DB;
  const raw = await readJson(c.req.raw, LIMITS.smallBytes);
  if (!isObject(raw)) throw new HttpError(400, "invalid_body", "$: nesne olmalı");
  const check = checkWebhookUrl(raw.url, ownHosts(c));
  if (!check.ok) throw new HttpError(400, "invalid_body", check.message);

  const existing = await db
    .prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(url = ?2), 0) AS same FROM webhooks WHERE account_id = ?1`,
    )
    .bind(a.id, check.url)
    .first<{ n: number; same: number }>();
  if ((existing?.same ?? 0) > 0) throw new HttpError(409, "duplicate", "Bu adres zaten ekli.");
  if ((existing?.n ?? 0) >= MAX_WEBHOOKS) {
    throw new HttpError(409, "webhook_limit", `En fazla ${MAX_WEBHOOKS} webhook eklenebilir.`);
  }

  const id = crypto.randomUUID();
  const secret = newWebhookSecret();
  const createdAt = Date.now();
  const secretEnc = await encryptSecret(c.env, secret, hookAad({ account_id: a.id, id }));
  // Conditional insert keeps the 5-per-account cap even under concurrent requests.
  const res = await db
    .prepare(
      `INSERT INTO webhooks (id, account_id, url, secret_enc, created_at)
       SELECT ?1, ?2, ?3, ?4, ?5
        WHERE (SELECT COUNT(*) FROM webhooks WHERE account_id = ?2) < ?6
       ON CONFLICT DO NOTHING`,
    )
    .bind(id, a.id, check.url, secretEnc, createdAt, MAX_WEBHOOKS)
    .run();
  if (!res.meta.changes) {
    throw new HttpError(409, "webhook_limit", `En fazla ${MAX_WEBHOOKS} webhook eklenebilir.`);
  }
  return c.json({ id, url: check.url, secret, created_at: isoOut(createdAt) }, 201);
});

api.delete("/webhooks/:id", anyAuth, async (c) => {
  const res = await c.env.DB.prepare("DELETE FROM webhooks WHERE id = ?1 AND account_id = ?2")
    .bind(hookId(c), c.get("account").id)
    .run();
  if (!res.meta.changes) throw new HttpError(404, "not_found", "Webhook bulunamadı.");
  return c.json({ deleted: true });
});

api.post("/webhooks/:id/test", anyAuth, async (c) => {
  const a = c.get("account");
  const id = hookId(c);
  const hook = await c.env.DB.prepare(
    "SELECT id, account_id, url, secret_enc FROM webhooks WHERE id = ?1 AND account_id = ?2",
  )
    .bind(id, a.id)
    .first<HookRow>();
  if (!hook) throw new HttpError(404, "not_found", "Webhook bulunamadı.");
  await enforce(c.env.DB, RATE_LIMITS.webhookTestPerAccount, a.id);
  const body = new TextEncoder().encode(
    JSON.stringify({ schema: SCHEMA, event: "ping", sent_at: isoOut(Date.now()), webhook_id: hook.id }),
  );
  return c.json(await deliver(c.env, hook, "ping", body));
});

// ---------------------------------------------------------------------------
// Web panel session

api.post("/session", async (c) => {
  if (!isSameOrigin(c.req.raw)) {
    throw new HttpError(403, "cross_origin", "Giriş yalnız Freeband sayfasından yapılabilir.");
  }
  const db = c.env.DB;
  await enforce(db, RATE_LIMITS.sessionPerIp, await ipKey(c.env, clientIp(c.req.raw)));
  const raw = await readJson(c.req.raw, LIMITS.smallBytes);
  const token = isObject(raw) && typeof raw.token === "string" ? raw.token.trim() : "";
  const account = await accountForToken(db, token);
  if (!account) throw new HttpError(401, "invalid_token", "Bu anahtar geçerli değil.");

  const sid = newSessionId();
  const now = Date.now();
  await db.batch([
    db
      .prepare("INSERT INTO sessions (id_hash, account_id, created_at, expires_at) VALUES (?1, ?2, ?3, ?4)")
      .bind(await sha256Hex(sid), account.id, now, now + SESSION_TTL_SEC * 1000),
    // Keep at most N sessions per account; drop the oldest.
    db
      .prepare(
        `DELETE FROM sessions WHERE account_id = ?1 AND id_hash NOT IN (
           SELECT id_hash FROM sessions WHERE account_id = ?1 ORDER BY created_at DESC LIMIT ?2)`,
      )
      .bind(account.id, MAX_SESSIONS_PER_ACCOUNT),
  ]);
  c.header("Set-Cookie", sessionCookie(sid, SESSION_TTL_SEC));
  return c.json({ ok: true, expires_at: isoOut(now + SESSION_TTL_SEC * 1000) });
});

api.delete("/session", async (c) => {
  if (!isSameOrigin(c.req.raw)) {
    throw new HttpError(403, "cross_origin", "Çıkış yalnız Freeband sayfasından yapılabilir.");
  }
  const sid = getCookie(c.req.raw, SESSION_COOKIE);
  if (sid && SESSION_RE.test(sid)) {
    await c.env.DB.prepare("DELETE FROM sessions WHERE id_hash = ?1").bind(await sha256Hex(sid)).run();
  }
  c.header("Set-Cookie", clearSessionCookie());
  return c.json({ ok: true });
});

api.all("*", (c) => c.json({ error: "not_found", message: "Böyle bir uç nokta yok." }, 404));

