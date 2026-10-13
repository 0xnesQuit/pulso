// Freeband hub: Worker entry point.

import { Hono, type MiddlewareHandler } from "hono";
import type { AppEnv } from "./types";
import { api } from "./routes/api";
import { pages } from "./routes/pages";
import { ConfigError, b64url, randomBytes } from "./lib/crypto";
import { HttpError, errorBody } from "./lib/http";
import { html } from "./views/html";
import { page } from "./views/layout";

const app = new Hono<AppEnv>();

function htmlCsp(nonce: string): string {
  return [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    `style-src 'nonce-${nonce}'`,
    "font-src 'self'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
  ].join("; ");
}

const API_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

/** Security headers on every response; a fresh CSP nonce per request. */
const securityHeaders: MiddlewareHandler<AppEnv> = async (c, next) => {
  const nonce = b64url(randomBytes(18));
  c.set("nonce", nonce);
  await next();
  const h = c.res.headers;
  const isHtml = (h.get("content-type") ?? "").startsWith("text/html");
  h.set("Content-Security-Policy", isHtml ? htmlCsp(nonce) : API_CSP);
  h.set("X-Content-Type-Options", "nosniff");
  h.set("Referrer-Policy", "no-referrer");
  h.set("X-Frame-Options", "DENY");
  h.set("Cross-Origin-Opener-Policy", "same-origin");
  h.set("Cross-Origin-Resource-Policy", "same-origin");
  h.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()");
  if (new URL(c.req.url).protocol === "https:") {
    h.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  if (!h.has("Cache-Control")) h.set("Cache-Control", "no-store");
};

app.use("*", securityHeaders);
app.route("/v1", api);
app.route("/", pages);

const isApi = (path: string): boolean => path === "/v1" || path.startsWith("/v1/");

function errorPage(nonce: string, title: string, text: string): string {
  return page({
    title,
    nonce,
    body: html`<section class="narrow"><p class="label">hata</p><h1>${title}</h1><p class="lede">${text}</p><a class="btn ghost" href="/">Ana sayfaya dön</a></section>`,
  });
}

app.notFound((c) => {
  if (isApi(c.req.path)) return c.json(errorBody("not_found", "Böyle bir uç nokta yok."), 404);
  return c.html(errorPage(c.get("nonce"), "Sayfa bulunamadı", "Aradığın sayfa burada değil."), 404);
});

app.onError((err, c) => {
  if (err instanceof HttpError) {
    for (const [k, v] of Object.entries(err.headers)) c.header(k, v);
    if (isApi(c.req.path)) {
      return c.json(errorBody(err.code, err.message), err.status as 400);
    }
    return c.html(errorPage(c.get("nonce"), "Bir sorun var", err.message), err.status as 400);
  }
  if (err instanceof ConfigError) {
    console.error(JSON.stringify({ message: "configuration error", error: err.message }));
    return c.json(errorBody("not_configured", "Sunucu henüz tam yapılandırılmadı."), 503);
  }
  // Never echo internals; log the message and the path only (no bodies, no headers).
  console.error(
    JSON.stringify({
      message: "unhandled error",
      error: err instanceof Error ? err.message : String(err),
      method: c.req.method,
      path: c.req.path,
    }),
  );
  if (isApi(c.req.path)) return c.json(errorBody("internal", "Beklenmeyen bir hata oldu. Tekrar dene."), 500);
  return c.html(errorPage(c.get("nonce"), "Bir sorun var", "Beklenmeyen bir hata oldu. Biraz sonra tekrar dene."), 500);
});

export default {
  fetch: app.fetch,

  /** Daily cleanup of expired sessions and stale rate-limit windows. */
  async scheduled(_controller, env, ctx) {
    const now = Date.now();
    ctx.waitUntil(
      env.DB.batch([
        env.DB.prepare("DELETE FROM sessions WHERE expires_at <= ?1").bind(now),
        env.DB.prepare("DELETE FROM rate_limits WHERE window_start < ?1").bind(Math.floor(now / 1000) - 2 * 86_400),
      ]).then(
        () => console.log(JSON.stringify({ message: "cleanup done" })),
        (err: unknown) =>
          console.error(JSON.stringify({ message: "cleanup failed", error: err instanceof Error ? err.message : String(err) })),
      ),
    );
  },
} satisfies ExportedHandler<Env>;
