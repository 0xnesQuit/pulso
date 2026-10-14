// The 24-hour dial (docs/DESIGN.md v2), drawn on a 72×72 pixel grid: 00 at
// the top, clockwise. Every cell is a square pixel that is on or off; shades
// come from a 4×4 Bayer ordered dither. Outer bars are steps per hour
// (phosphor), the inner trace is heart rate (pulse; further out is higher),
// the track is dithered (sparser at night, 22-06) and a white block marks now.
// Radii follow ios/Freeband/UI/DayDial.swift; the bars here are a 2×2 brush
// swept along each hour's middle ray rather than sector wedges.
//
// Output is plain SVG: <rect> cells, horizontal runs merged, crisp edges.
// Colours and the opening animation live in the stylesheet (layout.ts), so the
// markup needs no style attributes under the CSP.

import { isHeartRate } from "../lib/validate";
import { html, raw, type Safe } from "./html";

export interface DialData {
  /** Steps walked in each local hour 0..23. */
  hourlySteps: number[];
  /** Heart-rate points: local hour of day (fractional) and bpm (30–220). */
  heart: Array<{ h: number; bpm: number }>;
  /** Local hour of "now" when the dial shows today, else null. */
  nowHour: number | null;
  centerValue: string | null;
  centerCaption: string | null;
  label: string;
  /** Live mode: the latest pulse pixel blinks. */
  live?: boolean;
  /** Language of the hover titles; Turkish when absent. */
  lang?: "en" | "tr";
}

const N = 72;
const C = N / 2;
const TRACK = N * 0.34;
const TRACK_HALF = 1.2;
const BAR_START = TRACK + 2.4;
/** Longest bar, so the 2×2 brush stays inside the grid at 00, 06, 12 and 18. */
const BAR_MAX = 8;
const HR_IN = 13;
const HR_OUT = 19.5;
const LABEL_R = 21.5;
const TRACK_DENSITY = 0.25;
const NIGHT_DENSITY = 0.12;
/** Readings closer than this (hours) are joined by a 1-pixel line. */
const JOIN_GAP = 0.5;

const BAYER = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
].map((row) => row.map((v) => (v + 0.5) / 16));

const threshold = (x: number, y: number): number => (BAYER[y % 4] as number[])[x % 4] as number;

/** Hour of day (0..24) at the centre of cell (x, y). */
function cellHour(x: number, y: number): number {
  const dx = x + 0.5 - C;
  const dy = y + 0.5 - C;
  let a = Math.atan2(dx, -dy);
  if (a < 0) a += 2 * Math.PI;
  return (a / (2 * Math.PI)) * 24;
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** Bresenham line between two cells, both ends included. */
export function line(x0: number, y0: number, x1: number, y1: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const dx = Math.abs(x1 - x0);
  const sx = x0 < x1 ? 1 : -1;
  const dy = -Math.abs(y1 - y0);
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    out.push([x0, y0]);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x0 += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y0 += sy;
    }
  }
  return out;
}

/** The day's own heart-rate range, at least 30 bpm wide, so its rise and fall stays visible. */
function heartRange(heart: DialData["heart"]): { lo: number; hi: number } {
  if (heart.length === 0) return { lo: 40, hi: 180 };
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of heart) {
    lo = Math.min(lo, p.bpm);
    hi = Math.max(hi, p.bpm);
  }
  const mid = (lo + hi) / 2;
  const half = Math.max((hi - lo) / 2 + 5, 15);
  return { lo: mid - half, hi: mid + half };
}

/** Owner of each cell: a group key such as "trk 5", "bar 13", "hr 7", "live" or "now". */
class Grid {
  readonly cells = new Array<string | undefined>(N * N);
  set(x: number, y: number, key: string): void {
    if (x >= 0 && y >= 0 && x < N && y < N) this.cells[y * N + x] = key;
  }
  /** Horizontal runs per group key, in row order. */
  runs(): Map<string, string[]> {
    const out = new Map<string, string[]>();
    for (let y = 0; y < N; y++) {
      let x = 0;
      while (x < N) {
        const key = this.cells[y * N + x];
        if (key === undefined) {
          x++;
          continue;
        }
        let end = x + 1;
        while (end < N && this.cells[y * N + end] === key) end++;
        const list = out.get(key) ?? [];
        list.push(`<rect x="${x}" y="${y}" width="${end - x}" height="1"/>`);
        out.set(key, list);
        x = end;
      }
    }
    return out;
  }
}

