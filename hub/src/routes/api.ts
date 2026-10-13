// REST API under /v1 (docs/API.md).

import { Hono, type Context } from "hono";
import type { AppEnv } from "../types";
import {
  MAX_SESSIONS_PER_ACCOUNT,
  SESSION_COOKIE,
  SESSION_TTL_SEC,
  accountForToken,
  clearSessionCookie,
  requireAuth,
  sessionCookie,
} from "../lib/auth";
import {
  UUID_RE,
  encryptSecret,
  hasHubSecret,
  ipKey,
  newSessionId,
  newToken,
  newWebhookSecret,
  sha256Hex,
  SESSION_RE,
  timingSafeEqualStr,
} from "../lib/crypto";
import { HttpError, LIMITS, clientIp, getCookie, isSameOrigin, readJson } from "../lib/http";
import { RATE_LIMITS, enforce } from "../lib/ratelimit";
import {
  countSamples,
  daySummaries,
  listDevices,
  querySamples,
  sampleOut,
  type SampleDbRow,
} from "../lib/queries";
import { addDays, daysBetween, isDate, isValidTz, isoOut, localDate, parseIsoInstant, startOfLocalDay } from "../lib/time";
import { text, validateIngest, SCHEMA } from "../lib/validate";
import {
  MAX_WEBHOOKS,
  checkWebhookUrl,
  deliver,
  forwardIngest,
  hookAad,
  type HookRow,
} from "../lib/webhooks";

export const api = new Hono<AppEnv>();

const bearerOnly = requireAuth({ session: false });
const anyAuth = requireAuth({ session: true });

const MAX_DEVICES_PER_ACCOUNT = 10;
const DEFAULT_SAMPLE_LIMIT = 1000;
const EXPORT_CHUNK = 5000;
const EXPORT_MAX_ROWS = 200_000;
const MAX_DAY_SPAN = 366;
const FAR_FUTURE_SLACK_MS = 3 * 86_400_000;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** True when `invite` matches one of the configured codes (case-insensitive, constant time). */
async function inviteAccepted(configured: string | undefined, invite: unknown): Promise<boolean> {
  if (typeof invite !== "string" || invite.length === 0 || invite.length > 64) return false;
  const given = invite.trim().toUpperCase();
  const codes = (configured ?? "").split(",").map((c) => c.trim().toUpperCase()).filter(Boolean);
  let ok = false;
  for (const code of codes) {
    if (await timingSafeEqualStr(given, code)) ok = true;
  }
  return ok;
}

function bad(message: string): HttpError {
  return new HttpError(400, "invalid_query", message);
}

// ---------------------------------------------------------------------------
// Accounts

api.post("/accounts", async (c) => {
  const db = c.env.DB;
  await enforce(db, RATE_LIMITS.accountsPerIp, await ipKey(c.env, clientIp(c.req.raw)));
  await enforce(db, RATE_LIMITS.accountsGlobal, "all");

  const raw = await readJson(c.req.raw, LIMITS.smallBytes);
  if (!isObject(raw)) throw new HttpError(400, "invalid_body", "$: nesne olmalı");
  const name = text(raw.device_name, "device_name", 100) as string;
  if (!isValidTz(raw.tz)) throw new HttpError(400, "invalid_body", "tz: geçerli bir IANA saat dilimi olmalı");
  if (!(await inviteAccepted(c.env.HUB_INVITE_CODES, raw.invite))) {
    throw new HttpError(403, "invalid_invite", "Davet kodu geçersiz.");
  }

  const id = crypto.randomUUID();
  const token = newToken();
  await db
    .prepare("INSERT INTO accounts (id, token_hash, tz, name, created_at) VALUES (?1, ?2, ?3, ?4, ?5)")
    .bind(id, await sha256Hex(token), raw.tz, name, Date.now())
    .run();

  console.log(JSON.stringify({ message: "account created", account_id: id }));
  return c.json({ account_id: id, token, web_url: `${new URL(c.req.url).origin}/login` }, 201);
});

