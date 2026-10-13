// Validation of the freeband.v1 ingest body (docs/API.md).
// Everything is checked; unknown fields are dropped from the normalized result.

import { HttpError, LIMITS } from "./http";
import { UUID_RE } from "./crypto";
import { isDate, isValidTz, parseIsoUtc } from "./time";

export const SCHEMA = "freeband.v1";
export const MODELS = ["band10", "band10pro"] as const;
export type Model = (typeof MODELS)[number];

const FUTURE_SLACK_MS = 2 * 86_400_000;
const EARLIEST_TS = Date.UTC(2020, 0, 1);
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

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

export type SampleIn =
  | { type: "live"; ts: string; steps: number; calories: number; heart_rate: number; standing_hours?: number }
  | { type: "battery"; ts: string; level: number };

export interface IngestBody {
  schema: typeof SCHEMA;
  event: "sync.completed";
  device: DeviceIn;
  sent_at: string;
  summary?: SummaryIn;
  samples: SampleIn[];
}

/** Compact row for the json_each() bulk insert: [type, ts_ms, steps, calories, hr, standing, level]. */
export type SampleRow = [string, number, number | null, number | null, number | null, number | null, number | null];

function fail(path: string, rule: string): never {
  throw new HttpError(400, "invalid_body", `${path}: ${rule}`);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function int(v: unknown, path: string, min: number, max: number): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) {
    fail(path, `${min} ile ${max} arasında tam sayı olmalı`);
  }
  return v;
}

function optInt(v: unknown, path: string, min: number, max: number): number | undefined {
  return v === undefined || v === null ? undefined : int(v, path, min, max);
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

export function validateIngest(raw: unknown, now: number): { body: IngestBody; rows: SampleRow[] } {
  if (!isObject(raw)) fail("$", "nesne olmalı");
  if (raw.schema !== SCHEMA) fail("schema", `"${SCHEMA}" olmalı`);
  if (raw.event !== "sync.completed") fail("event", `"sync.completed" olmalı`);

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
  const rows: SampleRow[] = [];
  list.forEach((item: unknown, i: number) => {
    const p = `samples[${i}]`;
    if (!isObject(item)) fail(p, "nesne olmalı");
    const ts = timestamp(item.ts, `${p}.ts`, now);
    if (item.type === "live") {
      const steps = int(item.steps, `${p}.steps`, 0, 200_000);
      const calories = int(item.calories, `${p}.calories`, 0, 50_000);
      const heartRate = int(item.heart_rate, `${p}.heart_rate`, 0, 250);
      const standing = optInt(item.standing_hours, `${p}.standing_hours`, 0, 24);
      const s: SampleIn = { type: "live", ts: ts.iso, steps, calories, heart_rate: heartRate };
      if (standing !== undefined) s.standing_hours = standing;
      samples.push(s);
      rows.push(["live", ts.ms, steps, calories, heartRate, standing ?? null, null]);
    } else if (item.type === "battery") {
      const level = int(item.level, `${p}.level`, 0, 100);
      samples.push({ type: "battery", ts: ts.iso, level });
      rows.push(["battery", ts.ms, null, null, null, null, level]);
    } else {
      fail(`${p}.type`, `"live" ya da "battery" olmalı`);
    }
  });

  const body: IngestBody = {
    schema: SCHEMA,
    event: "sync.completed",
    device,
    sent_at: sentAt,
    ...(summary ? { summary } : {}),
    samples,
  };
  return { body, rows };
}
