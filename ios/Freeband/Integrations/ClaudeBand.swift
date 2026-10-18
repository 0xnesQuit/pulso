import Foundation

/// Claude usage on the band: a PC script (band-app/pc/claude_usage.py) writes the numbers to a
/// secret GitHub gist as `claude.json`; Pulso reads it and hands it to the "Claude" quick app on
/// the band (band-app/) over the interconnect channel. The JSON goes through unchanged.
enum ClaudeBand {
    static let package = "app.pulsoband.claude"
    static let fileName = "claude.json"

    static var gistID: String {
        get { UserDefaults.standard.string(forKey: "claudeGistID") ?? "" }
        set { UserDefaults.standard.set(newValue.trimmingCharacters(in: .whitespacesAndNewlines), forKey: "claudeGistID") }
    }

    enum Problem: Error {
        case noGist
        case notFound
        case badContent
    }

    private struct Gist: Decodable {
        struct File: Decodable {
            let content: String?
            let truncated: Bool?
            let raw_url: URL?
        }
        let files: [String: File]
    }

    /// The latest `claude.json` from the gist, checked to be JSON.
    static func fetch(session: URLSession = .shared) async throws -> Data {
        let id = gistID
        guard !id.isEmpty, let url = URL(string: "https://api.github.com/gists/\(id)") else { throw Problem.noGist }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 15)
        request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        let (data, response) = try await session.data(for: request)
        guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw Problem.notFound }
        guard let file = try JSONDecoder().decode(Gist.self, from: data).files[fileName] else { throw Problem.badContent }
        var content = file.content.map { Data($0.utf8) }
        if file.truncated == true, let raw = file.raw_url {
            content = try await session.data(from: raw).0
        }
        guard let content, (try? JSONSerialization.jsonObject(with: content)) is [String: Any] else { throw Problem.badContent }
        return content
    }

    static func message(for problem: Error) -> String {
        switch problem {
        case Problem.noGist: return String(localized: "Add the gist ID from the PC script first.")
        case Problem.notFound: return String(localized: "Couldn't read the gist. Check the ID and the connection.")
        case Problem.badContent: return String(localized: "The gist has no usage data yet. Run the PC script once.")
        default: return problem.localizedDescription
        }
    }
}

extension AppModel {
    /// Reads the latest usage and sends it to the Claude app on the band. `launch` opens the app
    /// on the band first. Returns a message for the UI when it couldn't start.
    @MainActor
    func sendClaudeUsage(to band: Band, launch: Bool) async -> String? {
        do {
            let content = try await ClaudeBand.fetch()
            start(band, .quickApp(package: ClaudeBand.package, content: content, launch: launch))
            return nil
        } catch {
            return ClaudeBand.message(for: error)
        }
    }
}