api.get("/me", anyAuth, async (c) => {
  const a = c.get("account");
  const db = c.env.DB;
  const [counts, devices, hooks] = await Promise.all([
    db
      .prepare("SELECT type, COUNT(*) AS n FROM samples WHERE account_id = ?1 GROUP BY type")
      .bind(a.id)
      .all<{ type: string; n: number }>(),
    listDevices(db, a.id),
    db.prepare("SELECT COUNT(*) AS n FROM webhooks WHERE account_id = ?1").bind(a.id).first<{ n: number }>(),
  ]);
  const byType: Record<string, number> = { live: 0, battery: 0 };
  for (const r of counts.results) byType[r.type] = r.n;
  return c.json({
    account_id: a.id,
    name: a.name,
    tz: a.tz,
    created_at: isoOut(a.created_at),
    samples: { live: byType.live, battery: byType.battery, total: (byType.live ?? 0) + (byType.battery ?? 0) },
    devices,
    webhooks: hooks?.n ?? 0,
  });
});

api.delete("/account", anyAuth, async (c) => {
  const a = c.get("account");
  const db = c.env.DB;
  // Explicit deletes (not only FK cascades) so nothing survives even if
  // foreign-key enforcement were off. One batch = one transaction.
  await db.batch([
    db.prepare("DELETE FROM samples WHERE account_id = ?1").bind(a.id),
    db.prepare("DELETE FROM devices WHERE account_id = ?1").bind(a.id),
    db.prepare("DELETE FROM webhooks WHERE account_id = ?1").bind(a.id),
    db.prepare("DELETE FROM sessions WHERE account_id = ?1").bind(a.id),
    db.prepare("DELETE FROM rate_limits WHERE key LIKE ?1").bind(`%:${a.id}:%`),
    db.prepare("DELETE FROM accounts WHERE id = ?1").bind(a.id),
  ]);
  console.log(JSON.stringify({ message: "account deleted", account_id: a.id }));
  c.header("Set-Cookie", clearSessionCookie());
  return c.json({ deleted: true });
});

api.post("/token/rotate", anyAuth, async (c) => {
  const a = c.get("account");
  const db = c.env.DB;
  const token = newToken();
  const keep = c.get("sessionHash") ?? "";
  await db.batch([
    db
      .prepare("UPDATE accounts SET token_hash = ?1, token_rotated_at = ?2 WHERE id = ?3")
      .bind(await sha256Hex(token), Date.now(), a.id),
    // Sign out every other web session; keep the one that asked, if any.
    db.prepare("DELETE FROM sessions WHERE account_id = ?1 AND id_hash <> ?2").bind(a.id, keep),
  ]);
  return c.json({ token });
});

// ---------------------------------------------------------------------------
// Ingest

