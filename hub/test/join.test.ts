import { describe, expect, it } from "vitest";
import { call } from "./helpers";

describe("/join", () => {
  it("explains the steps and builds the app link from the fragment only", async () => {
    const res = await call("/join");
    expect(res.status).toBe(200);
    const page = await res.text();
    for (const s of ["OpenBand'e katıl", "Mi Fitness", "openband://join?invite=", "join-code"]) expect(page).toContain(s);
    // Without a TestFlight link configured, it asks the inviter for one.
    expect(page).toContain("TestFlight bağlantısını iste");
  });
});
