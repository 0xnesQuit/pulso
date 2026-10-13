// Minimal auto-escaping HTML templates. Every interpolated value is escaped
// unless it is itself the result of `html` or explicitly wrapped in `raw`.

export class Safe {
  constructor(readonly value: string) {}
  toString(): string {
    return this.value;
  }
}

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ESC[ch] as string);
}

function render(v: unknown): string {
  if (v instanceof Safe) return v.value;
  if (Array.isArray(v)) return v.map(render).join("");
  if (v === null || v === undefined || v === false) return "";
  return escapeHtml(String(v));
}

export function html(strings: TemplateStringsArray, ...values: unknown[]): Safe {
  let out = strings[0] ?? "";
  for (let i = 0; i < values.length; i++) out += render(values[i]) + (strings[i + 1] ?? "");
  return new Safe(out);
}

/** Trusted markup only (constants written in this repo, never user data). */
export const raw = (s: string): Safe => new Safe(s);
