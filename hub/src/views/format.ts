// Turkish display formatting. Hand-rolled so output does not depend on the
// runtime's ICU data.

import { localParts } from "../lib/time";

const WEEKDAYS = ["Pazar", "Pazartesi", "Salı", "Çarşamba", "Perşembe", "Cuma", "Cumartesi"];
const MONTHS = ["Ocak", "Şubat", "Mart", "Nisan", "Mayıs", "Haziran", "Temmuz", "Ağustos", "Eylül", "Ekim", "Kasım", "Aralık"];

/** "Salı, 13 Ekim" for a YYYY-MM-DD date. */
export function dayLabel(date: string): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return `${WEEKDAYS[wd]}, ${d} ${MONTHS[m - 1]}`;
}

/** "13 Ekim" */
export function shortDay(date: string): string {
  const [, m, d] = date.split("-").map(Number) as [number, number, number];
  return `${d} ${MONTHS[m - 1]}`;
}

/** 8421 -> "8 421" with a narrow no-break space, as in the design. */
export function num(n: number): string {
  const s = String(Math.round(Math.abs(n)));
  const grouped = s.replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return n < 0 ? "-" + grouped : grouped;
}

/** "14:31" in the given zone. */
export function clock(ms: number, tz: string): string {
  const p = localParts(ms, tz);
  return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
}
