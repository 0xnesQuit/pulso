import { describe, expect, it } from "vitest";
import { DEV_B, bearer, call, createAccount, ingest, live, login, syncBody } from "./helpers";

function cspNonce(csp: string): string {
  const m = /script-src 'nonce-([A-Za-z0-9_-]+)'/.exec(csp);
  expect(m).not.toBeNull();
  return m?.[1] ?? "";
}

describe("security headers", () => {
  it("sends a nonce-based CSP and hardening headers on HTML", async () => {
    for (const path of ["/", "/story", "/login", "/join", "/docs", "/privacy", "/does-not-exist"]) {
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
      // No third-party resources (outbound links such as GitHub are fine).
      expect(htmlText).not.toMatch(/\ssrc="https?:\/\//);
      expect(htmlText).not.toMatch(/<link\b[^>]*href="https?:\/\//);
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
    const res = await call("/");
    expect(res.status).toBe(200);
    const home = await res.text();
    expect(home).toContain('lang="tr"');
    expect(home).toContain("Web erişimi");
    expect(home).toContain('<meta name="color-scheme" content="light dark">');
    // The product first: screens, an honest caption and the two actions.
    for (const img of ["today", "score-recovery", "sleep", "band"]) expect(home).toContain(`src="/img/${img}.webp"`);
    expect(home).toContain("Ekranlar demo veriyle");
    expect(home).toMatch(/<a class="btn" href="\/story">Nasıl yaptık<\/a>/);
    expect(home).toMatch(/<a class="btn ghost" href="https:\/\/github.com\/cobanov\/freeband">GitHub<\/a>/);
    for (const s of ["Mi Fitness'sız, hesapsız", "Uyku", "Toparlanma", "Yük", "İsteğe bağlı web erişimi", "TestFlight", "App Store"]) {
      expect(home).toContain(s);
    }
    // No TestFlight link, no old dial, no pixel wordmark.
    expect(home).not.toContain("testflight.apple.com");
    expect(home).not.toContain('class="dial"');
    expect(home).not.toContain('class="wordmark"');
    // Open Graph and the trademark line.
    expect(home).toContain('<meta property="og:image" content="https://freeband.cobanov.dev/img/og-home.png">');
    expect(home).toContain('<meta name="twitter:card" content="summary_large_image">');
    expect(home).toContain("Xiaomi ile bağlantısı yoktur");
    const docs = await (await call("/docs")).text();
    expect(docs).toContain("X-Freeband-Signature");
    expect(docs).toContain("createHmac");
    expect(docs).toContain("hmac.new");
    expect(docs).toContain("curl");
    const privacy = await (await call("/privacy")).text();
    for (const s of ["Cloudflare", "DELETE /v1/account", "Web erişimi", "SHA-256"]) expect(privacy).toContain(s);
  });

  it("renders the story page as a numbered timeline with diagrams", async () => {
    const res = await call("/story");
    expect(res.status).toBe(200);
    const story = await res.text();
    expect(story).toContain("<title>Xiaomi Smart Band 10&#39;u nasıl çözdük · Freeband</title>");
    expect(story).toMatch(/<meta name="description" content="[^"]+">/);
    expect(story).toContain('<meta property="og:url" content="https://freeband.cobanov.dev/story">');
    expect(story).toContain('<meta property="og:image" content="https://freeband.cobanov.dev/img/og-story.png">');
    expect(story).toContain('<ol class="timeline">');
    expect(story.match(/<span class="step-n" aria-hidden="true">/g)).toHaveLength(14);
    expect(story).toContain(">14</span>");
    // Facts from docs/STORY.md, code terms in chips.
    for (const s of ["%46", "13 test vektörüne", "147 test", "37 bin", "HKDF-SHA256", "AES-128-CTR", "AES-CCM", "Keychain", "Teşekkürler"]) {
      expect(story).toContain(s);
    }
    for (const s of ["FE95", "005E", "005F", "a5 a5", "2/110", "device_type = iOS"]) expect(story).toContain(`<code>${s}</code>`);
    // Two inline SVG diagrams.
    expect(story.match(/<svg viewBox="[^"]+" role="img"/g)).toHaveLength(2);
    // Links to the repo's notes and the projects we learned from.
    for (const href of [
      "https://github.com/cobanov/freeband/blob/main/findings.md",
      "https://github.com/cobanov/freeband/blob/main/docs/CAPABILITIES.md",
      "https://github.com/cobanov/freeband/blob/main/docs/ACTIVITY.md",
      "https://codeberg.org/Freeyourgadget/Gadgetbridge",
      "https://github.com/AstralSightStudios",
      "https://github.com/artyomxx/xiaomi-band-ios-export",
      "https://github.com/LordierClaw/blueband-map",
      "https://github.com/ireescc277-dotcom/band9-rust-ios",
    ]) {
      expect(story).toContain(`href="${href}"`);
    }
  });

  it("has the shared nav on public pages and marks the current one", async () => {
    for (const path of ["/", "/story", "/docs", "/privacy", "/join"]) {
      const page = await (await call(path)).text();
      for (const href of ["/story", "/docs", "https://github.com/cobanov/freeband", "/login"]) {
        expect(page, `${path} → ${href}`).toContain(`class="navlink" href="${href}"`);
      }
      expect(page).toContain('<a class="brand" href="/">Freeband</a>');
      expect(page).toContain('<a href="/privacy">Gizlilik</a>');
    }
    const story = await (await call("/story")).text();
    expect(story).toContain('href="/story" aria-current="page"');
  });

  it("swaps the sign-in link for the panel when signed in", async () => {
    const { token } = await createAccount();
    const cookie = await login(token);
    const home = await (await call("/", { headers: { Cookie: cookie } })).text();
    expect(home).toContain('<a class="navlink" href="/app">Panele git</a>');
    expect(home).not.toContain('href="/login" aria-current');
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
