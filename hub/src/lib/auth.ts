// Authentication: bearer tokens for the app and API clients, an HttpOnly
// session cookie for the web panel. Every lookup returns one account and all
// later queries are scoped to that account's id.

import type { Context, MiddlewareHandler } from "hono";
import type { Account, AppEnv } from "../types";
import { SESSION_RE, TOKEN_RE, sha256Hex, timingSafeEqualStr } from "./crypto";
import { HttpError, getCookie, isSameOrigin } from "./http";

/** `__Host-` prefix: browser enforces Secure, Path=/ and no Domain attribute. */
export const SESSION_COOKIE = "__Host-ob_session";
export const SESSION_TTL_SEC = 30 * 86_400;
export const MAX_SESSIONS_PER_ACCOUNT = 20;

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function sessionCookie(value: string, maxAgeSec: number): string {
  return `${SESSION_COOKIE}=${value}; Path=/; Max-Age=${maxAgeSec}; HttpOnly; Secure; SameSite=Strict`;
}

export const clearSessionCookie = (): string => sessionCookie("", 0);

interface AccountRow extends Account {
  token_hash: string;
}

export async function accountForToken(db: D1Database, token: string): Promise<Account | null> {
  if (!TOKEN_RE.test(token)) return null;
  const hash = await sha256Hex(token);
  const row = await db
    .prepare("SELECT id, tz, name, created_at, token_hash FROM accounts WHERE token_hash = ?1")
    .bind(hash)
    .first<AccountRow>();
  // The indexed lookup is on a hash of a 256-bit secret; the explicit
  // constant-time check is defence in depth.
  if (!row || !(await timingSafeEqualStr(row.token_hash, hash))) return null;
  return { id: row.id, tz: row.tz, name: row.name, created_at: row.created_at };
}

export async function accountForSession(
  db: D1Database,
  sessionId: string,
): Promise<{ account: Account; sessionHash: string } | null> {
  if (!SESSION_RE.test(sessionId)) return null;
  const hash = await sha256Hex(sessionId);
  const row = await db
    .prepare(
      `SELECT a.id, a.tz, a.name, a.created_at, s.id_hash
         FROM sessions s JOIN accounts a ON a.id = s.account_id
        WHERE s.id_hash = ?1 AND s.expires_at > ?2`,
    )
    .bind(hash, Date.now())
    .first<Account & { id_hash: string }>();
  if (!row || !(await timingSafeEqualStr(row.id_hash, hash))) return null;
  return {
    account: { id: row.id, tz: row.tz, name: row.name, created_at: row.created_at },
    sessionHash: hash,
  };
}

/** Session lookup for HTML pages (GET only, no CSRF concern). */
export async function pageSession(c: Context<AppEnv>): Promise<{ account: Account; sessionHash: string } | null> {
  const sid = getCookie(c.req.raw, SESSION_COOKIE);
  return sid ? accountForSession(c.env.DB, sid) : null;
}

/**
 * Requires a valid bearer token, or (when `session` is true) a valid session
 * cookie. Cookie-authenticated requests that change state must also pass the
 * same-origin check, on top of SameSite=Strict.
 */
export function requireAuth(opts: { session: boolean }): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const authz = c.req.header("authorization");
    if (authz !== undefined) {
      const m = /^Bearer\s+(\S+)$/i.exec(authz);
      const account = m?.[1] ? await accountForToken(c.env.DB, m[1]) : null;
      if (!account) throw unauthorized();
      c.set("account", account);
      c.set("authVia", "bearer");
      c.set("sessionHash", null);
      return next();
    }

    if (opts.session) {
      const sid = getCookie(c.req.raw, SESSION_COOKIE);
      if (sid) {
        if (!SAFE_METHODS.has(c.req.method) && !isSameOrigin(c.req.raw)) {
          throw new HttpError(403, "cross_origin", "Bu istek yalnız OpenBand panelinden yapılabilir.");
        }
        const s = await accountForSession(c.env.DB, sid);
        if (s) {
          c.set("account", s.account);
          c.set("authVia", "session");
          c.set("sessionHash", s.sessionHash);
          return next();
        }
      }
    }
    throw unauthorized();
  };
}

function unauthorized(): HttpError {
  return new HttpError(401, "unauthorized", "Geçerli bir anahtar gerekli.", {
    "WWW-Authenticate": 'Bearer realm="openband"',
  });
}
