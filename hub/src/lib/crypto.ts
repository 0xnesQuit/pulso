// Cryptographic helpers. Web Crypto only; no Math.random anywhere.

const enc = new TextEncoder();
const dec = new TextDecoder();

export const TOKEN_PREFIX = "fb_";
/** `fb_` + base64url(32 random bytes) = 3 + 43 characters. */
export const TOKEN_RE = /^fb_[A-Za-z0-9_-]{43}$/;
/** Session cookie values: base64url(32 random bytes). */
export const SESSION_RE = /^[A-Za-z0-9_-]{43}$/;
export const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export class ConfigError extends Error {}

export function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

export function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const byte of bytes) s += String.fromCharCode(byte);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromB64url(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function hex(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (const byte of bytes) s += byte.toString(16).padStart(2, "0");
  return s;
}

/** New bearer token. Only its SHA-256 is ever persisted. */
export function newToken(): string {
  return TOKEN_PREFIX + b64url(randomBytes(32));
}

/** New opaque session id for the cookie. Only its SHA-256 is persisted. */
export function newSessionId(): string {
  return b64url(randomBytes(32));
}

/** New webhook signing secret, shown to the user exactly once. */
export function newWebhookSecret(): string {
  return "fbwh_" + b64url(randomBytes(32));
}

export async function sha256Hex(input: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", enc.encode(input)));
}

/**
 * Constant-time string comparison. Both sides are hashed first so that
 * differing lengths do not short-circuit.
 */
export async function timingSafeEqualStr(a: string, b: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(ha, hb);
}

/** HMAC-SHA256 over raw bytes, keyed with the UTF-8 bytes of `secret`. Lowercase hex. */
export async function hmacSha256Hex(secret: string, body: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return hex(await crypto.subtle.sign("HMAC", key, body));
}

// ---------------------------------------------------------------------------
// HUB_SECRET-derived keys

const MIN_SECRET_LEN = 32;

function hubSecret(env: Env): string {
  const s = env.HUB_SECRET;
  if (typeof s !== "string" || s.length < MIN_SECRET_LEN) {
    throw new ConfigError("HUB_SECRET is missing or shorter than 32 characters");
  }
  return s;
}

export function hasHubSecret(env: Env): boolean {
  return typeof env.HUB_SECRET === "string" && env.HUB_SECRET.length >= MIN_SECRET_LEN;
}

async function deriveBits(env: Env, info: string): Promise<ArrayBuffer> {
  const ikm = await crypto.subtle.importKey("raw", enc.encode(hubSecret(env)), "HKDF", false, [
    "deriveBits",
  ]);
  return crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: enc.encode("openband-hub"), info: enc.encode(info) },
    ikm,
    256,
  );
}

async function aesKey(env: Env): Promise<CryptoKey> {
  const bits = await deriveBits(env, "webhook-secret-aes-gcm-v1");
  return crypto.subtle.importKey("raw", bits, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

/**
 * Encrypts a webhook secret for storage. `aad` binds the ciphertext to its row
 * (account id + webhook id) so a copied ciphertext does not decrypt elsewhere.
 */
export async function encryptSecret(env: Env, plaintext: string, aad: string): Promise<string> {
  const iv = randomBytes(12);
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: enc.encode(aad) },
    await aesKey(env),
    enc.encode(plaintext),
  );
  return `v1.${b64url(iv)}.${b64url(new Uint8Array(ct))}`;
}

export async function decryptSecret(env: Env, stored: string, aad: string): Promise<string> {
  const [v, ivPart, ctPart] = stored.split(".");
  if (v !== "v1" || !ivPart || !ctPart) throw new Error("unknown secret format");
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromB64url(ivPart), additionalData: enc.encode(aad) },
    await aesKey(env),
    fromB64url(ctPart),
  );
  return dec.decode(pt);
}

/**
 * Keyed hash of a client IP for rate-limit keys, so the counters table never
 * holds raw IPs. Falls back to plain SHA-256 if HUB_SECRET is not configured.
 */
export async function ipKey(env: Env, ip: string): Promise<string> {
  if (!hasHubSecret(env)) return (await sha256Hex("ip:" + ip)).slice(0, 32);
  const key = await crypto.subtle.importKey(
    "raw",
    await deriveBits(env, "ip-rate-limit-v1"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return hex(await crypto.subtle.sign("HMAC", key, enc.encode(ip))).slice(0, 32);
}
