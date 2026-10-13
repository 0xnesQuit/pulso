// App ↔ hub contract: fixtures/app-health-*.json are bodies built by the iOS app's own Payload
// code from its demo data (ios/tests/contract). If the app's record builders drift from
// docs/API.md, the hub's validator rejects them here instead of on a user's phone.

import { describe, expect, it } from "vitest";
import { validateIngest } from "../src/lib/validate";
import body0 from "./fixtures/app-health-0.json";

// The clock the fixture was generated with (ios/tests/contract/main.swift).
const NOW = Date.parse("2026-10-14T09:30:00Z");

describe("app health bodies", () => {
  it("pass the hub validator unchanged", () => {
    const v = validateIngest(body0, NOW);
    expect(v.ignored).toBe(0);
    const types = new Set(v.body.samples.map((s: { type: string }) => s.type));
    expect([...types].sort()).toEqual(["minute", "score", "sleep"]);
    expect(v.count).toBe(body0.samples.length);
  });
});
