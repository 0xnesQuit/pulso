import Foundation
import SwiftData
import SwiftUI

/// Ties the band session to storage and integrations: every observation is stored as it
/// arrives; when a session ends well, webhooks get the session's samples and, if web access
/// is on, unsent samples go to the hub.
@MainActor
final class AppModel: ObservableObject {
    let link = BandLink()
    let context: ModelContext

    @Published var hubStatus: String?
    @Published var hubBusy = false
    @Published var hubEnabled = Vault.hubToken != nil

    private var sessionDrafts: [SampleDraft] = []

    var hubURL: URL {
        get { UserDefaults.standard.string(forKey: "hubURL").flatMap(URL.init(string:)) ?? HubClient.defaultURL }
        set { UserDefaults.standard.set(newValue.absoluteString, forKey: "hubURL") }
    }

    var hub: HubClient { HubClient(baseURL: hubURL, token: Vault.hubToken) }

    init(context: ModelContext) {
        self.context = context
        link.onSample = { [weak self] id, draft in self?.record(id, draft) }
        link.onFinish = { [weak self] id, ok in self?.sessionEnded(id, ok) }
    }

    // MARK: band sessions

    func target(for band: Band) -> BandTarget? {
        guard let hex = Vault.bandKey(band.id) else { return nil }
        return BandTarget(id: band.id, name: band.name, mac: band.mac, macSuffix: band.macSuffix,
                          key: BandKey(hex: hex).data)
    }

    func start(_ band: Band, _ purpose: BandLink.Purpose) {
        guard let target = target(for: band) else { return }
        sessionDrafts = []
        link.start(target, purpose: purpose)
    }

    func stop() { link.stop() }

    private func record(_ id: UUID, _ draft: SampleDraft) {
        sessionDrafts.append(draft)
        context.insert(Sample(bandID: id, draft: draft))
        if draft.kind == "battery", let band = band(id) { band.lastBattery = draft.level }
        try? context.save()
    }

    private func sessionEnded(_ id: UUID, _ ok: Bool) {
        let drafts = sessionDrafts
        sessionDrafts = []
        guard ok, let band = band(id), !drafts.isEmpty else { return }
        band.lastSyncAt = Date()
        try? context.save()
        let device = Payload.Device(band)
        Task {
            await deliverWebhooks(device: device, drafts: drafts)
            await pushToHub()
        }
    }

    func band(_ id: UUID) -> Band? {
        try? context.fetch(FetchDescriptor<Band>(predicate: #Predicate { $0.id == id })).first
    }

    // MARK: keys

    /// Adds bands for the chosen keys, or refreshes the key of a band already added.
    @discardableResult
    func add(keys: [BandKey]) -> [Band] {
        let existing = (try? context.fetch(FetchDescriptor<Band>())) ?? []
        var result: [Band] = []
        for key in keys {
            let match = existing.first { band in
                if let a = band.macSuffix, let b = key.macSuffix { return a == b }
                return band.name == key.name.trimmingCharacters(in: .whitespaces)
            }
            let band = match ?? Band(name: key.name, mac: key.mac)
            if match == nil { context.insert(band) }
            Vault.setBandKey(key.hex, for: band.id)
            result.append(band)
        }
        try? context.save()
        return result
    }

    func remove(_ band: Band) {
        let id = band.id
        Vault.removeBandKey(id)
        try? context.delete(model: Sample.self, where: #Predicate { $0.bandID == id })
        context.delete(band)
        try? context.save()
    }

    func deleteAllSamples() {
        try? context.delete(model: Sample.self)
        try? context.save()
    }

    // MARK: webhooks

    private func deliverWebhooks(device: Payload.Device, drafts: [SampleDraft]) async {
        let hooks = ((try? context.fetch(FetchDescriptor<Webhook>())) ?? []).filter(\.enabled)
        guard !hooks.isEmpty else { return }
        let body = Payload.body(event: "sync.completed", device: device, samples: drafts)
        for hook in hooks {
            guard let url = URL(string: hook.url) else { continue }
            hook.lastStatus = await WebhookSender.deliver(body, event: "sync.completed", to: url, secret: hook.secret)
            hook.lastAt = Date()
        }
        try? context.save()
    }

    func ping(_ hook: Webhook) async {
        guard let url = URL(string: hook.url) else { return }
        let bands = (try? context.fetch(FetchDescriptor<Band>())) ?? []
        let device = bands.first.map { Payload.Device($0) } ?? Payload.Device(id: UUID(), name: "OpenBand", model: "band10")
        let body = Payload.body(event: "ping", device: device, samples: [])
        hook.lastStatus = await WebhookSender.deliver(body, event: "ping", to: url, secret: hook.secret)
        hook.lastAt = Date()
        try? context.save()
    }

    // MARK: hub (web access)

    func enableWebAccess() async {
        hubBusy = true
        defer { hubBusy = false }
        let name = ((try? context.fetch(FetchDescriptor<Band>())) ?? []).first?.name ?? "OpenBand"
        do {
            let account = try await HubClient(baseURL: hubURL).createAccount(deviceName: name)
            Vault.hubToken = account.token
            hubEnabled = true
            hubStatus = "Web erişimi açık."
            await pushToHub()
        } catch {
            hubStatus = error.localizedDescription
        }
    }

    func disableWebAccess() async {
        hubBusy = true
        defer { hubBusy = false }
        do {
            try await hub.deleteAccount()
        } catch HubClient.Failure.status(401, _) {
            // already gone on the server
        } catch {
            hubStatus = error.localizedDescription
            return
        }
        Vault.hubToken = nil
        hubEnabled = false
        let all = (try? context.fetch(FetchDescriptor<Sample>())) ?? []
        all.forEach { $0.pushedToHub = false }
        try? context.save()
        hubStatus = "Web erişimi kapatıldı, sunucudaki verin silindi."
    }

    func rotateToken() async {
        hubBusy = true
        defer { hubBusy = false }
        do {
            Vault.hubToken = try await hub.rotate()
            hubStatus = "Yeni API anahtarı oluşturuldu; eskisi artık çalışmıyor."
        } catch {
            hubStatus = error.localizedDescription
        }
    }

    /// Sends every sample not yet on the hub, one request per band, up to 5000 at a time.
    func pushToHub() async {
        guard Vault.hubToken != nil else { return }
        let bands = (try? context.fetch(FetchDescriptor<Band>())) ?? []
        var sent = 0
        for band in bands {
            let id = band.id
            var descriptor = FetchDescriptor<Sample>(predicate: #Predicate { $0.bandID == id && !$0.pushedToHub },
                                                     sortBy: [SortDescriptor(\.ts)])
            descriptor.fetchLimit = 5000
            guard let pending = try? context.fetch(descriptor), !pending.isEmpty else { continue }
            let body = Payload.body(event: "sync.completed", device: Payload.Device(band),
                                    samples: pending.map(SampleDraft.init(sample:)))
            do {
                _ = try await hub.ingest(body)
                pending.forEach { $0.pushedToHub = true }
                sent += pending.count
            } catch {
                hubStatus = error.localizedDescription
                return
            }
        }
        try? context.save()
        if sent > 0 { hubStatus = "\(sent) kayıt sunucuya gönderildi." }
    }
}
