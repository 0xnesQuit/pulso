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
    /// An invite opened from a QR code or the hub's /join page, waiting for the user to confirm.
    @Published var pendingInvite: Invite?

    struct Invite: Identifiable, Equatable {
        let code: String
        let hub: URL
        var id: String { code + hub.absoluteString }
        var isDefaultHub: Bool { hub.host == HubClient.defaultURL.host }
    }

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
        link.onIdentified = { [weak self] id, keyIndex, name in self?.identified(id, keyIndex, name) }
        mergeDuplicateBands()
    }

    // MARK: band sessions

    func target(for band: Band) -> BandTarget? {
        let keys = Vault.bandKeys(band.id)
        guard !keys.isEmpty else { return nil }
        return BandTarget(id: band.id, name: band.name, mac: band.mac, macSuffix: band.macSuffix,
                          keys: keys.map { BandKey(hex: $0).data })
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

    /// The working key moves to the front; the band's Bluetooth name ("Xiaomi Smart Band 10 Pro
    /// D9B9") settles its name and model.
    private func identified(_ id: UUID, _ keyIndex: Int, _ name: String?) {
        var keys = Vault.bandKeys(id)
        if keyIndex > 0, keyIndex < keys.count {
            keys.insert(keys.remove(at: keyIndex), at: 0)
            Vault.setBandKeys(keys, for: id)
        }
        if let name, name.localizedCaseInsensitiveContains("band"), let band = band(id), band.name != name {
            band.name = name
            band.model = Band.modelCode(for: name)
            try? context.save()
        }
    }

    /// One band per MAC: folds bands added twice (Mi Fitness keeps several entries per band)
    /// into the oldest one, moving their samples and keys.
    func mergeDuplicateBands() {
        let bands = ((try? context.fetch(FetchDescriptor<Band>())) ?? []).sorted { $0.addedAt < $1.addedAt }
        var keeper: [String: Band] = [:]
        var changed = false
        for band in bands {
            guard let suffix = band.macSuffix else { continue }
            guard let first = keeper[suffix] else {
                keeper[suffix] = band
                continue
            }
            let from = band.id
            let samples = (try? context.fetch(FetchDescriptor<Sample>(predicate: #Predicate { $0.bandID == from }))) ?? []
            samples.forEach { $0.bandID = first.id }
            Vault.setBandKeys(Vault.bandKeys(first.id) + Vault.bandKeys(from), for: first.id)
            Vault.removeBandKey(from)
            if band.name.localizedCaseInsensitiveContains("pro"), !first.name.localizedCaseInsensitiveContains("pro") {
                first.name = band.name
                first.model = band.model
            }
            first.lastSyncAt = [first.lastSyncAt, band.lastSyncAt].compactMap { $0 }.max()
            if first.lastBattery == nil { first.lastBattery = band.lastBattery }
            if UserDefaults.standard.string(forKey: "selectedBand") == from.uuidString {
                UserDefaults.standard.set(first.id.uuidString, forKey: "selectedBand")
            }
            context.delete(band)
            changed = true
        }
        if changed { try? context.save() }
    }

    func band(_ id: UUID) -> Band? {
        try? context.fetch(FetchDescriptor<Band>(predicate: #Predicate { $0.id == id })).first
    }

    // MARK: keys

    /// Adds one band per MAC for the chosen keys, or adds the keys to a band already added.
    /// Keys that worked before stay first; new ones are tried after them.
    @discardableResult
    func add(keys: [BandKey]) -> [Band] {
        var bands = (try? context.fetch(FetchDescriptor<Band>())) ?? []
        var result: [Band] = []
        for group in BandKey.groupedByBand(keys) {
            let lead = group[0]
            let match = bands.first { band in
                if let a = band.macSuffix, let b = lead.macSuffix { return a == b }
                return band.name == lead.name.trimmingCharacters(in: .whitespaces)
            }
            let band = match ?? Band(name: BandKey.bestName(group), mac: lead.mac)
            if match == nil {
                context.insert(band)
                bands.append(band)
            } else if BandKey.bestName(group).localizedCaseInsensitiveContains("pro"), !band.name.localizedCaseInsensitiveContains("pro") {
                band.name = BandKey.bestName(group)
                band.model = Band.modelCode(for: band.name)
            }
            Vault.setBandKeys(Vault.bandKeys(band.id) + group.map(\.hex), for: band.id)
            if !result.contains(where: { $0.id == band.id }) { result.append(band) }
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

    // MARK: invites

    /// `openband://join?invite=OB-XXXX-XXXX&hub=https://…`; only https hubs are accepted.
    func handle(_ url: URL) {
        guard url.scheme == "openband", url.host == "join",
              let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems else { return }
        let code = (items.first { $0.name == "invite" }?.value ?? "").trimmingCharacters(in: .whitespaces)
        guard !code.isEmpty, code.count <= 64 else { return }
        let hub = items.first { $0.name == "hub" }?.value
            .flatMap(URL.init(string:))
            .flatMap { $0.scheme == "https" && $0.host != nil ? $0 : nil } ?? HubClient.defaultURL
        pendingInvite = Invite(code: code, hub: hub)
    }

    func accept(_ invite: Invite) async {
        hubURL = invite.hub
        await enableWebAccess(invite: invite.code)
    }

    // MARK: hub (web access)

    func enableWebAccess(invite: String) async {
        hubBusy = true
        defer { hubBusy = false }
        let name = ((try? context.fetch(FetchDescriptor<Band>())) ?? []).first?.name ?? "OpenBand"
        do {
            let account = try await HubClient(baseURL: hubURL).createAccount(deviceName: name, invite: invite)
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

    /// Sends every sample not yet on the hub, one request per band, up to 4000 at a time.
    func pushToHub() async {
        guard Vault.hubToken != nil else { return }
        let bands = (try? context.fetch(FetchDescriptor<Band>())) ?? []
        var sent = 0
        for band in bands {
            let id = band.id
            var descriptor = FetchDescriptor<Sample>(predicate: #Predicate { $0.bandID == id && !$0.pushedToHub },
                                                     sortBy: [SortDescriptor(\.ts)])
            descriptor.fetchLimit = 4000  // 5000 compact live samples exceed the hub's 512 KB body cap
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
