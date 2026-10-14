// Display formatting in English and Turkish. Hand-rolled so output does not depend
// on the runtime's ICU data.

import { localParts } from "../lib/time";
import type { Lang } from "./i18n";

const WEEKDAYS: Record<Lang, string[]> = {
  en: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"],
  tr: ["Pazar", "Pazartesi", "Salı", "Çarşamba", "Perşembe", "Cuma", "Cumartesi"],
};
const MONTHS: Record<Lang, string[]> = {
  en: ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"],
  tr: ["Ocak", "Şubat", "Mart", "Nisan", "Mayıs", "Haziran", "Temmuz", "Ağustos", "Eylül", "Ekim", "Kasım", "Aralık"],
};

/** "Tuesday, 13 October" / "Salı, 13 Ekim" for a YYYY-MM-DD date. */
export function dayLabel(date: string, lang: Lang = "tr"): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return `${WEEKDAYS[lang][wd]}, ${d} ${MONTHS[lang][m - 1]}`;
}

/** "13 October" / "13 Ekim" */
export function shortDay(date: string, lang: Lang = "tr"): string {
  const [, m, d] = date.split("-").map(Number) as [number, number, number];
  return `${d} ${MONTHS[lang][m - 1]}`;
}

/** 8421 -> "8,421" in English, "8 421" (narrow no-break space) in Turkish. */
export function num(n: number, lang: Lang = "tr"): string {
  const s = String(Math.round(Math.abs(n)));
  const grouped = s.replace(/\B(?=(\d{3})+(?!\d))/g, lang === "en" ? "," : "\u202f");
  return n < 0 ? "-" + grouped : grouped;
}

/** 46 -> "46%" in English, "%46" in Turkish. */
export function percent(n: number, lang: Lang = "tr"): string {
  return lang === "en" ? `${n}%` : `%${n}`;
}

/** "14:31" in the given zone. */
export function clock(ms: number, tz: string): string {
  const p = localParts(ms, tz);
  return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
}
