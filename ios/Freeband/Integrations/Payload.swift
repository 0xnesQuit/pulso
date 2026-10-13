import CryptoKit
import Foundation

/// JSON bodies from docs/API.md (schema freeband.v1), shared by webhooks, the hub and export.
enum Payload {
    static let iso: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        f.timeZone = TimeZone(identifier: "UTC")
        return f
    }()

    static var appVersion: String {
        let info = Bundle.main.infoDictionary
        return "\(info?["CFBundleShortVersionString"] as? String ?? "?") (\(info?["CFBundleVersion"] as? String ?? "?"))"
    }

    struct Device {
        let id: UUID
        let name: String
        let model: String

        init(_ band: Band) {
            id = band.id
            name = band.name
            model = band.model
        }

        init(id: UUID, name: String, model: String) {
            self.id = id
            self.name = name
            self.model = model
        }
    }

    static func sample(_ d: SampleDraft) -> [String: Any] {
        var out: [String: Any] = ["type": d.kind, "ts": iso.string(from: d.ts)]
        switch d.kind {
        case "battery":
            out["level"] = d.level
        default:
            out["steps"] = d.steps
            out["calories"] = d.calories
            out["heart_rate"] = d.heartRate
            out["standing_hours"] = d.standingHours
        }
        return out
    }

    static func body(event: String, device: Device, samples: [SampleDraft], now: Date = Date()) -> Data {
        let calendar = Calendar.current
        let today = samples.filter { $0.kind == "live" && calendar.isDate($0.ts, inSameDayAs: now) }
        let latest = today.max { $0.ts < $1.ts }
        let lastHeart = today.filter { $0.heartRate > 10 }.max { $0.ts < $1.ts }
        let battery = samples.filter { $0.kind == "battery" }.max { $0.ts < $1.ts }

        let day = DateFormatter()
        day.calendar = Calendar(identifier: .gregorian)
        day.locale = Locale(identifier: "en_US_POSIX")
        day.dateFormat = "yyyy-MM-dd"

        var summary: [String: Any] = ["date": day.string(from: now)]
        if let latest {
            summary["steps"] = latest.steps
            summary["calories"] = latest.calories
        }
        if let lastHeart { summary["heart_rate_last"] = lastHeart.heartRate }
        if let battery { summary["battery"] = battery.level }

        let body: [String: Any] = [
            "schema": "freeband.v1",
            "event": event,
            "device": ["id": device.id.uuidString, "name": device.name, "model": device.model,
                       "app_version": appVersion, "tz": TimeZone.current.identifier],
            "sent_at": iso.string(from: now),
            "summary": summary,
            "samples": samples.sorted { $0.ts < $1.ts }.map(sample),
        ]
        return (try? JSONSerialization.data(withJSONObject: body, options: [.sortedKeys])) ?? Data()
    }
}

/// Delivers signed webhook requests (header names from docs/API.md).
enum WebhookSender {
    static func newSecret() -> String {
        var bytes = [UInt8](repeating: 0, count: 24)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        return "whsec_" + bytes.map { String(format: "%02x", $0) }.joined()
    }

    static func signature(_ body: Data, secret: String) -> String {
        let mac = HMAC<SHA256>.authenticationCode(for: body, using: SymmetricKey(data: Data(secret.utf8)))
        return "sha256=" + mac.map { String(format: "%02x", $0) }.joined()
    }

    /// Returns a short status for the settings screen, e.g. "200" or the error.
    static func deliver(_ body: Data, event: String, to url: URL, secret: String) async -> String {
        var request = URLRequest(url: url, timeoutInterval: 10)
        request.httpMethod = "POST"
        request.httpBody = body
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(event, forHTTPHeaderField: "X-Freeband-Event")
        request.setValue(UUID().uuidString, forHTTPHeaderField: "X-Freeband-Delivery")
        request.setValue(signature(body, secret: secret), forHTTPHeaderField: "X-Freeband-Signature")
        do {
            let (_, response) = try await URLSession.shared.data(for: request)
            return "\((response as? HTTPURLResponse)?.statusCode ?? 0)"
        } catch {
            return error.localizedDescription
        }
    }
}

/// Client for the Freeband hub (docs/API.md). The token lives in the Keychain.
struct HubClient {
    static let defaultURL = URL(string: "https://freeband.cobanov.dev")!

    var baseURL: URL
    var token: String?

    enum Failure: LocalizedError {
        case status(Int, String)
        case malformed

