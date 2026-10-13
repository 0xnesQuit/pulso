// Validation of the freeband.v1 ingest body (docs/API.md).
// Everything is checked; unknown fields are dropped from the normalized result.
// Samples of a type this hub does not know are skipped (counted as ignored),
// so the contract can grow additively.

import { HttpError, LIMITS } from "./http";
import { UUID_RE } from "./crypto";
import { isDate, isValidTz, parseIsoUtc } from "./time";

export const SCHEMA = "freeband.v1";
export const MODELS = ["band10", "band10pro"] as const;
export type Model = (typeof MODELS)[number];

export const EVENTS = ["sync.completed", "sync.partial"] as const;
export type SyncEvent = (typeof EVENTS)[number];

/** A heart rate inside this range is a reading; anything else (0 = not measured) is not. */
export const HR_MIN = 30;
export const HR_MAX = 220;
export const isHeartRate = (v: number | null | undefined): v is number =>
  typeof v === "number" && v >= HR_MIN && v <= HR_MAX;

export const SLEEP_STAGES = ["deep", "light", "rem", "awake"] as const;
export type SleepStage = (typeof SLEEP_STAGES)[number];
export const CONFIDENCE = ["high", "medium", "low", "none"] as const;
export type Confidence = (typeof CONFIDENCE)[number];
const SCORE_NAMES = ["sleep", "recovery", "strain"] as const;

const FUTURE_SLACK_MS = 2 * 86_400_000;
const EARLIEST_TS = Date.UTC(2020, 0, 1);
const MINUTE_MS = 60_000;
const DAY_MIN = 1440;
const MAX_SLEEP_MS = 24 * 3_600_000;
const MAX_STAGES = 1440;
const MAX_CONTRIBUTORS = 32;
/** Local midnight lies within UTC-12 … UTC+14 of the calendar date. */
const MIDNIGHT_EARLY_MS = 14 * 3_600_000;
const MIDNIGHT_LATE_MS = 12 * 3_600_000;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const TYPE_RE = /^[a-z][a-z0-9_.]{0,31}$/;
const KEY_RE = /^[a-z][a-z0-9_]{0,31}$/;
const ALGO_RE = /^[A-Za-z0-9][A-Za-z0-9._/+-]{0,39}$/;

export interface DeviceIn {
  id: string;
  name: string;
  model: Model;
  app_version?: string;
  tz?: string;
}

export interface SummaryIn {
  date?: string;
  steps?: number;
  calories?: number;
  heart_rate_last?: number;
  battery?: number;
}

export interface MinuteIn {
  type: "minute";
  ts: string;
  steps: number;
  heart_rate?: number;
  spo2?: number;
  stress?: number;
  active_calories?: number;
  distance_m?: number;
}

export type StageIn = [number, SleepStage, number];

export interface SleepIn {
  type: "sleep";
  ts: string;
  end: string;
  is_nap: boolean;
  minutes: { deep: number; light: number; rem: number; awake: number };
  wake_count: number;
  efficiency: number;
  stages: StageIn[];
  hr_min: number | null;
  spo2_avg: number | null;
  spo2_min: number | null;
  hrv_rmssd?: number;
}

export interface ContributorIn {
  key: string;
  score?: (typeof SCORE_NAMES)[number];
  weight?: number;
  value?: number | null;
  unit?: string;
  subscore?: number | null;
  baseline?: number | null;
  note?: string;
}

export interface ScoreIn {
  type: "score";
  ts: string;
  date: string;
  sleep: number | null;
  recovery: number | null;
  strain: number | null;
  rhr: number | null;
  hrv_rmssd: number | null;
  confidence: { sleep: Confidence; recovery: Confidence; strain: Confidence };
  contributors: ContributorIn[];
  algo: string;
}

export type SampleIn =
  | { type: "live"; ts: string; steps: number; calories: number; heart_rate: number; standing_hours?: number }
  | { type: "battery"; ts: string; level: number }
  | MinuteIn
  | SleepIn
  | ScoreIn;

export interface IngestBody {
  schema: typeof SCHEMA;
  event: SyncEvent;
  device: DeviceIn;
  sent_at: string;
  summary?: SummaryIn;
  samples: SampleIn[];
}