api.post("/ingest", bearerOnly, async (c) => {
  const a = c.get("account");
  const db = c.env.DB;
  await enforce(db, RATE_LIMITS.ingestPerAccount, a.id);

  const raw = await readJson(c.req.raw, LIMITS.ingestBytes);
  const now = Date.now();
  const { body, rows } = validateIngest(raw, now);
  if (rows.length > 0) await enforce(db, RATE_LIMITS.samplesPerAccount, a.id, rows.length);

  const dev = body.device;
  const known = await db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM devices WHERE account_id = ?1) AS n,
              EXISTS (SELECT 1 FROM devices WHERE account_id = ?1 AND id = ?2) AS known`,
    )
    .bind(a.id, dev.id)
    .first<{ n: number; known: number }>();
  if (!known?.known && (known?.n ?? 0) >= MAX_DEVICES_PER_ACCOUNT) {
    throw new HttpError(409, "too_many_devices", `Bir hesapta en fazla ${MAX_DEVICES_PER_ACCOUNT} bant olabilir.`);
  }

  const stmts: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO devices (account_id, id, name, model, app_version, first_seen, last_seen)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
         ON CONFLICT (account_id, id) DO UPDATE SET
           name = excluded.name,
           model = excluded.model,
           app_version = COALESCE(excluded.app_version, devices.app_version),
           last_seen = excluded.last_seen`,
      )
      .bind(a.id, dev.id, dev.name, dev.model, dev.app_version ?? null, now),
    // One statement for up to 5000 samples: rows travel as a single JSON
    // parameter and are expanded by json_each(). Duplicates are ignored.
    db
      .prepare(
        `INSERT INTO samples (account_id, device_id, type, ts, steps, calories, heart_rate, standing_hours, level, received_at)
         SELECT ?1, ?2,
                json_extract(j.value, '$[0]'), json_extract(j.value, '$[1]'), json_extract(j.value, '$[2]'),
                json_extract(j.value, '$[3]'), json_extract(j.value, '$[4]'), json_extract(j.value, '$[5]'),
                json_extract(j.value, '$[6]'), ?3
           FROM json_each(?4) AS j
          WHERE 1
         ON CONFLICT (account_id, device_id, type, ts) DO NOTHING`,
      )
      .bind(a.id, dev.id, now, JSON.stringify(rows)),
  ];
  // The phone is the source of truth for the user's time zone.
  if (dev.tz && dev.tz !== a.tz) {
    stmts.push(db.prepare("UPDATE accounts SET tz = ?1 WHERE id = ?2").bind(dev.tz, a.id));
  }
  const results = await db.batch(stmts);
  const accepted = results[1]?.meta.changes ?? 0;
  const duplicates = rows.length - accepted;

  if (accepted > 0) c.executionCtx.waitUntil(forwardIngest(c.env, a.id, body));
  return c.json({ accepted, duplicates });
});

// ---------------------------------------------------------------------------
// Reading data

function optDevice(c: Context<AppEnv>): string | undefined {
  const v = c.req.query("device");
  if (v === undefined || v === "") return undefined;
  if (!UUID_RE.test(v)) throw bad("device: UUID olmalı");
  return v.toUpperCase();
}

function optType(c: Context<AppEnv>): "live" | "battery" | undefined {
  const v = c.req.query("type");
  if (v === undefined || v === "") return undefined;
  if (v !== "live" && v !== "battery") throw bad('type: "live" ya da "battery" olmalı');
  return v;
}

/**
 * from/to accept an ISO 8601 instant (from inclusive, to exclusive) or a
 * YYYY-MM-DD date in the account's time zone (whole days, both inclusive).
 */
function timeRange(c: Context<AppEnv>, tz: string): { from: number; to: number } {
  const f = c.req.query("from");
  const t = c.req.query("to");
  let from = 0;
  let to = Date.now() + FAR_FUTURE_SLACK_MS;
  if (f) {
    const v = isDate(f) ? startOfLocalDay(f, tz) : parseIsoInstant(f);
    if (v === null) throw bad("from: YYYY-MM-DD ya da ISO 8601 zaman olmalı");
    from = v;
  }
  if (t) {
    const v = isDate(t) ? startOfLocalDay(addDays(t, 1), tz) : parseIsoInstant(t);
    if (v === null) throw bad("to: YYYY-MM-DD ya da ISO 8601 zaman olmalı");
    to = v;
  }
  if (from > to) throw bad("from, to'dan sonra olamaz");
  return { from, to };
}

api.get("/samples", anyAuth, async (c) => {
  const a = c.get("account");
  const { from, to } = timeRange(c, a.tz);
  const limitRaw = c.req.query("limit");
  let limit = DEFAULT_SAMPLE_LIMIT;
  if (limitRaw !== undefined) {
    if (!/^\d+$/.test(limitRaw) || Number(limitRaw) < 1 || Number(limitRaw) > LIMITS.maxSamples) {
      throw bad(`limit: 1 ile ${LIMITS.maxSamples} arasında olmalı`);
    }
    limit = Number(limitRaw);
  }
  const rows = await querySamples(c.env.DB, a.id, {
    from,
    to,
    device: optDevice(c),
    type: optType(c),
    limit: limit + 1,
  });
  const hasMore = rows.length > limit;
  return c.json({ samples: rows.slice(0, limit).map(sampleOut), has_more: hasMore });
});

