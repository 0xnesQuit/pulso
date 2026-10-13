// Fixed-window rate limits stored in D1.

import { HttpError } from "./http";

export interface Limit {
  scope: string;
  limit: number;
  windowSec: number;
}

export const RATE_LIMITS = {
  /** New accounts per client IP. */
  accountsPerIp: { scope: "acct-ip", limit: 10, windowSec: 3600 },
  /** New accounts across the whole hub per day (stops mass sign-up from many IPs). */
  accountsGlobal: { scope: "acct-all", limit: 200, windowSec: 86_400 },
  /** Web panel sign-in attempts per client IP. */
  sessionPerIp: { scope: "sess-ip", limit: 20, windowSec: 900 },
  /** Ingest requests per account. */
  ingestPerAccount: { scope: "ingest", limit: 120, windowSec: 3600 },
  /** Ingested samples per account per day (counts every sample, duplicates too). */
  samplesPerAccount: { scope: "ingest-samples", limit: 200_000, windowSec: 86_400 },
  /** Manual webhook test pings per account. */
  webhookTestPerAccount: { scope: "wh-test", limit: 20, windowSec: 3600 },
} as const satisfies Record<string, Limit>;

/**
 * Adds `cost` to the counter for `subject` and throws 429 when the window's
 * total exceeds the limit. One atomic UPSERT per call.
 */
export async function enforce(db: D1Database, l: Limit, subject: string, cost = 1): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const windowStart = now - (now % l.windowSec);
  const key = `${l.scope}:${subject}:${l.windowSec}`;
  const row = await db
    .prepare(
      `INSERT INTO rate_limits (key, window_start, count) VALUES (?1, ?2, ?3)
       ON CONFLICT (key) DO UPDATE SET
         count = CASE WHEN rate_limits.window_start = excluded.window_start
                      THEN rate_limits.count + excluded.count ELSE excluded.count END,
         window_start = excluded.window_start
       RETURNING count`,
    )
    .bind(key, windowStart, cost)
    .first<{ count: number }>();
  if ((row?.count ?? 0) > l.limit) {
    const retryAfter = Math.max(1, windowStart + l.windowSec - now);
    throw new HttpError(
      429,
      "rate_limited",
      "Çok fazla istek. Biraz bekleyip tekrar dene.",
      { "Retry-After": String(retryAfter) },
    );
  }
}
