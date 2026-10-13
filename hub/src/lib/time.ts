// Time and time-zone helpers built on Intl only (no tz database in the bundle).

const DAY_MS = 86_400_000;

const ISO_UTC_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,3})?Z$/;
const ISO_ANY_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TZ_RE = /^[A-Za-z][A-Za-z0-9_+\-/]{0,63}$/;

/** Strict ISO 8601 UTC instant as used by the contract ("2026-10-13T20:59:41Z"). */
export function parseIsoUtc(s: unknown): number | null {
  if (typeof s !== "string") return null;
  const m = ISO_UTC_RE.exec(s);
  if (!m) return null;
  const ms = Date.parse(s);
  if (!Number.isFinite(ms)) return null;
  // Reject calendar overflow such as 2026-02-30 that Date.parse would roll over.
  if (new Date(ms).toISOString().slice(0, 19) !== s.slice(0, 19)) return null;
  return ms;
}

/** ISO 8601 instant with Z or a numeric offset, for query parameters. */
export function parseIsoInstant(s: string): number | null {
  if (!ISO_ANY_RE.test(s)) return null;
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? ms : null;
}

export function isDate(s: unknown): s is string {
  if (typeof s !== "string") return false;
  const m = DATE_RE.exec(s);
  if (!m) return false;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return new Date(ms).toISOString().slice(0, 10) === s;
}

/** ISO string without milliseconds when they are zero, matching the contract's examples. */
export function isoOut(ms: number): string {
  const s = new Date(ms).toISOString();
  return s.endsWith(".000Z") ? s.slice(0, 19) + "Z" : s;
}

export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d) + n * DAY_MS).toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  const a = Date.parse(from + "T00:00:00Z");
  const b = Date.parse(to + "T00:00:00Z");
  return Math.round((b - a) / DAY_MS);
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    fmtCache.set(tz, f);
  }
  return f;
}

export function isValidTz(tz: unknown): tz is string {
  if (typeof tz !== "string" || !TZ_RE.test(tz)) return false;
  try {
    formatter(tz);
    return true;
  } catch {
    return false;
  }
}

export interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export function localParts(ms: number, tz: string): LocalParts {
  const out: Record<string, number> = {};
  for (const p of formatter(tz).formatToParts(new Date(ms))) {
    if (p.type !== "literal") out[p.type] = Number(p.value);
  }
  return {
    year: out.year ?? 1970,
    month: out.month ?? 1,
    day: out.day ?? 1,
    hour: (out.hour ?? 0) % 24,
    minute: out.minute ?? 0,
    second: out.second ?? 0,
  };
}

/** Offset of `tz` from UTC at instant `ms`, in milliseconds (local - UTC). */
export function tzOffsetMs(ms: number, tz: string): number {
  const p = localParts(ms, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** Calendar date (YYYY-MM-DD) of instant `ms` in `tz`. */
export function localDate(ms: number, tz: string): string {
  const p = localParts(ms, tz);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** Hours since local midnight as shown on a wall clock (0 <= h < 24). */
export function localHourOfDay(ms: number, tz: string): number {
  const p = localParts(ms, tz);
  return p.hour + p.minute / 60 + p.second / 3600;
}

/**
 * UTC instant of local midnight at the start of `date` in `tz`. DST-safe:
 * the offset is re-evaluated at the candidate instant.
 */
export function startOfLocalDay(date: string, tz: string): number {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const wall = Date.UTC(y, m - 1, d);
  let t = wall - tzOffsetMs(wall, tz);
  const o2 = tzOffsetMs(t, tz);
  if (wall - o2 !== t) t = wall - o2;
  return t;
}

/** [start, end) UTC bounds for each local day from `from` to `to` inclusive. */
export function dayBounds(from: string, to: string, tz: string): Array<[string, number, number]> {
  const out: Array<[string, number, number]> = [];
  let start = startOfLocalDay(from, tz);
  for (let d = from; d <= to; ) {
    const next = addDays(d, 1);
    const end = startOfLocalDay(next, tz);
    out.push([d, start, end]);
    start = end;
    d = next;
  }
  return out;
}