api.get("/days", anyAuth, async (c) => {
  const a = c.get("account");
  const today = localDate(Date.now(), a.tz);
  const to = c.req.query("to") || today;
  const from = c.req.query("from") || addDays(to, -13);
  if (!isDate(from)) throw bad("from: YYYY-MM-DD olmalı");
  if (!isDate(to)) throw bad("to: YYYY-MM-DD olmalı");
  const span = daysBetween(from, to);
  if (span < 0) throw bad("from, to'dan sonra olamaz");
  if (span >= MAX_DAY_SPAN) throw bad(`En fazla ${MAX_DAY_SPAN} gün istenebilir`);
  const days = await daySummaries(c.env.DB, a.id, a.tz, from, to, optDevice(c));
  return c.json({ tz: a.tz, from, to, days });
});

// ---------------------------------------------------------------------------
// Export (streamed in keyset-paginated chunks)

async function* exportRows(
  db: D1Database,
  accountId: string,
  q: { from: number; to: number; device?: string | undefined; type?: "live" | "battery" | undefined },
): AsyncGenerator<SampleDbRow[]> {
  let after: [number, string, string] | undefined;
  for (;;) {
    const rows = await querySamples(db, accountId, { ...q, limit: EXPORT_CHUNK, after });
    if (rows.length > 0) yield rows;
    if (rows.length < EXPORT_CHUNK) return;
    const last = rows[rows.length - 1] as SampleDbRow;
    after = [last.ts, last.device_id, last.type];
  }
}

function textStream(gen: AsyncGenerator<string>): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await gen.next();
        if (done) controller.close();
        else controller.enqueue(enc.encode(value));
      } catch (err) {
        controller.error(err);
      }
    },
    async cancel() {
      await gen.return(undefined);
    },
  });
}

const csvCell = (v: unknown): string => (v === null || v === undefined ? "" : String(v));

async function prepareExport(c: Context<AppEnv>) {
  const a = c.get("account");
  const { from, to } = timeRange(c, a.tz);
  const q = { from, to, device: optDevice(c), type: optType(c) };
  const n = await countSamples(c.env.DB, a.id, q);
  if (n > EXPORT_MAX_ROWS) {
    throw new HttpError(
      413,
      "export_too_large",
      `Bu aralıkta ${n} örnek var; tek seferde en fazla ${EXPORT_MAX_ROWS}. from/to ile aralığı daralt.`,
    );
  }
  const stamp = localDate(Date.now(), a.tz);
  return { a, q, stamp };
}

api.get("/export.csv", anyAuth, async (c) => {
  const { a, q, stamp } = await prepareExport(c);
  const db = c.env.DB;
  async function* lines(): AsyncGenerator<string> {
    yield "device_id,type,ts,steps,calories,heart_rate,standing_hours,level\n";
    for await (const rows of exportRows(db, a.id, q)) {
      let chunk = "";
      for (const r of rows) {
        chunk +=
          [r.device_id, r.type, isoOut(r.ts), r.steps, r.calories, r.heart_rate, r.standing_hours, r.level]
            .map(csvCell)
            .join(",") + "\n";
      }
      yield chunk;
    }
  }
  return new Response(textStream(lines()), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="openband-${stamp}.csv"`,
    },
  });
});

api.get("/export.json", anyAuth, async (c) => {
  const { a, q, stamp } = await prepareExport(c);
  const db = c.env.DB;
  const devices = await listDevices(db, a.id);
  async function* parts(): AsyncGenerator<string> {
    const head = {
      schema: SCHEMA,
      exported_at: isoOut(Date.now()),
      account_id: a.id,
      tz: a.tz,
      from: isoOut(q.from),
      to: isoOut(q.to),
      devices: q.device ? devices.filter((d) => d.id === q.device) : devices,
    };
    yield JSON.stringify(head).slice(0, -1) + ',"samples":[';
    let first = true;
    for await (const rows of exportRows(db, a.id, q)) {
      const s = rows.map((r) => JSON.stringify(sampleOut(r))).join(",\n");
      yield (first ? "\n" : ",\n") + s;
      first = false;
    }
    yield "\n]}\n";
  }
  return new Response(textStream(parts()), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="openband-${stamp}.json"`,
    },
  });
});