export function dial(d: DialData): Safe {
  const g = new Grid();
  const peak = Math.max(0, ...d.hourlySteps);

  // Track, cell by cell.
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const dx = x + 0.5 - C;
      const dy = y + 0.5 - C;
      const r = Math.hypot(dx, dy);
      const hour = cellHour(x, y);
      const h = Math.min(23, Math.floor(hour));
      if (Math.abs(r - TRACK) <= TRACK_HALF) {
        const night = hour >= 22 || hour < 6;
        if (threshold(x, y) < (night ? NIGHT_DENSITY : TRACK_DENSITY)) g.set(x, y, `trk ${h}`);
      }
    }
  }

  // Hourly step bars: a 2×2 pixel brush swept out along the ray through the
  // middle of each hour, so every bar has the same weight at any angle.
  for (let h = 0; h < 24 && peak > 0; h++) {
    const steps = d.hourlySteps[h] ?? 0;
    if (steps <= 0) continue;
    const a = ((h + 0.5) / 24) * 2 * Math.PI;
    const len = Math.max(1, (steps / peak) * BAR_MAX);
    for (let t = BAR_START; t <= BAR_START + len; t += 0.25) {
      const bx = Math.floor(C + Math.sin(a) * t - 0.5);
      const by = Math.floor(C - Math.cos(a) * t - 0.5);
      for (const [ox, oy] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) g.set(bx + ox, by + oy, `bar ${h}`);
    }
  }

  // Heart-rate trace: one pixel per reading, 1-pixel lines between close readings.
  const range = heartRange(d.heart);
  const heart = [...d.heart].sort((a, b) => a.h - b.h);
  let prev: { h: number; x: number; y: number } | null = null;
  for (const p of heart) {
    const t = Math.min(1, Math.max(0, (p.bpm - range.lo) / (range.hi - range.lo)));
    const r = HR_IN + t * (HR_OUT - HR_IN);
    const a = (p.h / 24) * 2 * Math.PI;
    const x = Math.floor(C + Math.sin(a) * r);
    const y = Math.floor(C - Math.cos(a) * r);
    const pts: Array<[number, number]> = prev && p.h - prev.h < JOIN_GAP ? line(prev.x, prev.y, x, y) : [[x, y]];
    for (const [px, py] of pts) g.set(px, py, `hr ${Math.min(23, Math.floor(cellHour(px, py)))}`);
    prev = { h: p.h, x, y };
  }
  if (d.live && prev) g.set(prev.x, prev.y, "live");

  // Now: a 2×3 white block across the track (3 cells radial, 2 tangential).
  if (d.nowHour !== null) {
    const a = (d.nowHour / 24) * 2 * Math.PI;
    const ux = Math.sin(a);
    const uy = -Math.cos(a);
    const px = C + ux * TRACK;
    const py = C + uy * TRACK;
    for (let y = Math.floor(py) - 3; y <= Math.floor(py) + 3; y++) {
      for (let x = Math.floor(px) - 3; x <= Math.floor(px) + 3; x++) {
        const vx = x + 0.5 - px;
        const vy = y + 0.5 - py;
        const along = vx * ux + vy * uy;
        const across = -vx * uy + vy * ux;
        if (Math.abs(along) <= 1.5 && across > -1 && across <= 1) g.set(x, y, "now");
      }
    }
  }

  const runs = g.runs();
  const layer = (prefix: string, cls: (h: number) => string, extra: (h: number) => string = () => ""): string =>
    Array.from({ length: 24 }, (_, h) => {
      const rects = runs.get(`${prefix} ${h}`);
      return rects ? `<g class="${cls(h)}">${extra(h)}${rects.join("")}</g>` : "";
    }).join("");

  const track = layer("trk", (h) => `rv h${h}`);
  const bars = layer(
    "bar",
    (h) => `bar h${h}`,
    (h) => `<title>${pad2(h)}:00, ${d.hourlySteps[h] ?? 0} ${d.lang === "en" ? "steps" : "adım"}</title>`,
  );
  const hr = layer("hr", (h) => `rv h${h}`) + (runs.get("live") ?? []).join("").replace("<rect ", '<rect class="live" ');
  const now = runs.get("now");

  const labels = [0, 6, 12, 18]
    .map((h) => {
      const a = (h / 24) * 2 * Math.PI;
      const x = (C + Math.sin(a) * LABEL_R).toFixed(2);
      const y = (C - Math.cos(a) * LABEL_R).toFixed(2);
      return `<text class="lbl" x="${x}" y="${y}" text-anchor="middle" dominant-baseline="central">${pad2(h)}</text>`;
    })
    .join("");

  const center =
    d.centerValue !== null
      ? html`<text class="big${d.centerValue === "–" ? " none" : ""}" x="${C}" y="${d.centerCaption ? C + 2.5 : C + 4}" text-anchor="middle">${d.centerValue}</text>${
          d.centerCaption ? html`<text class="cap" x="${C}" y="${C + 7.5}" text-anchor="middle">${d.centerCaption}</text>` : ""
        }`
      : "";

  return html`<svg class="dial" viewBox="0 0 ${N} ${N}" role="img" aria-label="${d.label}" shape-rendering="crispEdges" xmlns="http://www.w3.org/2000/svg">
${track ? raw(`<g class="trk">${track}</g>`) : ""}
${bars ? raw(`<g class="steps">${bars}</g>`) : ""}
${hr ? raw(`<g class="hr">${hr}</g>`) : ""}
${now ? raw(`<g class="now"><title>${d.lang === "en" ? "Now" : "Şimdi"}</title>${now.join("")}</g>`) : ""}
${raw(labels)}
${center}
</svg>`;
}

