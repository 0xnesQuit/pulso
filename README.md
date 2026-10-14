# Freeband

Read your Xiaomi Smart Band 10 / 10 Pro on iPhone without Mi Fitness or a Xiaomi account. Freeband talks to the band directly over Bluetooth LE, and your data stays on your phone.

<p>
  <img src="docs/img/today.png" width="200" alt="Today: sleep, recovery and strain scores">
  <img src="docs/img/score-recovery.png" width="200" alt="Recovery detail with contributors">
  <img src="docs/img/sleep.png" width="200" alt="Sleep: stages and hypnogram">
  <img src="docs/img/band.png" width="200" alt="Band: battery, sync and quick actions">
</p>

<sub>Screenshots use demo data.</sub>

**Status:** early. Version 0.5 is in internal TestFlight testing and not on the App Store. Website: [freeband.cobanov.dev](https://freeband.cobanov.dev), including the story of how the protocol was worked out: [Nasıl yaptık](https://freeband.cobanov.dev/story), in Turkish.

## What works

| Feature | State |
|---|---|
| Authentication and the encrypted channel (BLE V2) | verified on a Band 10 Pro |
| Battery, live steps, heart rate and calories | verified |
| Notifications from Freeband, find band (vibrate), clock sync | verified |
| Listing and fetching the band's activity files | verified |
| Parsing them: per-minute data, daily summary, sleep and sleep stages, manual readings | implemented and tested against fixtures; not yet checked with real files from a Band 10 |
| Sleep, Recovery and Strain scores with contributors and confidence | implemented (algorithm v1) |
| English and Turkish, light and dark themes | done |
| Optional web hub: REST API, web panel, webhooks, CSV/JSON export | live at freeband.cobanov.dev |
| Alarms, health monitoring settings, Do Not Disturb, weather, watch faces | not built yet |
| Replacing Mi Fitness entirely (background connection, file acknowledgement) | not built yet |

## How it works

1. iOS keeps the band connected, so the app picks it up again without pairing: service `FE95` with characteristics `005E` (notify) and `005F` (write).
2. The 16-byte auth key is created by Xiaomi's server when the band is first paired in Mi Fitness. On iPhone it sits in the Mi Fitness folder in the Files app. Freeband asks you to pick that folder, reads the key on the phone and keeps it in the Keychain.
3. Handshake:
   - The phone and band swap nonces.
   - HKDF-SHA256 (`"miwear-auth"`) turns the key and nonces into session keys.
   - The band's HMAC proves the key.
   - The phone introduces itself as `device_type = iOS`, encrypted with AES-CCM.
4. After that, commands are protobuf messages in `a5 a5` frames with CRC16, encrypted with AES-128-CTR.
5. History comes as activity files, each with a 7-byte file ID. Files arrive in chunks ending with a CRC32. Freeband never acknowledges them, so nothing is deleted from the band.

The full write-up, with source references:
- [`docs/STORY.md`](docs/STORY.md): the story, step by step.
- [`findings.md`](findings.md): protocol findings.
- [`docs/CAPABILITIES.md`](docs/CAPABILITIES.md): command map.
- [`docs/ACTIVITY.md`](docs/ACTIVITY.md): activity file formats.
- [`docs/PLAN.md`](docs/PLAN.md): product plan and score formulas.

The docs are in Turkish.

## Repository

| Path | What |
|---|---|
| `ios/` | the SwiftUI app (iOS 17+). Generate the project with [XcodeGen](https://github.com/yonaskolb/XcodeGen) (`cd ios && xcodegen generate`). |
| `ios/tests/` | standalone test harnesses: protocol vectors, key reader, activity parsers, analytics, ingest, and an app↔hub contract test |
| `hub/` | the optional Cloudflare Worker + D1 hub (Hono, vitest) |
| `design/`, `scripts/` | design tokens shared by the app and the hub, plus their generator |
| `docs/` | findings, plan, design spec, story |

Running the tests:

```sh
# activity parsers (Swift) and the Python reference
cd ios/tests/activity/swift && swiftc ../../../Freeband/Band/ActivityFiles.swift main.swift -o /tmp/act && /tmp/act
cd ios/tests/activity && python3 activity_ref.py --selftest

# analytics
cd ios/tests/analytics && swiftc ../../Freeband/Analytics/*.swift main.swift -o /tmp/an && /tmp/an

# hub
cd hub && npm install && npx tsc --noEmit && npx vitest run
```

## Using it with your band

- **Never unpair the band in Mi Fitness and never factory-reset it.** Either one changes the key, and you would need Mi Fitness again to get the new one.
- Pairing a brand-new band without Mi Fitness isn't possible yet: the key comes from Xiaomi's server.
- Mi Fitness and Freeband can't hold the band's channel at the same time. Close Mi Fitness while Freeband syncs.
- Mi Fitness acknowledges activity files, and the band then deletes them. To keep your history for Freeband, turn off Mi Fitness's background refresh or offload the app. Offloading keeps its folder, and the key with it.

## Credits

Freeband was built from the protocol knowledge in these projects:
- [Gadgetbridge](https://codeberg.org/Freeyourgadget/Gadgetbridge)
- [AstroBox](https://github.com/AstralSightStudios)
- [xiaomi-band-ios-export](https://github.com/artyomxx/xiaomi-band-ios-export)
- [blueband-map](https://github.com/LordierClaw/blueband-map)
- [band9-rust-ios](https://github.com/ireescc277-dotcom/band9-rust-ios)

The Swift code was written from our own documentation of the protocol, not translated from these projects.

## License

- **Code:** MIT, see [LICENSE](LICENSE).
- **Fixtures:** the `ios/tests/activity/fixtures/gb_*.json` test vectors come from Gadgetbridge's tests and stay under AGPL-3.0-or-later ([details](ios/tests/activity/fixtures/README.md)).
- **Font:** Open Sauce Sans is under the SIL Open Font License.

Freeband is an independent project and is not affiliated with Xiaomi. Xiaomi, Mi Band and Mi Fitness are trademarks of Xiaomi Inc.