// ---------------------------------------------------------------------------
// Webhooks

interface HookPublic {
  id: string;
  url: string;
  created_at: number;
  last_delivery_at: number | null;
  last_status: number | null;
  last_error: string | null;
}

const HOOK_PUBLIC_COLS = "id, url, created_at, last_delivery_at, last_status, last_error";

function hookOut(h: HookPublic) {
  return {
    id: h.id,
    url: h.url,
    created_at: isoOut(h.created_at),
    last_delivery_at: h.last_delivery_at === null ? null : isoOut(h.last_delivery_at),
    last_status: h.last_status,
    last_error: h.last_error,
  };
}

function hookId(c: Context<AppEnv>): string {
  const id = c.req.param("id") ?? "";
  if (!UUID_RE.test(id)) throw new HttpError(404, "not_found", "Webhook bulunamadı.");
  return id.toLowerCase();
}

function ownHosts(c: Context<AppEnv>): string[] {
  return [c.env.PUBLIC_HOSTNAME, new URL(c.req.url).hostname];
}

api.get("/webhooks", anyAuth, async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT ${HOOK_PUBLIC_COLS} FROM webhooks WHERE account_id = ?1 ORDER BY created_at`,
  )
    .bind(c.get("account").id)
    .all<HookPublic>();
  return c.json({ webhooks: results.map(hookOut) });
});

api.get("/webhooks/:id", anyAuth, async (c) => {
  const row = await c.env.DB.prepare(`SELECT ${HOOK_PUBLIC_COLS} FROM webhooks WHERE id = ?1 AND account_id = ?2`)
    .bind(hookId(c), c.get("account").id)
    .first<HookPublic>();
  if (!row) throw new HttpError(404, "not_found", "Webhook bulunamadı.");
  return c.json(hookOut(row));
});

api.post("/webhooks", anyAuth, async (c) => {
  if (!hasHubSecret(c.env)) {
    throw new HttpError(503, "not_configured", "Webhook'lar bu sunucuda henüz yapılandırılmadı.");
  }
  const a = c.get("account");
  const db = c.env.DB;
  const raw = await readJson(c.req.raw, LIMITS.smallBytes);
  if (!isObject(raw)) throw new HttpError(400, "invalid_body", "$: nesne olmalı");
  const check = checkWebhookUrl(raw.url, ownHosts(c));
  if (!check.ok) throw new HttpError(400, "invalid_body", check.message);

  const existing = await db
    .prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(url = ?2), 0) AS same FROM webhooks WHERE account_id = ?1`,
    )
    .bind(a.id, check.url)
    .first<{ n: number; same: number }>();
  if ((existing?.same ?? 0) > 0) throw new HttpError(409, "duplicate", "Bu adres zaten ekli.");
  if ((existing?.n ?? 0) >= MAX_WEBHOOKS) {
    throw new HttpError(409, "webhook_limit", `En fazla ${MAX_WEBHOOKS} webhook eklenebilir.`);
  }

  const id = crypto.randomUUID();
  const secret = newWebhookSecret();
  const createdAt = Date.now();
  const secretEnc = await encryptSecret(c.env, secret, hookAad({ account_id: a.id, id }));
  // Conditional insert keeps the 5-per-account cap even under concurrent requests.
  const res = await db
    .prepare(
      `INSERT INTO webhooks (id, account_id, url, secret_enc, created_at)
       SELECT ?1, ?2, ?3, ?4, ?5
        WHERE (SELECT COUNT(*) FROM webhooks WHERE account_id = ?2) < ?6
       ON CONFLICT DO NOTHING`,
    )
    .bind(id, a.id, check.url, secretEnc, createdAt, MAX_WEBHOOKS)
    .run();
  if (!res.meta.changes) {
    throw new HttpError(409, "webhook_limit", `En fazla ${MAX_WEBHOOKS} webhook eklenebilir.`);
  }
  return c.json({ id, url: check.url, secret, created_at: isoOut(createdAt) }, 201);
});