/** Compact row for the json_each() bulk insert: [type, ts_ms, steps, calories, hr, standing, level]. */
export type SampleRow = [string, number, number | null, number | null, number | null, number | null, number | null];
/** [ts_ms, steps, heart_rate, spo2, stress, active_calories, distance_m] */
export type MinuteRow = [number, number, number | null, number | null, number | null, number | null, number | null];
/** [ts_ms, end_ms, is_nap, deep, light, rem, awake, wake_count, efficiency, stages_json, hr_min, spo2_avg, spo2_min, hrv_rmssd] */
export type SleepRow = [
  number, number, 0 | 1, number, number, number, number, number, number, string,
  number | null, number | null, number | null, number | null,
];
/** [ts_ms, date, sleep, recovery, strain, rhr, hrv_rmssd, conf_sleep, conf_recovery, conf_strain, contributors_json, algo] */
export type ScoreRow = [
  number, string, number | null, number | null, number | null, number | null, number | null,
  Confidence, Confidence, Confidence, string, string,
];

export interface IngestRows {
  samples: SampleRow[];
  /** Upsert types: one row per ts, the last occurrence in the body wins. */
  minutes: MinuteRow[];
  sleeps: SleepRow[];
  scores: ScoreRow[];
}

export interface ValidatedIngest {
  body: IngestBody;
  rows: IngestRows;
  /** Number of validated samples in the body (in-body repeats included). */
  count: number;
  /** Samples skipped because their type is unknown to this hub. */
  ignored: number;
}

function fail(path: string, rule: string): never {
  throw new HttpError(400, "invalid_body", `${path}: ${rule}`);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const absent = (v: unknown): v is undefined | null => v === undefined || v === null;

function int(v: unknown, path: string, min: number, max: number): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) {
    fail(path, `${min} ile ${max} arasında tam sayı olmalı`);
  }
  return v;
}

function optInt(v: unknown, path: string, min: number, max: number): number | undefined {
  return absent(v) ? undefined : int(v, path, min, max);
}

/** Finite number (decimals allowed) in [min, max]. */
function num(v: unknown, path: string, min: number, max: number): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) {
    fail(path, `${min} ile ${max} arasında sayı olmalı`);
  }
  return v;
}

function optNum(v: unknown, path: string, min: number, max: number): number | undefined {
  return absent(v) ? undefined : num(v, path, min, max);
}

function oneOf<T extends string>(v: unknown, path: string, allowed: readonly T[]): T {
  if (typeof v !== "string" || !(allowed as readonly string[]).includes(v)) {
    fail(path, allowed.map((a) => `"${a}"`).join(", ") + " değerlerinden biri olmalı");
  }
  return v as T;
}

export function text(v: unknown, path: string, maxLen: number, required = true): string | undefined {
  if (v === undefined || v === null) {
    if (required) fail(path, "gerekli");
    return undefined;
  }
  if (typeof v !== "string") fail(path, "metin olmalı");
  const s = v.trim();
  if (s.length === 0 && required) fail(path, "boş olamaz");
  if (s.length > maxLen) fail(path, `en fazla ${maxLen} karakter olabilir`);
  if (CONTROL_RE.test(s)) fail(path, "kontrol karakteri içeremez");
  return s;
}

export function deviceId(v: unknown, path: string): string {
  if (typeof v !== "string" || !UUID_RE.test(v)) fail(path, "UUID olmalı");
  return v.toUpperCase();
}

function timestamp(v: unknown, path: string, now: number): { iso: string; ms: number } {
  const ms = parseIsoUtc(v);
  if (ms === null) fail(path, "ISO 8601 UTC zaman olmalı (ör. 2026-10-13T20:59:41Z)");
  if (ms > now + FUTURE_SLACK_MS) fail(path, "en fazla 2 gün ileride olabilir");
  if (ms < EARLIEST_TS) fail(path, "2020'den önce olamaz");
  return { iso: v as string, ms };
}

// ---------------------------------------------------------------------------
// Health types

function validateMinute(item: Record<string, unknown>, p: string, ts: { iso: string; ms: number }): { s: MinuteIn; row: MinuteRow } {
  if (ts.ms % MINUTE_MS !== 0) fail(`${p}.ts`, "dakika başı olmalı (saniye 0)");
  const steps = int(item.steps, `${p}.steps`, 0, 1000);
  const hr = optInt(item.heart_rate, `${p}.heart_rate`, HR_MIN, HR_MAX);
  const spo2 = optInt(item.spo2, `${p}.spo2`, 70, 100);
  const stress = optInt(item.stress, `${p}.stress`, 1, 100);
  const kcal = optInt(item.active_calories, `${p}.active_calories`, 0, 100);
  const dist = optInt(item.distance_m, `${p}.distance_m`, 0, 1000);
  const s: MinuteIn = { type: "minute", ts: ts.iso, steps };
  if (hr !== undefined) s.heart_rate = hr;
  if (spo2 !== undefined) s.spo2 = spo2;
  if (stress !== undefined) s.stress = stress;
  if (kcal !== undefined) s.active_calories = kcal;
  if (dist !== undefined) s.distance_m = dist;
  return { s, row: [ts.ms, steps, hr ?? null, spo2 ?? null, stress ?? null, kcal ?? null, dist ?? null] };
}

