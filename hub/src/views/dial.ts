// The 24-hour dial (docs/DESIGN.md): 00 at the top, clockwise. Outer arc:
// hourly step bars (Saffron). Inner trace: heart-rate dots (Pomegranate).
// Night hours 22-06 shaded, a tick for "now", last heart rate in the centre.

import { html, type Safe } from "./html";

export interface DialData {
  /** Steps walked in each local hour 0..23. */
  hourlySteps: number[];
  /** Heart-rate points: local hour of day (fractional) and bpm (> 0). */
  heart: Array<{ h: number; bpm: number }>;
  /** Local hour of "now" when the dial shows today, else null. */
  nowHour: number | null;
  centerValue: string | null;
  centerCaption: string | null;
  label: string;
}

const SIZE = 480;
const C = SIZE / 2;
const TRACK_R = 160;
const BAR_IN = 170;
const BAR_MAX = 48;
const HR_IN = 98;
const HR_OUT = 152;
const HR_LO = 40;
const HR_HI = 180;

const f = (n: number): string => n.toFixed(2);

function point(r: number, hour: number): [number, number] {
  const a = (hour / 24) * 2 * Math.PI;
  return [C + r * Math.sin(a), C - r * Math.cos(a)];
}

/** Annulus sector from hour h0 to h1 (h1 may exceed 24 to wrap past midnight). */
function sector(rIn: number, rOut: number, h0: number, h1: number): string {
  const large = h1 - h0 > 12 ? 1 : 0;
  const [x0, y0] = point(rOut, h0);
  const [x1, y1] = point(rOut, h1);
  const [x2, y2] = point(rIn, h1);
  const [x3, y3] = point(rIn, h0);
  return `M${f(x0)} ${f(y0)}A${rOut} ${rOut} 0 ${large} 1 ${f(x1)} ${f(y1)}L${f(x2)} ${f(y2)}A${rIn} ${rIn} 0 ${large} 0 ${f(x3)} ${f(y3)}Z`;
}

export function dial(d: DialData): Safe {
  const maxSteps = Math.max(0, ...d.hourlySteps);
  const bars = d.hourlySteps.map((steps, h) => {
    if (steps <= 0 || maxSteps <= 0) return "";
    const len = Math.max(3, (steps / maxSteps) * BAR_MAX);
    const [x1, y1] = point(BAR_IN, h + 0.5);
    const [x2, y2] = point(BAR_IN + len, h + 0.5);
    return html`<line class="bar h${h}" pathLength="1" x1="${f(x1)}" y1="${f(y1)}" x2="${f(x2)}" y2="${f(y2)}"><title>${String(h).padStart(2, "0")}:00, ${steps} adım</title></line>`;
  });

  const dots = d.heart.map(({ h, bpm }) => {
    const t = Math.min(1, Math.max(0, (bpm - HR_LO) / (HR_HI - HR_LO)));
    const [x, y] = point(HR_IN + t * (HR_OUT - HR_IN), h);
    return html`<circle class="hr" cx="${f(x)}" cy="${f(y)}" r="2.6"/>`;
  });

  const ticks = Array.from({ length: 24 }, (_, h) => {
    const long = h % 6 === 0;
    const [x1, y1] = point(TRACK_R - (long ? 6 : 3), h);
    const [x2, y2] = point(TRACK_R + (long ? 6 : 3), h);
    return html`<line class="tick" x1="${f(x1)}" y1="${f(y1)}" x2="${f(x2)}" y2="${f(y2)}"/>`;
  });

  const labels = [0, 6, 12, 18].map((h) => {
    const [x, y] = point(TRACK_R - 22, h);
    return html`<text class="label" x="${f(x)}" y="${f(y)}" text-anchor="middle" dominant-baseline="central">${String(h).padStart(2, "0")}</text>`;
  });

  let now: Safe | string = "";
  if (d.nowHour !== null) {
    const [x1, y1] = point(TRACK_R - 9, d.nowHour);
    const [x2, y2] = point(TRACK_R + 9, d.nowHour);
    now = html`<line class="now" x1="${f(x1)}" y1="${f(y1)}" x2="${f(x2)}" y2="${f(y2)}"><title>Şimdi</title></line>`;
  }

  const center =
    d.centerValue !== null
      ? html`<text class="big" x="${C}" y="${C + 10}" text-anchor="middle" dominant-baseline="central">${d.centerValue}</text>
<text class="cap" x="${C}" y="${C + 62}" text-anchor="middle">${d.centerCaption ?? ""}</text>`
      : "";

  return html`<svg class="dial" viewBox="0 0 ${SIZE} ${SIZE}" role="img" aria-label="${d.label}" xmlns="http://www.w3.org/2000/svg">
<path class="night" d="${sector(HR_IN - 14, TRACK_R, 22, 30)}"/>
<circle class="track" cx="${C}" cy="${C}" r="${TRACK_R}"/>
${ticks}
${labels}
${dots}
${bars}
${now}
${center}
</svg>`;
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

/** Average heart rate per 5-minute bucket, ignoring 0 (not measured). */
export function heartBuckets(points: Array<{ h: number; bpm: number }>): Array<{ h: number; bpm: number }> {
  const buckets = new Map<number, { sum: number; n: number }>();
  for (const p of points) {
    if (p.bpm <= 0) continue;
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