api.delete("/webhooks/:id", anyAuth, async (c) => {
  const res = await c.env.DB.prepare("DELETE FROM webhooks WHERE id = ?1 AND account_id = ?2")
    .bind(hookId(c), c.get("account").id)
    .run();
  if (!res.meta.changes) throw new HttpError(404, "not_found", "Webhook bulunamadı.");
  return c.json({ deleted: true });
});

api.post("/webhooks/:id/test", anyAuth, async (c) => {
  const a = c.get("account");
  const id = hookId(c);
  const hook = await c.env.DB.prepare(
    "SELECT id, account_id, url, secret_enc FROM webhooks WHERE id = ?1 AND account_id = ?2",
  )
    .bind(id, a.id)
    .first<HookRow>();
  if (!hook) throw new HttpError(404, "not_found", "Webhook bulunamadı.");
  await enforce(c.env.DB, RATE_LIMITS.webhookTestPerAccount, a.id);
  const body = new TextEncoder().encode(
    JSON.stringify({ schema: SCHEMA, event: "ping", sent_at: isoOut(Date.now()), webhook_id: hook.id }),
  );
  return c.json(await deliver(c.env, hook, "ping", body));
});

// ---------------------------------------------------------------------------
// Web panel session

api.post("/session", async (c) => {
  if (!isSameOrigin(c.req.raw)) {
    throw new HttpError(403, "cross_origin", "Giriş yalnız OpenBand sayfasından yapılabilir.");
  }
  const db = c.env.DB;
  await enforce(db, RATE_LIMITS.sessionPerIp, await ipKey(c.env, clientIp(c.req.raw)));
  const raw = await readJson(c.req.raw, LIMITS.smallBytes);
  const token = isObject(raw) && typeof raw.token === "string" ? raw.token.trim() : "";
  const account = await accountForToken(db, token);
  if (!account) throw new HttpError(401, "invalid_token", "Bu anahtar geçerli değil.");

  const sid = newSessionId();
  const now = Date.now();
  await db.batch([
    db
      .prepare("INSERT INTO sessions (id_hash, account_id, created_at, expires_at) VALUES (?1, ?2, ?3, ?4)")
      .bind(await sha256Hex(sid), account.id, now, now + SESSION_TTL_SEC * 1000),
    // Keep at most N sessions per account; drop the oldest.
    db
      .prepare(
        `DELETE FROM sessions WHERE account_id = ?1 AND id_hash NOT IN (
           SELECT id_hash FROM sessions WHERE account_id = ?1 ORDER BY created_at DESC LIMIT ?2)`,
      )
      .bind(account.id, MAX_SESSIONS_PER_ACCOUNT),
  ]);
  c.header("Set-Cookie", sessionCookie(sid, SESSION_TTL_SEC));
  return c.json({ ok: true, expires_at: isoOut(now + SESSION_TTL_SEC * 1000) });
});

api.delete("/session", async (c) => {
  if (!isSameOrigin(c.req.raw)) {
    throw new HttpError(403, "cross_origin", "Çıkış yalnız OpenBand sayfasından yapılabilir.");
  }
  const sid = getCookie(c.req.raw, SESSION_COOKIE);
  if (sid && SESSION_RE.test(sid)) {
    await c.env.DB.prepare("DELETE FROM sessions WHERE id_hash = ?1").bind(await sha256Hex(sid)).run();
  }
  c.header("Set-Cookie", clearSessionCookie());
  return c.json({ ok: true });
});

api.all("*", (c) => c.json({ error: "not_found", message: "Böyle bir uç nokta yok." }, 404));

