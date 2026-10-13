// HTTP helpers: typed errors, bounded body reading, cookies.

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

export function errorBody(code: string, message: string): { error: string; message: string } {
  return { error: code, message };
}

/** Byte limits for request bodies. */
export const LIMITS = {
  ingestBytes: 512 * 1024,
  smallBytes: 8 * 1024,
  maxSamples: 5000,
} as const;

/**
 * Reads a JSON request body without ever holding more than `maxBytes` in memory.
 * Rejects non-JSON content types, oversize bodies and invalid UTF-8.
 */
export async function readJson(req: Request, maxBytes: number): Promise<unknown> {
  const ct = (req.headers.get("content-type") ?? "").toLowerCase();
  if (!/^application\/json(\s*;|$)/.test(ct)) {
    throw new HttpError(415, "unsupported_media_type", "Gövde application/json olmalı.");
  }
  const declared = req.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) {
    throw new HttpError(413, "body_too_large", `Gövde en fazla ${maxBytes} bayt olabilir.`);
  }
  if (!req.body) throw new HttpError(400, "invalid_json", "Gövde boş.");

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new HttpError(413, "body_too_large", `Gövde en fazla ${maxBytes} bayt olabilir.`);
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.byteLength;
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(buf);
  } catch {
    throw new HttpError(400, "invalid_json", "Gövde geçerli UTF-8 değil.");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "invalid_json", "Gövde geçerli JSON değil.");
  }
}

export function clientIp(req: Request): string {
  return req.headers.get("cf-connecting-ip") ?? "unknown";
}

export function getCookie(req: Request, name: string): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

/**
 * True when the request provably comes from a page on this origin.
 * Browsers always send Origin on non-GET fetches; Sec-Fetch-Site is the fallback.
 * Requests with neither header are rejected.
 */
export function isSameOrigin(req: Request): boolean {
  const own = new URL(req.url).origin;
  const origin = req.headers.get("origin");
  if (origin !== null) return origin === own;
  return req.headers.get("sec-fetch-site") === "same-origin";
}
