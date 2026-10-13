import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect } from "vitest";
import worker from "../src/index";

export const ORIGIN = "https://openband.cobanov.dev";
export const DEV_A = "5B0E2C9A-4C7D-4F57-9A39-2D2B1D9E8A10";
export const DEV_B = "0F1E2D3C-4B5A-4978-8695-A4B3C2D1E0F9";

let ipSeq = 0;
/** A fresh client IP per call unless one is given, so per-IP limits do not interfere. */
export const freshIp = (): string => `203.0.113.${(ipSeq++ % 250) + 1}`;

export interface CallInit extends RequestInit {
  ip?: string;
}

/** Runs one request through the Worker and waits for its waitUntil work. */
export async function call(path: string, init: CallInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (!headers.has("cf-connecting-ip")) headers.set("cf-connecting-ip", init.ip ?? freshIp());
  const { ip: _ip, ...rest } = init;
  const req = new Request(ORIGIN + path, { ...rest, headers });
  const ctx = createExecutionContext();
  const res = await worker.fetch(req, env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

export const bearer = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });

export function json(body: unknown, extra: Record<string, string> = {}): CallInit {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json", ...extra },
    body: JSON.stringify(body),
  };
}

export async function createAccount(opts: { tz?: string; name?: string; ip?: string } = {}) {
  const res = await call("/v1/accounts", {
    ...json({ device_name: opts.name ?? "Band 10 Pro D9B9", tz: opts.tz ?? "Europe/Istanbul", invite: "test-invite" }),
    ip: opts.ip ?? freshIp(),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { account_id: string; token: string; web_url: string };
}

export function live(ts: string, steps: number, heart_rate = 70, calories = Math.floor(steps / 25)) {
  return { type: "live", ts, steps, calories, heart_rate, standing_hours: 3 };
}

export function battery(ts: string, level: number) {
  return { type: "battery", ts, level };
}

export function syncBody(samples: unknown[], device: Partial<Record<string, unknown>> = {}) {
  return {
    schema: "openband.v1",
    event: "sync.completed",
    device: {
      id: DEV_A,
      name: "Xiaomi Smart Band 10 Pro D9B9",
      model: "band10pro",
      app_version: "0.4 (8)",
      tz: "Europe/Istanbul",
      ...device,
    },
    sent_at: "2026-10-13T21:00:02Z",
    summary: { date: "2026-10-13", steps: 8421, calories: 312, heart_rate_last: 74, battery: 46 },
    samples,
  };
}

export async function ingest(token: string, body: unknown): Promise<Response> {
  return call("/v1/ingest", json(body, bearer(token)));
}

/** Signs in through POST /v1/session and returns the "name=value" cookie pair. */
export async function login(token: string): Promise<string> {
  const res = await call("/v1/session", json({ token }, { Origin: ORIGIN }));
  expect(res.status).toBe(200);
  const sc = res.headers.get("set-cookie") ?? "";
  const pair = sc.split(";")[0] ?? "";
  expect(pair.startsWith("__Host-ob_session=")).toBe(true);
  return pair;
}

/** Independent SHA-256 hex (does not use src/lib/crypto). */
export async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Independent HMAC-SHA256 hex (does not use src/lib/crypto). */
export async function hmacHex(secret: string, body: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, body);
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export { env };
