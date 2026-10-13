import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { ORIGIN, bearer, call, createAccount, env, hmacHex, ingest, json, live, syncBody } from "./helpers";
import { signature } from "../src/lib/webhooks";

type FetchSpy = MockInstance<typeof fetch>;
let fetchSpy: FetchSpy;

interface Captured {
  url: string;
  headers: Headers;
  body: Uint8Array;
  init: RequestInit;
}

function captured(spy: FetchSpy): Captured[] {
  return spy.mock.calls.map(([input, init]) => {
    const i = (init ?? {}) as RequestInit;
    const b = i.body;
    const body = b instanceof Uint8Array ? b : new TextEncoder().encode(String(b));
    return { url: String(input), headers: new Headers(i.headers), body, init: i };
  });
}

async function addHook(token: string, url: string) {
  const res = await call("/v1/webhooks", json({ url }, bearer(token)));
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string; url: string; secret: string; created_at: string };
}

beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("ok", { status: 200 }));
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("webhook signing", () => {
  it("matches a known HMAC-SHA256 test vector", async () => {
    const body = new TextEncoder().encode("The quick brown fox jumps over the lazy dog");
    expect(await signature("key", body)).toBe("sha256=f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8");
  });
});

describe("webhook CRUD", () => {
  it("returns the secret once and stores it encrypted", async () => {
    const { token, account_id } = await createAccount();
    const hook = await addHook(token, "https://hooks.example.org/freeband");
    expect(hook.secret).toMatch(/^fbwh_[A-Za-z0-9_-]{43}$/);
    expect(hook.url).toBe("https://hooks.example.org/freeband");

    const list = await (await call("/v1/webhooks", { headers: bearer(token) })).text();
    expect(list).not.toContain(hook.secret);
    expect(list).not.toContain("secret");
    const one = (await (await call(`/v1/webhooks/${hook.id}`, { headers: bearer(token) })).json()) as Record<string, unknown>;
    expect(one).toMatchObject({ id: hook.id, url: hook.url, last_status: null });
    expect(one).not.toHaveProperty("secret");

    const row = await env.DB.prepare("SELECT secret_enc FROM webhooks WHERE id = ? AND account_id = ?")
      .bind(hook.id, account_id)
      .first<{ secret_enc: string }>();
    expect(row?.secret_enc.startsWith("v1.")).toBe(true);
    expect(row?.secret_enc).not.toContain(hook.secret);
    expect(row?.secret_enc).not.toContain(hook.secret.slice(5));
  });

  it("only accepts public https URLs and never the hub itself", async () => {
    const { token } = await createAccount();
    const bad = [
      "http://hooks.example.org/x",
      "ftp://hooks.example.org/x",
      "https://freeband.cobanov.dev/v1/ingest",
      "https://FREEBAND.cobanov.dev./x",
      "https://sub.freeband.cobanov.dev/x",
      "https://127.0.0.1/x",
      "https://2130706433/x",
      "https://[::1]/x",
      "https://localhost/x",
      "https://printer.local/x",
      "https://intranet/x",
      "https://user:pw@hooks.example.org/x",
      "https://hooks.example.org:8443/x",
      "not a url",
      "",
      "https://" + "a".repeat(2050) + ".com",
    ];
    for (const url of bad) {
      const res = await call("/v1/webhooks", json({ url }, bearer(token)));
      expect(res.status, url).toBe(400);
    }
    const res = await call("/v1/webhooks", json({ url: 42 }, bearer(token)));
    expect(res.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("allows at most 5 webhooks per account and no duplicates", async () => {
    const { token } = await createAccount();
    for (let i = 0; i < 5; i++) await addHook(token, `https://hooks.example.org/${i}`);
    const sixth = await call("/v1/webhooks", json({ url: "https://hooks.example.org/6" }, bearer(token)));
    expect(sixth.status).toBe(409);
    expect(((await sixth.json()) as { error: string }).error).toBe("webhook_limit");
    const dup = await call("/v1/webhooks", json({ url: "https://hooks.example.org/0" }, bearer(token)));
    expect(dup.status).toBe(409);
  });

  it("deletes a webhook and stops delivering to it", async () => {
    const { token } = await createAccount();
    const hook = await addHook(token, "https://hooks.example.org/gone");
    expect((await call(`/v1/webhooks/${hook.id}`, { method: "DELETE", headers: bearer(token) })).status).toBe(200);
    expect((await call(`/v1/webhooks/${hook.id}`, { headers: bearer(token) })).status).toBe(404);
    await ingest(token, syncBody([live("2026-10-13T10:00:00Z", 1)]));
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("webhook delivery", () => {
  it("forwards each ingest with the contract headers and a correct signature", async () => {
    const { token } = await createAccount();
    const hook = await addHook(token, "https://hooks.example.org/sync");
    const body = syncBody([live("2026-10-13T20:59:41Z", 8421, 74), { type: "battery", ts: "2026-10-13T20:59:40Z", level: 46 }]);
    expect(await (await ingest(token, body)).json()).toEqual({ accepted: 2, duplicates: 0 });

    const calls = captured(fetchSpy);
    expect(calls).toHaveLength(1);
    const c = calls[0] as Captured;
    expect(c.url).toBe("https://hooks.example.org/sync");
    expect(c.init.method).toBe("POST");
    expect(c.init.redirect).toBe("manual");
    expect(c.init.signal).toBeInstanceOf(AbortSignal);
    expect(c.headers.get("content-type")).toBe("application/json");
    expect(c.headers.get("x-freeband-event")).toBe("sync.completed");
    expect(c.headers.get("x-freeband-delivery")).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

    // Verify the HMAC independently over the exact bytes that were sent.
    const expected = "sha256=" + (await hmacHex(hook.secret, c.body));
    expect(c.headers.get("x-freeband-signature")).toBe(expected);
    // A different secret does not verify.
    expect(c.headers.get("x-freeband-signature")).not.toBe("sha256=" + (await hmacHex(hook.secret + "x", c.body)));

    const sent = JSON.parse(new TextDecoder().decode(c.body)) as Record<string, unknown>;
    expect(sent).toEqual(body);

    const status = (await (await call(`/v1/webhooks/${hook.id}`, { headers: bearer(token) })).json()) as { last_status: number };
    expect(status.last_status).toBe(200);
  });

  it("signs separately for each webhook and uses a fresh delivery id", async () => {
    const { token } = await createAccount();
    const h1 = await addHook(token, "https://one.example.org/a");
    const h2 = await addHook(token, "https://two.example.org/b");
    await ingest(token, syncBody([live("2026-10-13T10:00:00Z", 1)]));
    const calls = captured(fetchSpy);
    expect(calls).toHaveLength(2);
    const byUrl = new Map(calls.map((c) => [c.url, c]));
    for (const h of [h1, h2]) {
      const c = byUrl.get(h.url) as Captured;
      expect(c.headers.get("x-freeband-signature")).toBe("sha256=" + (await hmacHex(h.secret, c.body)));
    }
    expect(calls[0]?.headers.get("x-freeband-delivery")).not.toBe(calls[1]?.headers.get("x-freeband-delivery"));
  });

  it("does not forward an ingest that only had duplicates", async () => {
    const { token } = await createAccount();
    await addHook(token, "https://hooks.example.org/dupe");
    const body = syncBody([live("2026-10-13T10:00:00Z", 1)]);
    await ingest(token, body);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    await ingest(token, body);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("does not let a failing webhook fail the ingest", async () => {
    fetchSpy.mockImplementation(async () => {
      throw new TypeError("network down");
    });
    const { token } = await createAccount();
    const hook = await addHook(token, "https://hooks.example.org/down");
    const res = await ingest(token, syncBody([live("2026-10-13T10:00:00Z", 1)]));
    expect(res.status).toBe(200);
    const status = (await (await call(`/v1/webhooks/${hook.id}`, { headers: bearer(token) })).json()) as {
      last_status: number;
      last_error: string;
    };
    expect(status.last_status).toBe(0);
    expect(status.last_error).toBe("Bağlantı kurulamadı");
  });

  it("sends a signed ping from /test and reports the result", async () => {
    const { token } = await createAccount();
    const hook = await addHook(token, "https://hooks.example.org/ping");
    const ok = await call(`/v1/webhooks/${hook.id}/test`, { method: "POST", headers: bearer(token) });
    expect(await ok.json()).toEqual({ delivered: true, status: 200, error: null });
    const c = captured(fetchSpy)[0] as Captured;
    expect(c.headers.get("x-freeband-event")).toBe("ping");
    expect(c.headers.get("x-freeband-signature")).toBe("sha256=" + (await hmacHex(hook.secret, c.body)));
    const body = JSON.parse(new TextDecoder().decode(c.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ schema: "freeband.v1", event: "ping", webhook_id: hook.id });

    fetchSpy.mockImplementation(async () => new Response("nope", { status: 500 }));
    const fail = await call(`/v1/webhooks/${hook.id}/test`, { method: "POST", headers: bearer(token) });
    expect(await fail.json()).toEqual({ delivered: false, status: 500, error: "HTTP 500" });

    fetchSpy.mockImplementation(async () => new Response(null, { status: 302, headers: { Location: "https://elsewhere.example/" } }));
    const redirect = (await (await call(`/v1/webhooks/${hook.id}/test`, { method: "POST", headers: bearer(token) })).json()) as {
      delivered: boolean;
    };
    expect(redirect.delivered).toBe(false);
  });

  it("gives up after 5 seconds", async () => {
    fetchSpy.mockImplementation(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = (init as RequestInit).signal as AbortSignal;
          signal.addEventListener("abort", () => reject(signal.reason));
        }),
    );
    const { token } = await createAccount();
    const hook = await addHook(token, "https://hooks.example.org/slow");
    const started = Date.now();
    const res = await call(`/v1/webhooks/${hook.id}/test`, { method: "POST", headers: bearer(token) });
    const elapsed = Date.now() - started;
    expect(await res.json()).toEqual({ delivered: false, status: 0, error: "Zaman aşımı (5 sn)" });
    expect(elapsed).toBeGreaterThanOrEqual(4900);
    expect(elapsed).toBeLessThan(8000);
  });

  it("requires the same origin for cookie-authenticated webhook changes", async () => {
    const { token } = await createAccount();
    const cookie = (await call("/v1/session", json({ token }, { Origin: ORIGIN }))).headers.get("set-cookie")?.split(";")[0] ?? "";
    const res = await call("/v1/webhooks", json({ url: "https://hooks.example.org/x" }, { Cookie: cookie, Origin: "https://evil.example" }));
    expect(res.status).toBe(403);
  });
});