/**
 * The day's pulse as a 1-pixel line over 00-24 (DESIGN.md: "günün nabız eğrisi").
 * The x axis is minutes of the day, the y axis the day's own range; gaps of
 * more than 30 minutes break the line.
 */
export function pulseCurve(heart: Array<{ h: number; bpm: number }>, label: string): Safe | null {
  if (heart.length < 2) return null;
  const W = 1440;
  const H = 100;
  const values = heart.map((p) => p.bpm);
  const lo = Math.min(...values) - 5;
  const hi = Math.max(...values) + 5;
  const y = (bpm: number): string => (H - ((bpm - lo) / (hi - lo)) * H).toFixed(1);
  const pts = [...heart].sort((a, b) => a.h - b.h);
  let d = "";
  let prevH = -Infinity;
  for (const p of pts) {
    d += `${p.h - prevH > 0.5 ? "M" : "L"}${(p.h * 60).toFixed(1)} ${y(p.bpm)}`;
    prevH = p.h;
  }
  return html`<div class="curve">
<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${label}" xmlns="http://www.w3.org/2000/svg">
<path class="gl" d="M360 0V${H}M720 0V${H}M1080 0V${H}" vector-effect="non-scaling-stroke"/>
<path class="ln" d="${d}" vector-effect="non-scaling-stroke"/>
</svg>
<span class="yl hi" aria-hidden="true">${Math.round(hi - 5)}</span><span class="yl lo" aria-hidden="true">${Math.round(lo + 5)}</span>
<div class="axis" aria-hidden="true"><span>00</span><span>06</span><span>12</span><span>18</span><span>24</span></div>
</div>`;
}

/**
 * Hourly steps from cumulative live samples of one local day.
 * Each hour's value is the increase of the running maximum over that hour.
 */
export function hourlyFromCumulative(points: Array<{ h: number; steps: number }>): number[] {
  const hourMax = new Array<number>(24).fill(0);
  for (const p of points) {
    const i = Math.min(23, Math.max(0, Math.floor(p.h)));
    if (p.steps > (hourMax[i] ?? 0)) hourMax[i] = p.steps;
  }
  const out = new Array<number>(24).fill(0);
  let cum = 0;
  for (let i = 0; i < 24; i++) {
    const v = hourMax[i] ?? 0;
    if (v > cum) {
      out[i] = v - cum;
      cum = v;
    }
  }
  return out;
}

/** Average heart rate per 5-minute bucket, ignoring values outside 30–220 bpm (0 = not measured). */
export function heartBuckets(points: Array<{ h: number; bpm: number }>): Array<{ h: number; bpm: number }> {
  const buckets = new Map<number, { sum: number; n: number }>();
  for (const p of points) {
    if (!isHeartRate(p.bpm)) continue;
    const k = Math.floor(p.h * 12);
    const b = buckets.get(k) ?? { sum: 0, n: 0 };
    b.sum += p.bpm;
    b.n += 1;
    buckets.set(k, b);
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([k, b]) => ({ h: (k + 0.5) / 12, bpm: Math.round(b.sum / b.n) }));
}
