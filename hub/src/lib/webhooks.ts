// Server-side webhooks: URL policy, signing and delivery.

import { decryptSecret, hmacSha256Hex } from "./crypto";

export const MAX_WEBHOOKS = 5;
export const DELIVERY_TIMEOUT_MS = 5000;
const MAX_URL_LEN = 2048;
const USER_AGENT = "OpenBand-Hub/1";

export interface HookRow {
  id: string;
  account_id: string;
  url: string;
  secret_enc: string;
}

export interface DeliveryResult {
  delivered: boolean;
  status: number;
  error: string | null;
}

export type UrlCheck = { ok: true; url: string } | { ok: false; message: string };

const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa", ".arpa", ".invalid", ".test", ".example"];

/**
 * Only public https:// hostnames on the default port. Refuses the hub's own
 * hostname (and its subdomains), IP literals, single-label and reserved names.
 */
export function checkWebhookUrl(raw: unknown, ownHosts: string[]): UrlCheck {
  if (typeof raw !== "string") return { ok: false, message: "url: metin olmalı" };
  const s = raw.trim();
  if (s.length === 0 || s.length > MAX_URL_LEN) return { ok: false, message: "url: 1–2048 karakter olmalı" };
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return { ok: false, message: "url: geçerli bir adres değil" };
  }
  if (u.protocol !== "https:") return { ok: false, message: "url: yalnız https:// adreslere izin var" };
  if (u.username || u.password) return { ok: false, message: "url: kullanıcı adı ya da parola içeremez" };
  if (u.port !== "" && u.port !== "443") return { ok: false, message: "url: yalnız 443 numaralı bağlantı noktası" };

  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  if (host.startsWith("[") || /^[\d.]+$/.test(host) || /^0x/i.test(host)) {
    return { ok: false, message: "url: IP adresi değil, alan adı kullan" };
  }
  if (!host.includes(".") || host === "localhost" || BLOCKED_SUFFIXES.some((x) => host.endsWith(x))) {
    return { ok: false, message: "url: herkese açık bir alan adı olmalı" };
  }
  for (const own of ownHosts) {
    const o = own.toLowerCase();
    if (o && (host === o || host.endsWith("." + o))) {
      return { ok: false, message: "url: hub'ın kendi adresine webhook eklenemez" };
    }
  }
  u.hash = "";
  return { ok: true, url: u.toString() };
}

export const hookAad = (h: { account_id: string; id: string }): string => `${h.account_id}:${h.id}`;

export async function signature(secret: string, body: Uint8Array): Promise<string> {
  return "sha256=" + (await hmacSha256Hex(secret, body));
}

/**
 * POSTs `body` to one webhook with the contract's headers. Never follows
 * redirects, gives up after 5 s, and records the outcome on the webhook row.
 */
export async function deliver(
  env: Env,
  hook: HookRow,
  event: "sync.completed" | "ping",
  body: Uint8Array,
): Promise<DeliveryResult> {
  let result: DeliveryResult;
  try {
    const secret = await decryptSecret(env, hook.secret_enc, hookAad(hook));
    const res = await fetch(hook.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
        "X-OpenBand-Event": event,
        "X-OpenBand-Delivery": crypto.randomUUID(),
        "X-OpenBand-Signature": await signature(secret, body),
      },
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    });
    await res.body?.cancel().catch(() => {});
    const ok = res.status >= 200 && res.status < 300;
    result = {
      delivered: ok,
      status: res.status,
      error: ok
        ? null
        : res.status >= 300 && res.status < 400
          ? `Yönlendirme izlenmez (HTTP ${res.status})`
          : `HTTP ${res.status}`,
    };
  } catch (e) {
    const name = e instanceof Error ? e.name : "";
    result = {
      delivered: false,
      status: 0,
      error: name === "TimeoutError" || name === "AbortError" ? "Zaman aşımı (5 sn)" : "Bağlantı kurulamadı",
    };
  }

  await env.DB.prepare(
    "UPDATE webhooks SET last_delivery_at = ?1, last_status = ?2, last_error = ?3 WHERE id = ?4 AND account_id = ?5",
  )
    .bind(Date.now(), result.status, result.error, hook.id, hook.account_id)
    .run()
    .catch((err: unknown) => logError("webhook status update failed", err));

  if (!result.delivered) {
    console.log(JSON.stringify({ message: "webhook delivery failed", webhook_id: hook.id, status: result.status, error: result.error }));
  }
  return result;
}

/** Forwards a validated ingest body to every webhook of the account. Runs inside waitUntil. */
export async function forwardIngest(env: Env, accountId: string, body: unknown): Promise<void> {
  try {
    const { results } = await env.DB.prepare(
      "SELECT id, account_id, url, secret_enc FROM webhooks WHERE account_id = ?1",
    )
      .bind(accountId)
      .all<HookRow>();
    if (results.length === 0) return;
    const bytes = new TextEncoder().encode(JSON.stringify(body));
    await Promise.allSettled(results.map((h) => deliver(env, h, "sync.completed", bytes)));
  } catch (err) {
    logError("webhook fan-out failed", err);
  }
}

export function logError(message: string, err: unknown): void {
  console.error(JSON.stringify({ message, error: err instanceof Error ? err.message : String(err) }));
}
