import AppIntents
import SwiftData

// Siri and Shortcuts: the same actions as the Tools sheet. They open the app because
// CoreBluetooth needs it running (there is no background Bluetooth mode yet).

private extension AppModel {
    @MainActor
    func selectedBand() -> Band? {
        let bands = ((try? context.fetch(FetchDescriptor<Band>())) ?? []).sorted { $0.addedAt < $1.addedAt }
        let chosen = UserDefaults.standard.string(forKey: "selectedBand")
        return bands.first { $0.id.uuidString == chosen } ?? bands.first
    }
}

struct FindBandIntent: AppIntent {
    static var title: LocalizedStringResource = "Bandı bul"
    static var description = IntentDescription("Bandı titreştirir; bantta dokununca susar.")
    static var openAppWhenRun = true

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        guard let model = AppModel.shared, let band = model.selectedBand() else {
            return .result(dialog: "Freeband'de henüz bant yok.")
        }
        model.findBand(band, start: true)
        return .result(dialog: "\(band.shortName) titreşiyor.")
    }
}

struct SendToBandIntent: AppIntent {
    static var title: LocalizedStringResource = "Banda bildirim gönder"
    static var description = IntentDescription("Banda Freeband'den bir bildirim gönderir.")
    static var openAppWhenRun = true

    @Parameter(title: "Mesaj")
    var message: String

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        guard let model = AppModel.shared, let band = model.selectedBand() else {
            return .result(dialog: "Freeband'de henüz bant yok.")
        }
        model.notify(band, title: "Freeband", body: message)
        return .result(dialog: "Bildirim banda gidiyor.")
    }
}

struct SyncBandIntent: AppIntent {
    static var title: LocalizedStringResource = "Bandı senkronize et"
    static var description = IntentDescription("Bandın bugünkü verisini ve kayıtlarını okur.")
    static var openAppWhenRun = true

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        guard let model = AppModel.shared, let band = model.selectedBand() else {
            return .result(dialog: "Freeband'de henüz bant yok.")
        }
        model.start(band, .sync)
        return .result(dialog: "Senkronize ediliyor.")
    }
}

struct FreebandShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(intent: FindBandIntent(),
                    phrases: ["\(.applicationName) ile bandımı bul", "Bandımı bul \(.applicationName)"],
                    shortTitle: "Bandı bul", systemImageName: "dot.radiowaves.left.and.right")
        AppShortcut(intent: SendToBandIntent(),
                    phrases: ["\(.applicationName) ile banda mesaj gönder"],
                    shortTitle: "Banda gönder", systemImageName: "text.bubble")
        AppShortcut(intent: SyncBandIntent(),
                    phrases: ["\(.applicationName) senkronize et"],
                    shortTitle: "Senkronize et", systemImageName: "arrow.triangle.2.circlepath")
    }
}
