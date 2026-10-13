# Freeband v3 — Tesla-language design system (working spec)

Source: design planning agent, 2026-10-14. Decisions taken by the integrator: **4 tabs Today · Sleep · Trends · Band**; Settings under Band. The Turkish summary lives in `docs/PLAN.md` §8. `docs/DESIGN.md` will be rewritten (Turkish) from this when the redesign lands.

Verified: WCAG contrasts and CIEDE2000 of the tokens below; Open Sauce `tnum` + Turkish coverage.

## 1. Principles
1. **One focal object per screen.** Home: the score triad. Band: the band. Detail: one large arc. Everything else recedes.
2. **The band is the car; the day is the drive.** Band status is one grey line ("Parked · 82%" → "Band 10 Pro · 82% · Synced 2 min ago"); device control lives in a Tesla-vehicle-style Band tab.
3. **Context only when true.** Live HR, charging, finding, Bluetooth off each appear as one ContextCard only while active (Tesla's charging card).
4. **Two weights, no capitals.** 400/500 only; sentence case everywhere (also avoids Turkish İ/ı casing bugs).
5. **Blue means "press to commit".** Action blue only on primary buttons and on-state toggles; never in data.
6. **Colour is earned.** Lists, sparklines, deltas monochrome; colour only in score arcs and deep-dive charts, always paired with a word, position or gap — never colour alone.
7. **Verdict first, numbers second.** Home leads with one word for the day: Ready / Steady / Rest; each arc has its band word.

## 2. Tokens

### Colour
| Token | Dark | Light | Notes |
|---|---|---|---|
| canvas | #0E0F12 | #FFFFFF | |
| surface | #171A20 | #F4F4F4 | cards, quick-action circles, segment track |
| raised | #22252C | #FFFFFF | sheets, selected segment, pressed row |
| hairline | #2C2F36 | #EEEEEE | decorative only |
| hairlineStrong | #393C41 | #D0D1D2 | arc/slider tracks, gridline baseline |
| textPrimary | #F4F4F4 | #171A20 | 15.8:1 on surface |
| textBody | #D0D1D2 | #393C41 | |
| textSecondary | #A2A4A9 | #5C5E62 | 7.0 / 5.9:1 on surface; axes, captions |
| textTertiary | #6E7178 | #8E8E8E | placeholder/disabled only (fails 4.5 intentionally) |
| action / actionPressed | #3E6AE1 / #3457B1 | same | white label 4.82 / 6.68:1; never a text colour |

Increase Contrast: textSecondary → #C4C6CA / #45474B; hairline → #3A3E46 / #C9CACC.

Data colours (all ≥3:1 vs canvas and surface in each theme):
| Role | Dark | Light | Rationale |
|---|---|---|---|
| good | #3CCB7F | #1A9A5C | WHOOP band semantics; shared by Sleep + Recovery bands |
| fair | #F2B33D | #A87000 | |
| low | #E5483B | #A8261B | darkest of the three → separable by lightness for CVD |
| sleep | #A98FFF | #7A4AD6 | violet = night; pushed purple to stay clear of action blue |
| activity (strain, steps) | #3EC6DE | #08819A | strain is built from movement + HR load; ΔE 31 from good |
| heart | #FF6FB3 | #C8287A | pushed magenta so heart charts are ΔE ≥24 from low, never read as "bad" |

Hypnogram: deep #7B5CFF / #4B2AA8; light = sleep; REM #D4C8FF / #9B78E8; awake = textSecondary.
HR zones Z1→Z5 (ramp surface→heart): dark #683853 #8B446A #AE5180 #D56099 #FF6FB3; light #E7B7CF #E098BD #DA7AAB #D15192 #C8287A. Low zones <3:1 → 2pt gaps + labelled legend.
Bands: Recovery 67–100 good / 34–66 fair / 0–33 low. Sleep 80–100 / 60–79 / 0–59. Strain: no good/bad colour, words only: Light 0–9.9, Moderate 10–13.9, High 14–17.9, All out 18–21.
Known: in light mode sleep vs action blue weak for deuteranopes — accepted because no data mark is ever blue.

### Type (Open Sauce Sans, `Font.custom(_:size:relativeTo:)`, tracking 0, line height via `.lineSpacing`, figures `.monospacedDigit()`)
| Token | Size/line | Weight | relativeTo | Use |
|---|---|---|---|---|
| figureXL | 56/56 | 500 | .largeTitle | detail arc, live HR |
| figureL | 40/44 | 500 | .largeTitle | sleep duration, battery |
| title | 28/34 | 500 | .title | screen titles, day verdict |
| figureM | 28/32 | 500 | .title2 | Home arcs, alarm times |
| headline | 17/22 | 500 | .headline | section and sheet titles, band name |
| body | 16/23 | 400 | .body | paragraphs, row titles |
| button | 15/20 | 500 | .body | buttons, segments |
| figureS | 16/20 | 500 | .body | row values |
| subhead | 14/20 | 400 | .subheadline | status line, footers |
| caption | 12/16 | 400 | .caption | axes, units, quick-action labels |

600 not used in design; SemiBold only for Bold Text (`legibilityWeight` → 400→500, 500→600). Delete the Light font. Nav bars use Open Sauce 500 via `UINavigationBar.appearance()` + `UIFontMetrics`.

### Spacing / radius / elevation / motion
Spacing 4, 8, 16, 24, 32, 48; screen gutter 16; card padding 16; 32 between sections.
Radius: 0 charts/bars/dividers; 4 buttons, fields, segments, day chips; 12 cards, list cards, context cards, sheet top corners; full circles only for quick actions, close button, status dots. No pills.
Elevation: none — separation by surface tone; only translucency is system chrome (tab/nav bars, Liquid Glass on iOS 26); Reduce Transparency → solid canvas.
Motion: `Animation.timingCurve(0.5, 0, 0, 0.75, duration: 0.33)`; every state change colour-only (no scale, springs, pulsing). Exceptions: arcs trim to value over 0.66s on first appearance; numbers `.contentTransition(.numericText())`. Reduce Motion: arcs drawn, numbers `.identity`.

## 3. Components (`ios/Freeband/UI/Design/Components/`, each with a preview grid light/dark × default/AX3 × empty/loading)
| Component | Spec | SwiftUI |
|---|---|---|
| ScoreArc | 270° arc, gap at bottom; 3pt (Home) / 4pt (detail), butt ends; 1pt hairlineStrong track with 2pt notches at band thresholds; number inside, label in gap; arc = band colour (Strain: activity); no data "–" | `ArcShape` (start 135°, sweep 270°) + `.trim`; `StrokeStyle(lineCap: .butt)`; `@ScaledMetric(relativeTo: .title2) var d = 104`; `.accessibilityElement(children: .ignore)` value "54 of 100, Fair"; wrapped in NavigationLink |
| MetricRow | label, sparkline 56×20, value+unit, delta, chevron; ≥52pt | sparkline `Path` in textSecondary, last point dot, a11y hidden; delta `arrow.up.right` / `arrow.down.right` / `minus` neutral; AX sizes stack and drop sparkline; combined label "Steps, 6,412, up 8% on your 7-day average" |
| ContributorRow | name + value line; below 4pt bar (textPrimary fill) + 2×12pt baseline tick + note "3 above usual"; bar low colour only when flagged, always with the word | `Canvas` 12pt frame; a11y value includes baseline |
| Hypnogram | 4 rows 12pt, no rounding; x-axis only bed and wake; stage table below doubles as legend + data table | `RectangleMark(xStart:xEnd:y:)` + `chartForegroundStyleScale` + `accessibilityChartDescriptor` (Audio Graphs) |
| ZoneBar | 8pt bar with 2pt gaps + legend rows "Zone 3 · 128–145 bpm · 24 min" | `Canvas`; each legend row its own a11y element |
| TrendChart | title with unit ("Resting heart rate, bpm"); 7/30/90; lines for scores/RHR/SpO2/stress, bars for steps/sleep hours/strain; dashed average; band hairlines on score charts; 90d = weekly means | `.chartXSelection(value:)` — selected point replaces the header value (no floating tooltip); y trailing 3 ticks; `accessibilityChartDescriptor` |
| StatusLine | "Band 10 Pro · 82% · Synced 2 min ago" subhead textSecondary; leading 8pt glyph: filled dot nearby, ring out of range, spinner busy, exclamation (low) alert | port state mapping from `UI/ConnectionStatus.swift`; `TimelineView(.periodic(by: 30))`; band name truncates first |
| QuickActionButton | 56pt surface circle, 22pt `.light` SF Symbol; caption below ≤2 lines, 76pt column; on-state inverts (textPrimary fill, canvas icon), not blue | `ButtonStyle`; toggles `.accessibilityValue("On")` |
| ListCard / ListRow | card r12; row 52pt: optional 20pt icon, body title, trailing value, chevron.right; hairline inset to text | custom stack + `NavigationLink(value:)`; system-control settings pages use themed `Form` (`scrollContentBackground(.hidden)`, `listRowBackground(surface)`, headers `.textCase(nil)`) |
| SegmentedPicker | surface track r4, 36pt visual in 44pt hit; selected = raised + textPrimary; colour-only | `.accessibilityRepresentation { Picker(...).pickerStyle(.segmented) }`; `ViewThatFits` → `Menu` at large sizes |
| SnapSlider | 2pt track, tick per stop, 24pt thumb, caption under each stop | `.sensoryFeedback(.selection)`, `.accessibilityAdjustableAction` |
| Sheets | Action (medium), Live (medium), Form (large); headline title left, 30pt close (44 hit) right; primary pinned in `safeAreaInset(.bottom)` | `.presentationCornerRadius(12)`, `.presentationBackground(raised)`, visible drag indicator |
| EmptyState | left-aligned in card: 24pt thin icon, headline, body, ≤1 secondary button | |
| ContextCard | 56pt card r12: coloured glyph, figureS value, status text, trailing text button; variants live/charging/finding/alert; fades in (opacity) | tap on live → Live sheet |
| Buttons | Primary: blue, 44pt, r4, white 15/500. Secondary: surface fill. Tertiary: text. Destructive: tertiary in low colour + confirmation dialog. Never buttons on cards | |

Band hero: Home's hero is the triad + verdict (not the band). Band tab gets **BandRender**: flat vector (no gradients; SVG/PDF "Preserve Vector Data"), Band 10 and 10 Pro variants (Pro has a lighter metal frame) × light/dark; SwiftUI overlay on the band's screen area shows live state (time, battery %, charging bolt, live HR or "Not worn"); `.accessibilityIgnoresInvertColors()`. Same silhouette as a custom SF Symbol for the Band tab icon.

Delete: `UI/DayDial.swift` (DayDial, OpeningDial, Bayer/Bresenham, `Array[safe:]`), `UI/Theme.swift` (Theme incl. mono/figure/headline-Light/phosphor/pulse/locale, MonoLabel, HairlineGrid, OutlineButtonStyle). Move `Color(hex:)` to Tokens. Rewrite Primary/Quiet buttons (Quiet → Tertiary).

## 4. Screens — tabs Today · Sleep · Trends · Band (Settings in Band)

```
HOME (Today) — dark, default text
┌──────────────────────────────────────────┐
│ Ready                                    │ title = day verdict (Ready/Steady/Rest)
│ Tuesday, 14 October                      │
│ ▯ Band 10 Pro · 82% · Synced 2 min ago › │ StatusLine → Band
│   ╭─────╮       ╭─────╮       ╭─────╮    │
│  │  82   │     │  54   │     │ 11.2  │   │ ScoreArc ×3 (104pt)
│   ╰─   ─╯       ╰─   ─╯       ╰─   ─╯    │
│   Sleep         Recovery      Strain     │
│   Good          Fair          Moderate   │
│ ┌──────────────────────────────────────┐ │ ContextCard — only while live
│ │ ♥ 72 bpm       Live · 1:34 left Stop │ │
│ └──────────────────────────────────────┘ │
│    (⟳)       (♡)       (◎)       (⏰)    │
│    Sync    Live HR    Find     Alarms    │
│ Today                                    │
│ ┌──────────────────────────────────────┐ │
│ │ Steps          ╱╲╱   6,412   ↗ 8%   ›│ │
│ │ Resting HR     ╲_╱   56 bpm  ↘ 2    ›│ │
│ │ Sleep          ─╱─   7h 12m  → 0    ›│ │
│ │ Active minutes ╱─╲   42 min  ↗ 12   ›│ │
│ │ Blood oxygen   ───   96%     → 0    ›│ │
│ └──────────────────────────────────────┘ │
│ Compared with your 7-day average.        │
├──────────────────────────────────────────┤
│  ◔ Today   ☾ Sleep   ∿ Trends   ▯ Band   │
└──────────────────────────────────────────┘
```
XXL/AX: triad → three rows (64pt arc left, name + verdict right); quick actions 2×2; MetricRows stack; StatusLine wraps.

```
SCORE DETAIL (template ×3)               SLEEP (night)
┌────────────────────────────────┐       ┌────────────────────────────────┐
│ ‹ Today                        │       │ Sleep                    ‹  ›  │
│ Recovery                       │       │ Monday night, 13 October       │
│          ╭───────╮             │       │ 7h 12m                figureL  │
│        │    54    │  figureXL  │       │ 23:48 – 07:04 · 94% efficient  │
│        │   Fair   │            │       │ ┌ Sleep score 82 · Good    › ┐ │
│          ╰─     ─╯             │       │ ┌────────────────────────────┐ │
│ Lower than usual: resting heart│       │ │Awake ▌    ▌       ▌      ▌ │ │
│ rate is up and sleep was short.│       │ │REM      ▄▄▄  ▄▄▄▄   ▄▄▄▄   │ │
│ Contributors                   │       │ │Light ▄▄▄  ▄▄▄  ▄▄▄    ▄▄▄  │ │
│ ┌────────────────────────────┐ │       │ │Deep   ▄▄▄▄ ▄▄              │ │
│ │Resting heart rate   58 bpm │ │       │ │23:48              07:04    │ │
│ │━━━━━━━━━━━━━━│━━━   3 above │ │       │ └────────────────────────────┘ │
│ │Sleep score              72 │ │       │ ■ Awake  0h 24m  ▍       6%    │
│ │Sleeping heart rate  61 bpm │ │       │ ■ REM    1h 32m  ▍▍▍▍   21%    │
│ │Overnight SpO₂          96% │ │       │ ■ Light  3h 50m  ▍▍▍▍▍▍ 53%    │
│ │Overnight stress         22 │ │       │ ■ Deep   1h 26m  ▍▍▍    20%    │
│ │Previous-day strain    14.1 │ │       │ Heart rate, bpm  min 48 avg 55 │
│ └────────────────────────────┘ │       │ ┌ heart line ────────────────┐ │
│ Recovery     [7d | 30d | 90d]  │       │ Blood oxygen, %  avg 96 min 91 │
│ ┌ line + 67/34 hairlines, avg ┐│       │ ┌ line ──────────────────────┐ │
│ ┌ How Recovery works       › ┐ │       │ ┌ Sleep schedule 23:30–07:00 › │
└────────────────────────────────┘       └────────────────────────────────┘
```
Sleep contributors: duration, efficiency, deep, REM, awakenings, timing. Strain: zone bar first, then active minutes, steps, peak HR, workouts. Sleep-score detail adds a compact hypnogram + "Open night ›".

```
TRENDS                                   BAND (vehicle page)
┌────────────────────────────────┐       ┌────────────────────────────────┐
│ Trends                         │       │                  Band 10 Pro ⌄ │ switcher if >1
│ [ 7 days | 30 days | 90 days ] │       │           ┌──────┐             │
│ Recovery               avg 61 ›│       │           │10:42 │  BandRender │
│ ┌ line, band hairlines  ↗ 4  ┐ │       │           │ 82%  │  live screen│
│ Sleep, hours          avg 7.1 ›│       │           └──────┘             │
│ ┌ bars ──────────────────────┐ │       │ Band 10 Pro             headline│
│ Strain                avg 10.8›│       │ 82% · Nearby · Synced 2 min ago│
│ Resting heart rate, bpm avg 56›│       │ ┌ ⚡ Charging · full in ~40 min ┐│ contextual
│ Steps                avg 7,912›│       │  (⟳)    (◎)     (✉)     (☾)    │
│ Blood oxygen, %        avg 96 ›│       │  Sync   Find   Notify   DND    │
│ Stress                 avg 28 ›│       │ ┌────────────────────────────┐ │
└────────────────────────────────┘       │ │⏰ Alarms           2 on   › │ │
 Cards 120pt static; tap → full          │ │♡ Health monitoring Smart  › │ │
 TrendChart with scrubbing + day list.   │ │☾ Sleep schedule 23:30–07:00›│ │
                                         │ │◫ Display & Do Not Disturb › │ │
                                         │ │ⓘ About this band  2.1.7   › │ │
                                         │ └────────────────────────────┘ │
                                         │ ┌ ⚙ Freeband settings       › ┐ │
                                         └────────────────────────────────┘
```

```
ALARMS                                   ALARM EDITOR (form sheet, large)
┌────────────────────────────────┐       ┌────────────────────────────────┐
│ ‹ Band        Alarms        ＋ │       │ New alarm                  (✕) │
│ ┌────────────────────────────┐ │       │          06 : 45   wheel       │
│ │06:45                 [●  ] │ │       │ Repeat                         │
│ │Weekdays · Smart wake       │ │       │ [M][T][W][T][F][S][S] 44pt, r4 │
│ │────────────────────────────│ │       │ Smart wake               [●  ] │
│ │08:30                 [  ○] │ │       │ Wakes you in light sleep.      │
│ │Sat, Sun                    │ │       │ Delete alarm          (low red)│
│ └────────────────────────────┘ │       │ [          Save           ]    │ blue, pinned
│ Alarms live on the band and    │       └────────────────────────────────┘
│ vibrate without your phone.    │
│ Up to 10.                      │
└────────────────────────────────┘
```

```
HEALTH MONITORING                        FREEBAND SETTINGS
┌────────────────────────────────┐       ┌────────────────────────────────┐
│ ‹ Band  Health monitoring      │       │ ‹ Band   Freeband settings     │
│ Heart rate                     │       │ ┌ Bands                  2  › ┐ │
│ │Measure every                 │       │ Integrations                   │
│ │[Off|Smart|1 min|10|30]       │       │ │Web access   On · hub host › │
│ │1 min uses the most battery.  │       │ │Webhooks     2 active      › │
│ │High heart rate alert 120 bpm │       │ │Shortcuts & Siri           › │
│ │├──┼──●──┼──┼──┤ Off 100…150  │       │ Data                           │
│ │Low heart rate alert     Off  │       │ │Export CSV · Export JSON      │
│ │●──┼──┼──┤  Off 40 45 50      │       │ │Delete data on this phone     │
│ │Sleep tracking with HR   [●]  │       │ Appearance                     │
│ Blood oxygen: All day [●],     │       │ │[ System | Light | Dark ]     │
│   low alert Off/90/85/80       │       │ │Language   English ›(iOS)    │
│ Stress: All day [●], Relax [ ] │       │ ┌ Diagnostics ›  About ›      ┐ │
│ Move reminder [●] 09:00–21:00  │       └────────────────────────────────┘
│ Profile: birth year, height,   │
│ weight, sex, max heart rate    │
│ [      Send to band      ]     │ appears only when changed (one BLE session)
└────────────────────────────────┘
```
Hide breathing/respiratory rows when the band reports 0. Large text: segments → Menu; slider labels thin to first/middle/last.

```
ONBOARDING (3 steps; progress = 3 hairline segments + "Step 1 of 3" for VoiceOver)
┌──────────────────┐ ┌──────────────────┐ ┌──────────────────┐
│ ━━  ──  ──       │ │ ━━  ━━  ──       │ │ ━━  ━━  ━━       │
│   [band render]  │ │ Get your band's  │ │   [band render]  │
│ Your band,       │ │ key              │ │ Connect          │
│ only yours.      │ │ 1 Tap Choose     │ │ Close Mi Fitness,│
│ No account; data │ │   folder.        │ │ keep band close. │
│ stays on phone.  │ │ 2 Browse › On My │ │ ● Searching…  →  │
│ ⚠ Don't reset or │ │   iPhone › Mi    │ │ ● Connected ·    │
│ unpair the band. │ │   Fitness        │ │   82% · 6,412    │
│ [ Get started ]  │ │ 3 Tap Open.      │ │ [ Connect ]      │
│                  │ │ [Choose folder]  │ │   Skip for now   │
└──────────────────┘ └──────────────────┘ └──────────────────┘

LIVE HR SHEET (medium detent)
┌────────────────────────────────┐
│             ───                │
│ Live heart rate            (✕) │
│ 72                   figureXL  │
│ bpm · Live · 1:34 left         │
│ ┌ heart line, last 2 min ────┐ │
│ Min 64     Avg 70     Max 81   │
│ Steps 6,412 · Calories 412     │
│ [          Stop          ]     │ secondary
│ Close Mi Fitness while live.   │
│ Stops after 2 minutes.         │
└────────────────────────────────┘
```

## 5. App icon
Single open 270° arc (ScoreArc shape, gap at bottom), uniform 72px stroke on 1024, trimmed ~75%, square ends (reads as a gauge, not a power symbol). Default #171A20 on #F4F4F4; dark variant #F4F4F4 on #0E0F12; tinted variant greyscale (iOS 18+). Never red, gradients or dither. Rewrite `ios/tools/render_icon.swift`.

## 6. Hub web panel
Shared tokens: `design/tokens.json` → `scripts/gen_tokens.py` → `Tokens.generated.swift` + `hub/src/views/tokens.ts` (CSS variables); a vitest checks sync. `color-scheme: light dark` + `prefers-color-scheme`. Buttons 40px r4, only primary blue; cards r12 no border; sticky glass nav rgb(255 255 255/.75) / rgb(14 15 18/.75) with backdrop-filter; ScoreArc, hypnogram, trends as server-rendered SVG (`pathLength=100` + dasharray); motion `transition: color, background-color .33s cubic-bezier(.5,0,0,.75)`; honour `prefers-reduced-motion`. Desktop: triad + metrics left, trends right; mobile mirrors app Home. Delete `dial.ts`, pixel `wordmark.ts` (→ "Freeband" set in 500), REVEAL CSS, Light/SemiBold woff2.

## 7. Implementation order & verification
1. Tokens: `Tokens.swift` (dynamic UIColor providers incl. Increase Contrast; `ShapeStyle` statics so `.foregroundStyle(.textSecondary)` works), `Typography.swift` (`.textStyle(_:)` incl. Bold Text mapping), `Motion.swift`, `Buttons.swift`, `TokenGallery` preview. Skills: ios-hig-design, swiftui-expert-skill, dataviz (palette validator).
2. Components, one file each with preview grids. Skills: swiftui-pro, swift-charts (Hypnogram, TrendChart, chartXSelection, AXChartDescriptor), dataviz.
3. Demo data behind `-freeband-demo`; DEBUG `-freeband-screen <name>` to jump to a screen for screenshots.
4. Screens: Band (replaces ToolsSheet + ConnectionStatus) → Home → ScoreDetail → Sleep → Trends → Live sheet → Alarms → Health → Display/DND → Settings → Onboarding. Unbuilt band commands behind flags. Skills: ios-hig-design, frontend-design (anti-templated pass on Home and Band).
5. Localization: `Localizable.xcstrings` + `InfoPlist.xcstrings`, English source + Turkish; `CFBundleDevelopmentRegion: en`, `CFBundleLocalizations: [en, tr]`; remove forced Turkish locale; test with double-length pseudolanguage.
6. Verification: iPhone 6.1" simulator screenshots `appearance light|dark` × `content_size large|extra-extra-large|accessibility-extra-extra-extra-large` × `-AppleLanguages "(tr)"` into `out/design-v3/<screen>-<mode>-<size>-<lang>.png`; `FreebandUITests` target with `performAccessibilityAudit()` per screen; manual VoiceOver/Audio Graphs, Reduce Motion/Transparency, Increase Contrast, Bold Text, Smart Invert, 44pt targets; checklist-design audit (mobile app, data viz, settings, onboarding, empty states) then critique on light/dark shots; fix, then delete legacy.
7. Hub port: frontend-design, dataviz, checklist-design; screenshots 390/1440 light/dark.
8. Finish: render icon; rewrite `docs/DESIGN.md` v3 in Turkish.