        var errorDescription: String? {
            switch self {
            case .status(401, _): return "Sunucu API anahtarını tanımadı. Web erişimini kapatıp yeniden aç."
            case .status(403, _): return "Davet kodu geçersiz. Kodu sunucu yöneticisinden iste."
            case .status(429, _): return "Sunucu çok fazla istek aldı. Biraz sonra tekrar dene."
            case .status(let code, let text): return "Sunucu \(code) döndü: \(text.prefix(120))"
            case .malformed: return "Sunucunun cevabı anlaşılamadı."
            }
        }
    }

    func createAccount(deviceName: String, invite: String) async throws -> (token: String, webURL: URL?) {
        let body = try JSONSerialization.data(withJSONObject: ["device_name": deviceName, "tz": TimeZone.current.identifier,
                                                               "invite": invite.trimmingCharacters(in: .whitespacesAndNewlines)])
        let json = try await call("POST", "/v1/accounts", body: body, auth: false)
        guard let token = json["token"] as? String else { throw Failure.malformed }
        return (token, (json["web_url"] as? String).flatMap(URL.init(string:)))
    }

    func ingest(_ body: Data) async throws -> (accepted: Int, duplicates: Int) {
        let json = try await call("POST", "/v1/ingest", body: body)
        return (json["accepted"] as? Int ?? 0, json["duplicates"] as? Int ?? 0)
    }

    func rotate() async throws -> String {
        let json = try await call("POST", "/v1/token/rotate")
        guard let token = json["token"] as? String else { throw Failure.malformed }
        return token
    }

    func deleteAccount() async throws {
        _ = try await call("DELETE", "/v1/account")
    }

    /// Sign-in link for the web panel; the token stays in the URL fragment.
    func panelURL() -> URL? {
        guard let token else { return nil }
        return URL(string: baseURL.absoluteString + "/login#token=" + token)
    }

    private func call(_ method: String, _ path: String, body: Data? = nil, auth: Bool = true) async throws -> [String: Any] {
        var request = URLRequest(url: baseURL.appendingPathComponent(path), timeoutInterval: 20)
        request.httpMethod = method
        request.httpBody = body
        if body != nil { request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        if auth, let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        let (data, response) = try await URLSession.shared.data(for: request)
        let code = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(code) else {
            throw Failure.status(code, String(decoding: data, as: UTF8.self))
        }
        if data.isEmpty { return [:] }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
    }
}

/// CSV and JSON exports of everything stored on the phone.
enum Exporter {
    static func write(csv samples: [Sample], bands: [Band]) throws -> URL {
        let names = Dictionary(uniqueKeysWithValues: bands.map { ($0.id, $0.name) })
        var lines = ["device_id,device_name,type,ts,steps,calories,heart_rate,standing_hours,battery"]
        for s in samples.sorted(by: { $0.ts < $1.ts }) {
            let name = (names[s.bandID] ?? "").replacingOccurrences(of: "\"", with: "\"\"")
            lines.append([s.bandID.uuidString, "\"\(name)\"", s.kind, Payload.iso.string(from: s.ts),
                          "\(s.steps)", "\(s.calories)", "\(s.heartRate)", "\(s.standingHours)", "\(s.level)"]
                .joined(separator: ","))
        }
        return try save(Data(lines.joined(separator: "\n").utf8), ext: "csv")
    }

    static func write(json samples: [Sample], bands: [Band]) throws -> URL {
        let body: [String: Any] = [
            "schema": "freeband.v1",
            "exported_at": Payload.iso.string(from: Date()),
            "devices": bands.map { ["id": $0.id.uuidString, "name": $0.name, "model": $0.model] },
            "samples": samples.sorted { $0.ts < $1.ts }.map { s -> [String: Any] in
                var row = Payload.sample(SampleDraft(sample: s))
                row["device_id"] = s.bandID.uuidString
                return row
            },
        ]
        return try save(try JSONSerialization.data(withJSONObject: body, options: [.prettyPrinted, .sortedKeys]), ext: "json")
    }

    private static func save(_ data: Data, ext: String) throws -> URL {
        let day = Date().formatted(.iso8601.year().month().day())
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("freeband-\(day).\(ext)")
        try data.write(to: url, options: .completeFileProtection)
        return url
    }
}

extension SampleDraft {
    init(sample s: Sample) {
        self.init(kind: s.kind, ts: s.ts, steps: s.steps, calories: s.calories, heartRate: s.heartRate,
                  standingHours: s.standingHours, level: s.level)
    }
}
