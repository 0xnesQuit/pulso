import { describe, expect, it } from "vitest";
import { DEV_B, bearer, call, createAccount, ingest, live, login, syncBody } from "./helpers";

function cspNonce(csp: string): string {
  const m = /script-src 'nonce-([A-Za-z0-9_-]+)'/.exec(csp);
  expect(m).not.toBeNull();
  return m?.[1] ?? "";
}

describe("security headers", () => {
  it("sends a nonce-based CSP and hardening headers on HTML", async () => {
    for (const path of ["/", "/login", "/join", "/docs", "/privacy", "/does-not-exist"]) {
      const res = await call(path);
      expect(res.headers.get("content-type"), path).toContain("text/html");
      const csp = res.headers.get("content-security-policy") ?? "";
      expect(csp).toContain("default-src 'none'");
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).toContain("base-uri 'none'");
      expect(csp).not.toContain("unsafe-inline");
      expect(csp).not.toContain("unsafe-eval");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("referrer-policy")).toBe("no-referrer");
      expect(res.headers.get("x-frame-options")).toBe("DENY");
      expect(res.headers.get("strict-transport-security")).toContain("max-age=");

      const nonce = cspNonce(csp);
      const htmlText = await res.text();
      const scripts = [...htmlText.matchAll(/<script\b([^>]*)>/g)];
      for (const s of scripts) expect(s[1], path).toContain(`nonce="${nonce}"`);
      const styles = [...htmlText.matchAll(/<style\b([^>]*)>/g)];
      for (const s of styles) expect(s[1], path).toContain(`nonce="${nonce}"`);
      // No inline handlers or style attributes that the CSP would have to allow.
      expect(htmlText).not.toMatch(/\son[a-z]+\s*=/i);
      expect(htmlText).not.toMatch(/\sstyle\s*=/i);
      // No third-party resources.
      expect(htmlText).not.toMatch(/(src|href)="https?:\/\//);
    }
  });

  it("uses a fresh nonce per response", async () => {
    const a = cspNonce((await call("/")).headers.get("content-security-policy") ?? "");
    const b = cspNonce((await call("/")).headers.get("content-security-policy") ?? "");
    expect(a).not.toBe(b);
  });

  it("locks down JSON responses too", async () => {
    const { token } = await createAccount();
    const res = await call("/v1/me", { headers: bearer(token) });
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    const nf = await call("/v1/nope");
    expect(nf.status).toBe(404);
    expect(((await nf.json()) as { error: string }).error).toBe("not_found");
  });
});

describe("pages", () => {
  it("renders the home, docs and privacy pages in Turkish", async () => {
    const home = await (await call("/")).text();
    expect(home).toContain('lang="tr"');
    expect(home).toContain("Web erişimi");
    const docs = await (await call("/docs")).text();
    expect(docs).toContain("X-OpenBand-Signature");
    expect(docs).toContain("createHmac");
    expect(docs).toContain("hmac.new");
    expect(docs).toContain("curl");
    const privacy = await (await call("/privacy")).text();
    for (const s of ["Cloudflare", "DELETE /v1/account", "Web erişimi", "SHA-256"]) expect(privacy).toContain(s);
  });

  it("renders the panel with the dial and escapes user data", async () => {
    const { token } = await createAccount({ tz: "Europe/Istanbul" });
    const evil = `<script>alert(1)</script>"'&`;
    await ingest(token, syncBody([live("2026-10-13T10:00:00Z", 4200, 77)], { name: evil }));
    const cookie = await login(token);
    const page = await (await call("/app?date=2026-10-13", { headers: { Cookie: cookie } })).text();
    expect(page).toContain('<svg class="dial"');
    expect(page).toContain('class="bar h13"'); // 10:00Z = 13:00 Istanbul
    expect(page).toContain('class="hr"');
    expect(page).toContain("Salı, 13 Ekim");
    expect(page).toContain("4 200");
    expect(page).not.toContain(evil);
    expect(page).toContain("&lt;script&gt;alert(1)&lt;/script&gt;&quot;&#39;&amp;");
    // One band: no switcher.
    expect(page).not.toContain('class="devices"');
  });

  it("shows a device switcher when the account has more than one band", async () => {
    const { token } = await createAccount();
    await ingest(token, syncBody([live("2026-10-13T10:00:00Z", 1)]));
    await ingest(token, syncBody([live("2026-10-13T10:00:00Z", 2)], { id: DEV_B, name: "Band 10 4F21", model: "band10" }));
    const cookie = await login(token);
    const page = await (await call(`/app?device=${DEV_B}&date=2026-10-13`, { headers: { Cookie: cookie } })).text();
    expect(page).toContain('class="devices"');
    expect(page).toMatch(new RegExp(`href="/app\\?device=${DEV_B}&amp;date=2026-10-13" aria-current="true"`));
    expect(page).toContain("Band 10 4F21");
  });

  it("shows an empty state when there is no data", async () => {
    const { token } = await createAccount();
    const cookie = await login(token);
    const page = await (await call("/app", { headers: { Cookie: cookie } })).text();
    expect(page).toContain('<svg class="dial"');
    expect(page).toContain("Henüz veri gelmedi.");
    expect(page).not.toContain('class="bar');
  });

  it("keeps the login token out of server requests", async () => {
    const page = await (await call("/login")).text();
    expect(page).toContain("location.hash");
    expect(page).toContain("history.replaceState");
    expect(page).toContain('fetch("/v1/session"');
  });
});