function validateSleep(
  item: Record<string, unknown>,
  p: string,
  ts: { iso: string; ms: number },
  now: number,
): { s: SleepIn; row: SleepRow } {
  const end = timestamp(item.end, `${p}.end`, now);
  if (end.ms <= ts.ms) fail(`${p}.end`, "ts'den sonra olmalı");
  if (end.ms - ts.ms > MAX_SLEEP_MS) fail(`${p}.end`, "oturum en fazla 24 saat sürebilir");
  if (typeof item.is_nap !== "boolean") fail(`${p}.is_nap`, "true ya da false olmalı");

  const m = item.minutes;
  if (!isObject(m)) fail(`${p}.minutes`, "nesne olmalı");
  const minutes = {
    deep: int(m.deep, `${p}.minutes.deep`, 0, DAY_MIN),
    light: int(m.light, `${p}.minutes.light`, 0, DAY_MIN),
    rem: int(m.rem, `${p}.minutes.rem`, 0, DAY_MIN),
    awake: int(m.awake, `${p}.minutes.awake`, 0, DAY_MIN),
  };
  if (minutes.deep + minutes.light + minutes.rem + minutes.awake > DAY_MIN) {
    fail(`${p}.minutes`, `toplamı ${DAY_MIN}'ı aşamaz`);
  }
  const wakeCount = int(item.wake_count, `${p}.wake_count`, 0, 255);
  const efficiency = int(item.efficiency, `${p}.efficiency`, 0, 100);

  const rawStages = item.stages;
  if (!Array.isArray(rawStages)) fail(`${p}.stages`, "dizi olmalı");
  if (rawStages.length > MAX_STAGES) fail(`${p}.stages`, `en fazla ${MAX_STAGES} evre olabilir`);
  const span = Math.ceil((end.ms - ts.ms) / MINUTE_MS);
  let prev = 0;
  const stages: StageIn[] = rawStages.map((st: unknown, j: number) => {
    const sp = `${p}.stages[${j}]`;
    if (!Array.isArray(st) || st.length !== 3) fail(sp, "[offset_min, evre, dur_min] olmalı");
    const offset = int(st[0], `${sp}[0]`, 0, DAY_MIN);
    const stage = oneOf(st[1], `${sp}[1]`, SLEEP_STAGES);
    const dur = int(st[2], `${sp}[2]`, 1, DAY_MIN);
    if (offset < prev) fail(`${sp}[0]`, "evreler başlangıca göre sıralı olmalı");
    if (offset + dur > span) fail(sp, "oturumun (ts–end) dışına taşamaz");
    prev = offset;
    return [offset, stage, dur];
  });

  const hrMin = optInt(item.hr_min, `${p}.hr_min`, HR_MIN, HR_MAX) ?? null;
  const spo2Avg = optNum(item.spo2_avg, `${p}.spo2_avg`, 70, 100) ?? null;
  const spo2Min = optInt(item.spo2_min, `${p}.spo2_min`, 70, 100) ?? null;
  if (spo2Avg !== null && spo2Min !== null && spo2Min > spo2Avg) fail(`${p}.spo2_min`, "spo2_avg'den büyük olamaz");
  const hrv = optNum(item.hrv_rmssd, `${p}.hrv_rmssd`, 1, 300);

  const s: SleepIn = {
    type: "sleep",
    ts: ts.iso,
    end: end.iso,
    is_nap: item.is_nap,
    minutes,
    wake_count: wakeCount,
    efficiency,
    stages,
    hr_min: hrMin,
    spo2_avg: spo2Avg,
    spo2_min: spo2Min,
  };
  if (hrv !== undefined) s.hrv_rmssd = hrv;
  const row: SleepRow = [
    ts.ms, end.ms, item.is_nap ? 1 : 0, minutes.deep, minutes.light, minutes.rem, minutes.awake,
    wakeCount, efficiency, JSON.stringify(stages), hrMin, spo2Avg, spo2Min, hrv ?? null,
  ];
  return { s, row };
}

