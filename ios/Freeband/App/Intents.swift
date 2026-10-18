import AppIntents
import SwiftData

// Siri and Shortcuts: the same actions as the Band tab. They open the app because
// CoreBluetooth needs it running (there is no background Bluetooth mode yet).

extension AppModel {
    @MainActor
    func selectedBand() -> Band? {
        let bands = ((try? context.fetch(FetchDescriptor<Band>())) ?? []).sorted { $0.addedAt < $1.addedAt }
        let chosen = UserDefaults.standard.string(forKey: "selectedBand")
        return bands.first { $0.id.uuidString == chosen } ?? bands.first
    }
}

struct FindBandIntent: AppIntent {
    static var title: LocalizedStringResource = "Find band"
    static var description = IntentDescription("Makes the band vibrate. Tap the band to stop it.")
    static var openAppWhenRun = true

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        guard let model = AppModel.shared, let band = model.selectedBand() else {
            return .result(dialog: "There's no band in Pulso yet.")
        }
        model.findBand(band, start: true)
        return .result(dialog: "\(band.shortName) is vibrating.")
    }
}

struct SendToBandIntent: AppIntent {
    static var title: LocalizedStringResource = "Send a notification to the band"
    static var description = IntentDescription("Shows a notification from Pulso on the band.")
    static var openAppWhenRun = true

    @Parameter(title: "Message")
    var message: String

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        guard let model = AppModel.shared, let band = model.selectedBand() else {
            return .result(dialog: "There's no band in Pulso yet.")
        }
        model.notify(band, title: "Pulso", body: message)
        return .result(dialog: "Sending the notification to your band.")
    }
}

struct SyncBandIntent: AppIntent {
    static var title: LocalizedStringResource = "Sync band"
    static var description = IntentDescription("Reads today's data and the band's records.")
    static var openAppWhenRun = true

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        guard let model = AppModel.shared, let band = model.selectedBand() else {
            return .result(dialog: "There's no band in Pulso yet.")
        }
        model.start(band, .sync)
        return .result(dialog: "Syncing.")
    }
}

struct ShowClaudeUsageIntent: AppIntent {
    static var title: LocalizedStringResource = "Show Claude usage on the band"
    static var description = IntentDescription("Reads the latest Claude limits from the PC script and shows them in the Claude app on the band.")
    static var openAppWhenRun = true

    @Parameter(title: "Open the app on the band", default: true)
    var launch: Bool

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        guard let model = AppModel.shared, let band = model.selectedBand() else {
            return .result(dialog: "There's no band in Pulso yet.")
        }
        if let problem = await model.sendClaudeUsage(to: band, launch: launch) {
            return .result(dialog: "\(problem)")
        }
        return .result(dialog: "Sending Claude usage to your band.")
    }
}

struct FreebandShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(intent: FindBandIntent(),
                    phrases: ["Find my band with \(.applicationName)", "\(.applicationName) find my band"],
                    shortTitle: "Find band", systemImageName: "dot.radiowaves.left.and.right")
        AppShortcut(intent: SendToBandIntent(),
                    phrases: ["Send a message to my band with \(.applicationName)"],
                    shortTitle: "Send to band", systemImageName: "text.bubble")
        AppShortcut(intent: SyncBandIntent(),
                    phrases: ["Sync my band with \(.applicationName)"],
                    shortTitle: "Sync band", systemImageName: "arrow.triangle.2.circlepath")
        AppShortcut(intent: ShowClaudeUsageIntent(),
                    phrases: ["Show Claude usage on my band with \(.applicationName)"],
                    shortTitle: "Claude on band", systemImageName: "sparkle")
    }
}
