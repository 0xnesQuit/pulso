// design/tokens.json is the single source; src/views/tokens.ts is generated from it by
// scripts/gen_tokens.py. These tests fail when someone edits one without regenerating.
import { describe, expect, it } from "vitest";
import source from "../../design/tokens.json";
import { BANDS, COLOR_VARS, REDUCED_MOTION_VARS, STATIC_VARS, TOKEN_CSS, TOKENS_VERSION } from "../src/views/tokens";

type RawColor = { light?: string; dark?: string; lightContrast?: string; darkContrast?: string; ref?: string };
type Resolved = { light: string; dark: string; lightContrast: string; darkContrast: string };
type Vars = Readonly<Record<string, string>>;

const tokens = source as unknown as {
  version: number;
  color: Record<string, RawColor>;
  space: Record<string, number>;
  radius: Record<string, number>;
  stroke: Record<string, number>;
  size: Record<string, number>;
  font: { family: string; fallback: string };
  type: Record<string, { size: number; lineHeight: number; weight: number; figure: boolean }>;
  motion: Record<string, { curve: number[]; duration: number }>;
  bands: Record<string, Record<string, number>>;
};

// Same rules as kebab() in scripts/gen_tokens.py.
const kebab = (name: string): string =>
  name.replace(/(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])|(?<=[A-Za-z])(?=[0-9])/g, "-").toLowerCase();

function resolve(name: string, seen: string[] = []): Resolved {
  const entry = tokens.color[name];
  if (!entry) throw new Error(`unknown colour ${name}`);
  if (seen.includes(name)) throw new Error(`alias cycle at ${name}`);
  if (entry.ref) return resolve(entry.ref, [...seen, name]);
  const light = entry.light!.toUpperCase();
  const dark = entry.dark!.toUpperCase();
  return {
    light,
    dark,
    lightContrast: (entry.lightContrast ?? light).toUpperCase(),
    darkContrast: (entry.darkContrast ?? dark).toUpperCase(),
  };
}

const colors = Object.fromEntries(Object.keys(tokens.color).map((name) => [name, resolve(name)]));

function expectedColorVars(): Record<string, Record<string, string>> {
  const changed = Object.keys(colors).filter((n) => {
    const c = colors[n]!;
    return c.lightContrast !== c.light || c.darkContrast !== c.dark;
  });
  const pick = (names: string[], key: keyof Resolved) =>
    Object.fromEntries(names.map((n) => [`--${kebab(n)}`, colors[n]![key]]));
  const all = Object.keys(colors);
  return {
    light: pick(all, "light"),
    dark: pick(all, "dark"),
    lightContrast: pick(changed, "lightContrast"),
    darkContrast: pick(changed, "darkContrast"),
  };
}

function expectedStaticVars(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const group of ["space", "radius", "stroke", "size"] as const) {
    for (const [name, value] of Object.entries(tokens[group])) out[`--${group}-${kebab(name)}`] = `${value}px`;
  }
  out["--font-sans"] = `"${tokens.font.family}", ${tokens.font.fallback}`;
  for (const [name, s] of Object.entries(tokens.type)) {
    out[`--type-${kebab(name)}`] = `${s.weight} ${s.size}px/${s.lineHeight}px var(--font-sans)`;
    out[`--type-${kebab(name)}-numeric`] = s.figure ? "tabular-nums" : "normal";
  }
  for (const [name, m] of Object.entries(tokens.motion)) {
    out[`--ease-${kebab(name)}`] = `cubic-bezier(${m.curve.join(",")})`;
    out[`--duration-${kebab(name)}`] = `${Math.round(m.duration * 1000)}ms`;
  }
  return out;
}

const block = (selector: string, decls: Vars): string =>
  `${selector}{${Object.entries(decls)
    .map(([k, v]) => `${k}:${v}`)
    .join(";")}}`;

describe("hub tokens match design/tokens.json", () => {
  it("carries the same version", () => {
    expect(TOKENS_VERSION).toBe(tokens.version);
  });

  it("has every colour for light, dark and both contrast blocks", () => {
    expect(COLOR_VARS).toEqual(expectedColorVars());
    for (const value of Object.values(COLOR_VARS.light)) expect(value).toMatch(/^#[0-9A-F]{6}$/);
  });

  it("has spacing, radius, stroke, size, type and motion variables", () => {
    expect(STATIC_VARS).toEqual(expectedStaticVars());
  });

  it("drops only the arc reveal under reduced motion", () => {
    const expected = Object.fromEntries(
      Object.keys(tokens.motion)
        .filter((n) => n !== "standard")
        .map((n) => [`--duration-${kebab(n)}`, "0ms"]),
    );
    expect(REDUCED_MOTION_VARS).toEqual(expected);
  });

  it("exports the score bands", () => {
    expect(BANDS).toEqual(tokens.bands);
  });

  it("serialises the variables into TOKEN_CSS in cascade order", () => {
    const css = [
      block(":root", { "color-scheme": "light dark", ...COLOR_VARS.light, ...STATIC_VARS }),
      `@media (prefers-color-scheme:dark){${block(":root", COLOR_VARS.dark)}}`,
      `@media (prefers-contrast:more){${block(":root", COLOR_VARS.lightContrast)}}`,
      `@media (prefers-color-scheme:dark) and (prefers-contrast:more){${block(":root", COLOR_VARS.darkContrast)}}`,
      `@media (prefers-reduced-motion:reduce){${block(":root", REDUCED_MOTION_VARS)}}`,
    ].join("\n");
    expect(TOKEN_CSS).toBe(css);
  });

  it("keeps the dark contrast block a superset of the light one", () => {
    expect(Object.keys(COLOR_VARS.darkContrast)).toEqual(Object.keys(COLOR_VARS.lightContrast));
  });
});