function validateContributor(v: unknown, p: string): ContributorIn {
  if (!isObject(v)) fail(p, "nesne olmalı");
  if (typeof v.key !== "string" || !KEY_RE.test(v.key)) fail(`${p}.key`, "küçük harfli kısa bir ad olmalı (ör. duration)");
  const c: ContributorIn = { key: v.key };
  if (!absent(v.score)) c.score = oneOf(v.score, `${p}.score`, SCORE_NAMES);
  const weight = optNum(v.weight, `${p}.weight`, 0, 100);
  if (weight !== undefined) c.weight = weight;
  if (v.value !== undefined) c.value = v.value === null ? null : num(v.value, `${p}.value`, -1e6, 1e6);
  const unit = text(v.unit, `${p}.unit`, 12, false);
  if (unit) c.unit = unit;
  if (v.subscore !== undefined) c.subscore = v.subscore === null ? null : num(v.subscore, `${p}.subscore`, 0, 100);
  if (v.baseline !== undefined) c.baseline = v.baseline === null ? null : num(v.baseline, `${p}.baseline`, -1e6, 1e6);
  const note = text(v.note, `${p}.note`, 120, false);
  if (note) c.note = note;
  return c;
}

function validateScore(item: Record<string, unknown>, p: string, ts: { iso: string; ms: number }): { s: ScoreIn; row: ScoreRow } {
  if (!isDate(item.date)) fail(`${p}.date`, "YYYY-MM-DD olmalı");
  const date = item.date;
  const utcMidnight = Date.parse(date + "T00:00:00Z");
  if (ts.ms % MINUTE_MS !== 0 || ts.ms < utcMidnight - MIDNIGHT_EARLY_MS || ts.ms > utcMidnight + MIDNIGHT_LATE_MS) {
    fail(`${p}.ts`, "date gününün yerel gece yarısı olmalı");
  }
  const sleep = optInt(item.sleep, `${p}.sleep`, 0, 100) ?? null;
  const recovery = optInt(item.recovery, `${p}.recovery`, 0, 100) ?? null;
  const strain = optNum(item.strain, `${p}.strain`, 0, 21) ?? null;
  const rhr = optInt(item.rhr, `${p}.rhr`, HR_MIN, HR_MAX) ?? null;
  const hrv = optNum(item.hrv_rmssd, `${p}.hrv_rmssd`, 1, 300) ?? null;

  const cf = item.confidence;
  if (!isObject(cf)) fail(`${p}.confidence`, "nesne olmalı");
  const confidence = {
    sleep: oneOf(cf.sleep, `${p}.confidence.sleep`, CONFIDENCE),
    recovery: oneOf(cf.recovery, `${p}.confidence.recovery`, CONFIDENCE),
    strain: oneOf(cf.strain, `${p}.confidence.strain`, CONFIDENCE),
  };

  const rawContrib = item.contributors;
  if (!Array.isArray(rawContrib)) fail(`${p}.contributors`, "dizi olmalı");
  if (rawContrib.length > MAX_CONTRIBUTORS) fail(`${p}.contributors`, `en fazla ${MAX_CONTRIBUTORS} öğe olabilir`);
  const contributors = rawContrib.map((c: unknown, j: number) => validateContributor(c, `${p}.contributors[${j}]`));

  if (typeof item.algo !== "string" || !ALGO_RE.test(item.algo)) fail(`${p}.algo`, "kısa bir sürüm adı olmalı (ör. freeband-score/1)");
  const algo = item.algo;

  const s: ScoreIn = { type: "score", ts: ts.iso, date, sleep, recovery, strain, rhr, hrv_rmssd: hrv, confidence, contributors, algo };
  const row: ScoreRow = [
    ts.ms, date, sleep, recovery, strain, rhr, hrv,
    confidence.sleep, confidence.recovery, confidence.strain, JSON.stringify(contributors), algo,
  ];
  return { s, row };
}

// ---------------------------------------------------------------------------

