# Freeband hub

A Cloudflare Worker with a D1 database that gives Freeband users an opt-in REST API, server-side webhooks and a small web panel for their band data. The contract is [`../docs/API.md`](../docs/API.md) and the visual system is [`../docs/DESIGN.md`](../docs/DESIGN.md).

The hub is meant to run at `https://freeband.cobanov.dev` for the owner and invited friends. It stores health data, so keep this repository private until the open items in [Security notes](#security-notes) are settled.

## Layout

```
hub/
  wrangler.jsonc            Worker config (custom domain, D1 binding with a PLACEHOLDER id, cron, observability)
  migrations/0001_init.sql  D1 schema: accounts, devices, samples, webhooks, sessions, rate_limits
  public/                   Static assets: self-hosted Archivo (SIL OFL), favicon, _headers
  src/
    index.ts                Entry: security headers + CSP nonce, error handling, scheduled cleanup
    types.ts                Hono context types
    routes/api.ts           /v1/* endpoints
    routes/pages.ts         /, /login, /app, /docs, /privacy
    lib/auth.ts             Bearer token and session cookie auth, CSRF check for cookie requests
    lib/crypto.ts           Tokens, hashing, HMAC, AES-GCM for webhook secrets, keyed IP hashes
    lib/http.ts             Bounded JSON body reader, cookies, same-origin check
    lib/ratelimit.ts        Fixed-window limits in D1
    lib/validate.ts         freeband.v1 ingest validation
    lib/queries.ts          Account-scoped read queries (samples, daily summaries, devices)
    lib/time.ts             Time-zone math on Intl (DST-safe local days)
    lib/webhooks.ts         URL policy, signing, delivery with a 5 s timeout
    views/                  HTML templates (auto-escaping), layout + CSS, the 24-hour dial, docs, privacy, inline JS
  test/                     Vitest suites running inside workerd via @cloudflare/vitest-plugin
```

The only runtime dependency is `hono`. All versions are pinned exactly in `package.json` (and `.npmrc` has `save-exact=true`); `undici` and `sharp`, which only the local toolchain uses, are overridden to patched releases so `npm audit` is clean.

## Local development

Requirements: Node.js 22 or newer and npm. Nothing below touches your Cloudflare account.

```sh
cd hub
npm ci

# Local-only secret for webhook-secret encryption and IP hashing. .dev.vars is gitignored.
printf 'HUB_SECRET=%s\n' "$(openssl rand -base64 48 | tr -d '\n')" > .dev.vars
chmod 600 .dev.vars

npm run db:migrate:local      # wrangler d1 migrations apply openband-hub --local
npm run dev                   # wrangler dev --local, http://localhost:8787
```

Try it:

```sh
curl -s -X POST http://localhost:8787/v1/accounts \
  -H 'Content-Type: application/json' \
  -d '{"device_name": "Band 10 Pro", "tz": "Europe/Istanbul"}'
# then open http://localhost:8787/login#token=<token from the response>
```

Notes:

- `wrangler.jsonc` sets `dev.host` to `localhost:8787` so that `request.url` matches what the browser sends in `Origin`; without it wrangler rewrites the URL to the custom-domain route and the same-origin check rejects panel requests. If you run on another port, change `dev.host` too.
- The session cookie is `__Host-fb_session; Secure`. Chrome and Firefox accept Secure cookies on `http://localhost`; Safari does not, so use Chrome or Firefox for the panel in local dev.
- Cron triggers do not fire locally. Run the cleanup by hand with `curl "http://localhost:8787/cdn-cgi/local/scheduled"` (wrangler prints the exact URL on start).
- Local D1 data lives in `.wrangler/state` (gitignored). Delete that folder to start over.

### Tests and type check

```sh
npm test            # vitest run (workerd via @cloudflare/vitest-plugin, local D1, migrations applied in test/apply-migrations.ts)
npm run typecheck   # tsc --noEmit
```

Tests generate a throwaway `HUB_SECRET` per run in `vitest.config.ts`, which overrides any `.dev.vars`; nothing secret is written to disk. Outbound webhook calls are intercepted with `vi.spyOn(globalThis, "fetch")`; the webhook timeout test really waits 5 seconds.

After changing bindings in `wrangler.jsonc`, regenerate types with `npm run types` (`wrangler types`).

## D1 migrations

```sh
npx wrangler d1 migrations create openband-hub <short_name>   # new file in migrations/
npx wrangler d1 migrations list   openband-hub --local
npx wrangler d1 migrations apply  openband-hub --local
# production, only after review:
npx wrangler d1 migrations list   openband-hub --remote
npx wrangler d1 migrations apply  openband-hub --remote
```

Migrations are append-only. Never edit `0001_init.sql` after it has been applied remotely; add a new file instead.

## Deploying to freeband.cobanov.dev

Do this only when the owner approves. It needs the `cobanov.dev` zone in the same Cloudflare account and a Wrangler login (`npx wrangler login`) or an API token with Workers Scripts, D1 and Workers Routes edit rights for that account.

```sh
cd hub
npx wrangler whoami                                  # confirm the account

# 1. Create the database and put its id into wrangler.jsonc (replace the 0000... placeholder).
npx wrangler d1 create openband-hub

# 2. Create the schema.
npx wrangler d1 migrations apply openband-hub --remote

# 3. Check the bundle without uploading.
npx wrangler deploy --dry-run

# 4. First deploy with the secret. secrets.required makes deploy fail without HUB_SECRET.
#    Generate it into a private temp file, deploy, then delete the file.
umask 077
printf 'HUB_SECRET=%s\n' "$(openssl rand -base64 48 | tr -d '\n')" > "$TMPDIR/openband-hub.secrets"
npx wrangler deploy --secrets-file "$TMPDIR/openband-hub.secrets"
rm -P "$TMPDIR/openband-hub.secrets"

# Later deploys:
npx wrangler deploy
```

`routes` uses `custom_domain: true`, so the first deploy creates the DNS record and certificate for `freeband.cobanov.dev`. `workers_dev` and `preview_urls` are off, so the Worker is reachable only on that hostname.

Keep a copy of `HUB_SECRET` somewhere safe (for example a password manager). If it changes, the stored webhook secrets can no longer be decrypted and every webhook has to be recreated. To set it again without redeploying code: `npx wrangler secret put HUB_SECRET` (this creates a new deployment).

After deploying, check: `curl -sI https://freeband.cobanov.dev/ | grep -i content-security-policy`, create an account from the app, open the panel, add a webhook to a receiver you control and press "Test et".

## Configuration and limits

| What | Value | Where |
|---|---|---|
| Body size, `/v1/ingest` | 512 KB | `src/lib/http.ts` `LIMITS` |
| Body size, other JSON endpoints | 8 KB | `src/lib/http.ts` `LIMITS` |
| Samples per ingest | 5000 | `src/lib/http.ts` `LIMITS` |
| New accounts | 10 per IP per hour, 200 per day hub-wide | `src/lib/ratelimit.ts` |
| Panel sign-in | 20 per IP per 15 minutes | `src/lib/ratelimit.ts` |
| Ingest | 120 requests per hour, 200 000 samples per day, per account | `src/lib/ratelimit.ts` |
| Webhook test pings | 20 per hour per account | `src/lib/ratelimit.ts` |
| Webhooks | 5 per account, https only, 5 s timeout, no redirects | `src/lib/webhooks.ts` |
| Bands | 10 per account | `src/routes/api.ts` |
| Sessions | 30 days, at most 20 per account | `src/lib/auth.ts` |
| Export | 200 000 samples per request, streamed in 5000-row pages | `src/routes/api.ts` |
| `/v1/days` range | 366 days | `src/routes/api.ts` |

## Security notes

### Done

- **Tokens**: `fb_` + base64url of 32 bytes from `crypto.getRandomValues`. Only the SHA-256 is stored (`accounts.token_hash`); the token is returned once. Lookup by hash, then a constant-time comparison.
- **Account scoping**: every query binds `account_id` (or the account's own id) as a parameter; device ids are namespaced per account (`PRIMARY KEY (account_id, id)`), so the same band UUID in two accounts never mixes. Tests cover reads, exports, webhooks and the panel across accounts.
- **Input validation**: strict JSON content type, 512 KB cap enforced while streaming (not only via `Content-Length`), 5000 samples, fatal UTF-8 decoding, field types and ranges (`heart_rate` 0–250, `level` 0–100, `ts` at most 2 days ahead and not before 2020), UUID device ids, model enum, IANA time zones, control characters refused. Unknown fields are dropped.
- **Webhooks**: `https://` only, port 443, no credentials in the URL, no IP literals, single-label or reserved names, never the hub's own hostname or its subdomains; at most 5 per account (enforced atomically in SQL). Secrets are 32 random bytes, returned once, stored with AES-256-GCM (key derived by HKDF from `HUB_SECRET`, row-bound AAD). Deliveries carry `X-Freeband-Event`, `X-Freeband-Delivery` (random UUID) and `X-Freeband-Signature: sha256=<hex>` over the exact bytes sent, do not follow redirects and time out after 5 s, all inside `ctx.waitUntil`.
- **Sessions**: `__Host-fb_session`, `HttpOnly; Secure; SameSite=Strict; Path=/`, 30 days, random 32 bytes, only the SHA-256 stored. Token rotation and account deletion end sessions. The login token travels in the URL fragment, is removed from the address bar with `history.replaceState`, and is exchanged for the cookie by `POST /v1/session`.
- **CSRF**: cookie-authenticated `POST`/`DELETE` requests must carry `Origin` equal to the hub's origin (or `Sec-Fetch-Site: same-origin` when `Origin` is absent), on top of `SameSite=Strict`. `POST`/`DELETE /v1/session` require the same, which also blocks login CSRF. Bearer requests need no Origin. The ingest endpoint does not accept cookies at all.
- **Headers**: HTML gets a per-response nonce CSP (`default-src 'none'; script-src 'nonce-…'; style-src 'nonce-…'; font-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`), no `unsafe-inline` or `unsafe-eval`, no inline handlers or style attributes. All responses get `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, COOP/CORP `same-origin`, HSTS and `Cache-Control: no-store`. JSON gets `default-src 'none'`. No CORS headers. Static assets get headers from `public/_headers`.
- **XSS**: HTML is built with an auto-escaping template tag; inline scripts are constants and set user-visible strings with `textContent`.
- **Rate limits**: per IP for sign-up and sign-in (keyed HMAC of the IP, never the raw IP), per account for ingest and webhook tests, plus a hub-wide daily sign-up cap. Counters are cleaned daily by the cron.
- **No third parties**: fonts are self-hosted; no analytics, no external scripts.
- **Logging**: structured JSON; no tokens, cookies, bodies or IPs are logged.

### Open

- **Open sign-up.** Anyone who finds the hub can create an account (within the rate limits) and store up to 200 000 samples a day. An invite code would need a contract change because the app creates accounts itself.
- **No replay protection on webhooks.** The contract signs only the body; a captured delivery can be replayed. Suggest a signed `X-Freeband-Timestamp` in a future contract version. Receivers should dedupe on `(device.id, type, ts)` and `X-Freeband-Delivery`.
- **No delivery retries.** A failed delivery is recorded (`last_status`, `last_error`) but not retried. Cloudflare Queues would add retries with backoff.
- **DNS-level SSRF is not checked.** Host names are filtered syntactically; a public name that resolves to a private address is not detected (Workers cannot resolve DNS themselves). Cloudflare's egress does not reach private networks, but webhooks can POST to any public host, bounded by the ingest and test rate limits.
- **`HUB_SECRET` has no rotation path.** Changing it orphans every stored webhook secret. The ciphertext carries a `v1.` prefix so a keyed rotation can be added later.
- **The operator can read the data.** D1 is encrypted at rest by Cloudflare but not end-to-end; the account owner of the Cloudflare account can query it. The privacy page says so.
- **Deleted data lingers in D1 Time Travel** for up to 30 days (7 on the free plan). The privacy page says so.
- **Contract tension on size.** 5000 compact `live` samples are 520–540 KB, above the 512 KB cap. The app should send at most about 4500 `live` samples per body.
- **No data retention limit.** Samples are kept until the account is deleted.
- **Bearer tokens do not expire.** They are revoked only by rotation or account deletion.
- **Rate limits are fixed windows in D1.** Fine for a small hub; they add one write per limited request. Workers Rate Limiting or a Durable Object would scale better.
- **D1 free plan allows 50 queries per invocation.** Exports above roughly 200 000 rows are refused with 413 instead of paging further.
- **New sample types** (`minute`, `sleep`) are rejected with 400 until the hub learns them. Update the hub before the app starts sending them.