export function validateIngest(raw: unknown, now: number): ValidatedIngest {
  if (!isObject(raw)) fail("$", "nesne olmalı");
  if (raw.schema !== SCHEMA) fail("schema", `"${SCHEMA}" olmalı`);
  const event = oneOf(raw.event, "event", EVENTS);

  const d = raw.device;
  if (!isObject(d)) fail("device", "nesne olmalı");
  const model = d.model;
  if (typeof model !== "string" || !(MODELS as readonly string[]).includes(model)) {
    fail("device.model", `${MODELS.join(" ya da ")} olmalı`);
  }
  const device: DeviceIn = {
    id: deviceId(d.id, "device.id"),
    name: text(d.name, "device.name", 100) as string,
    model: model as Model,
  };
  const appVersion = text(d.app_version, "device.app_version", 40, false);
  if (appVersion) device.app_version = appVersion;
  if (d.tz !== undefined && d.tz !== null) {
    if (!isValidTz(d.tz)) fail("device.tz", "geçerli bir IANA saat dilimi olmalı");
    device.tz = d.tz;
  }

  const sentAt = timestamp(raw.sent_at, "sent_at", now).iso;

  let summary: SummaryIn | undefined;
  if (raw.summary !== undefined && raw.summary !== null) {
    const s = raw.summary;
    if (!isObject(s)) fail("summary", "nesne olmalı");
    summary = {};
    if (s.date !== undefined && s.date !== null) {
      if (!isDate(s.date)) fail("summary.date", "YYYY-MM-DD olmalı");
      summary.date = s.date;
    }
    const steps = optInt(s.steps, "summary.steps", 0, 200_000);
    const calories = optInt(s.calories, "summary.calories", 0, 50_000);
    const hr = optInt(s.heart_rate_last, "summary.heart_rate_last", 0, 250);
    const battery = optInt(s.battery, "summary.battery", 0, 100);
    if (steps !== undefined) summary.steps = steps;
    if (calories !== undefined) summary.calories = calories;
    if (hr !== undefined) summary.heart_rate_last = hr;
    if (battery !== undefined) summary.battery = battery;
  }

  const list = raw.samples;
  if (!Array.isArray(list)) fail("samples", "dizi olmalı");
  if (list.length > LIMITS.maxSamples) {
    throw new HttpError(413, "too_many_samples", `samples: en fazla ${LIMITS.maxSamples} örnek olabilir`);
  }

  const samples: SampleIn[] = [];
  const sampleRows: SampleRow[] = [];
  // Keyed by ts so a repeated minute/sleep/score in one body is written once (last wins).
  const minutes = new Map<number, MinuteRow>();
  const sleeps = new Map<number, SleepRow>();
  const scores = new Map<number, ScoreRow>();
  let ignored = 0;

  list.forEach((item: unknown, i: number) => {
    const p = `samples[${i}]`;
    if (!isObject(item)) fail(p, "nesne olmalı");
    const type = item.type;
    if (typeof type !== "string" || !TYPE_RE.test(type)) fail(`${p}.type`, "küçük harfli bir tür adı olmalı (ör. live)");
    if (!["live", "battery", "minute", "sleep", "score"].includes(type)) {
      ignored++;
      return;
    }
    const ts = timestamp(item.ts, `${p}.ts`, now);
    if (type === "live") {
      const steps = int(item.steps, `${p}.steps`, 0, 200_000);
      const calories = int(item.calories, `${p}.calories`, 0, 50_000);
      const heartRate = int(item.heart_rate, `${p}.heart_rate`, 0, 250);
      const standing = optInt(item.standing_hours, `${p}.standing_hours`, 0, 24);
      const s: SampleIn = { type: "live", ts: ts.iso, steps, calories, heart_rate: heartRate };
      if (standing !== undefined) s.standing_hours = standing;
      samples.push(s);
      sampleRows.push(["live", ts.ms, steps, calories, heartRate, standing ?? null, null]);
    } else if (type === "battery") {
      const level = int(item.level, `${p}.level`, 0, 100);
      samples.push({ type: "battery", ts: ts.iso, level });
      sampleRows.push(["battery", ts.ms, null, null, null, null, level]);
    } else if (type === "minute") {
      const { s, row } = validateMinute(item, p, ts);
      samples.push(s);
      minutes.set(ts.ms, row);
    } else if (type === "sleep") {
      const { s, row } = validateSleep(item, p, ts, now);
      samples.push(s);
      sleeps.set(ts.ms, row);
    } else {
      const { s, row } = validateScore(item, p, ts);
      samples.push(s);
      scores.set(ts.ms, row);
    }
  });

  const body: IngestBody = {
    schema: SCHEMA,
    event,
    device,
    sent_at: sentAt,
    ...(summary ? { summary } : {}),
    samples,
  };
  return {
    body,
    rows: { samples: sampleRows, minutes: [...minutes.values()], sleeps: [...sleeps.values()], scores: [...scores.values()] },
    count: samples.length,
    ignored,
  };
}
