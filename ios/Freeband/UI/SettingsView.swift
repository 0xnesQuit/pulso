import SwiftData
import SwiftUI
import UIKit

struct SettingsView: View {
    @EnvironmentObject private var model: AppModel
    @Query(sort: \Band.addedAt) private var bands: [Band]
    @Query private var samples: [Sample]
    @State private var addingBand = false
    @State private var exportURL: URL?
    @State private var confirmWipe = false
    @State private var exportError: String?

    var body: some View {
        NavigationStack {
            Form {
                Section("Bantlar") {
                    ForEach(bands) { band in
                        NavigationLink(value: band) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(band.displayName)
                                Text(band.lastSyncAt.map { "Son senkron \($0.formatted(date: .abbreviated, time: .shortened))" } ?? "Henüz senkronize edilmedi")
                                    .font(.footnote)
                                    .foregroundStyle(Theme.secondary)
                            }
                        }
                    }
                    Button("Bant ekle") { addingBand = true }
                }

                Section {
                    Button("CSV olarak dışa aktar") { export { try Exporter.write(csv: samples, bands: bands) } }
                    Button("JSON olarak dışa aktar") { export { try Exporter.write(json: samples, bands: bands) } }
                    Button("Telefondaki verileri sil", role: .destructive) { confirmWipe = true }
                } header: {
                    Text("Verilerin")
                } footer: {
                    Text(exportError ?? "Telefonda \(samples.count.formatted()) kayıt var.")
                }

                Section("Paylaşım") {
                    NavigationLink("Webhook'lar") { WebhooksView() }
                    NavigationLink {
                        WebAccessView()
                    } label: {
                        LabeledContent("Web erişimi", value: model.hubEnabled ? "Açık" : "Kapalı")
                    }
                }

                Section {
                    NavigationLink("Tanılama") { DiagnosticsView() }
                    NavigationLink("Hakkında") { AboutView() }
                }
            }
            .navigationTitle("Ayarlar")
            .navigationDestination(for: Band.self) { BandDetailView(band: $0) }
            .sheet(isPresented: $addingBand) {
                KeyStep(title: "Bant ekle") { _ in addingBand = false }
                    .padding(24)
                    .presentationDetents([.large])
            }
            .sheet(item: $exportURL) { ActivitySheet(items: [$0]) }
            .confirmationDialog("Telefondaki tüm kayıtlar silinsin mi?", isPresented: $confirmWipe, titleVisibility: .visible) {
                Button("Kayıtları sil", role: .destructive) { model.deleteAllSamples() }
            } message: {
                Text("Bantlar ve anahtarları kalır. Sunucudaki veri etkilenmez.")
            }
        }
    }

    private func export(_ make: () throws -> URL) {
        do {
            exportURL = try make()
            exportError = nil
        } catch {
            exportError = "Dışa aktarılamadı: \(error.localizedDescription)"
        }
    }
}

extension URL: Identifiable {
    public var id: String { absoluteString }
}

struct ActivitySheet: UIViewControllerRepresentable {
    let items: [Any]

    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: items, applicationActivities: nil)
    }

    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}

private struct BandDetailView: View {
    let band: Band
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var rereading = false
    @State private var confirmRemove = false

    var body: some View {
        Form {
            Section {
                LabeledContent("Model", value: band.shortName)
                if let suffix = band.macSuffix { LabeledContent("Kimlik", value: suffix) }
                LabeledContent("Anahtar", value: Vault.bandKey(band.id).map { BandKey(hex: $0).masked } ?? "yok")
                if let battery = band.lastBattery { LabeledContent("Pil", value: "%\(battery)") }
                if let at = band.lastSyncAt {
                    LabeledContent("Son senkron", value: at.formatted(date: .abbreviated, time: .shortened))
                }
            }
            Section {
                Button("Anahtarı yeniden oku") { rereading = true }
                Button("Bandı kaldır", role: .destructive) { confirmRemove = true }
            } footer: {
                Text("Kaldırmak bandı yalnızca Freeband'den siler; Mi Fitness'taki eşleşme etkilenmez.")
            }
        }
        .navigationTitle(band.displayName)
        .sheet(isPresented: $rereading) {
            KeyStep(title: "Anahtarı yeniden oku") { _ in rereading = false }
                .padding(24)
        }
        .confirmationDialog("\(band.displayName) kaldırılsın mı?", isPresented: $confirmRemove, titleVisibility: .visible) {
            Button("Bandı kaldır", role: .destructive) {
                model.remove(band)
                dismiss()
            }
        } message: {
            Text("Bu bandın telefondaki kayıtları ve anahtarı silinir.")
        }
    }
}

private struct WebhooksView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.modelContext) private var context
    @Query(sort: \Webhook.createdAt) private var hooks: [Webhook]
    @State private var newURL = ""
    @State private var urlError: String?

    var body: some View {
        Form {
            Section {
                Text("Her senkronizasyondan sonra Freeband o senkronda okunan veriyi bu adreslere JSON olarak gönderir. İstekler imzalıdır; alıcı tarafta gizli anahtarla doğrulayabilirsin.")
                    .font(.callout)
                    .foregroundStyle(Theme.secondary)
            }
            ForEach(hooks) { hook in
                Section {
                    Toggle(isOn: Binding(get: { hook.enabled }, set: { hook.enabled = $0; try? context.save() })) {
                        Text(hook.url).lineLimit(2).font(.callout)
                    }
                    LabeledContent("Gizli anahtar") {
                        Button("Kopyala") { UIPasteboard.general.string = hook.secret }
                    }
                    if let status = hook.lastStatus, let at = hook.lastAt {
                        LabeledContent("Son gönderim", value: "\(status), \(at.formatted(date: .omitted, time: .shortened))")
                    }
                    Button("Deneme gönder") { Task { await model.ping(hook) } }
                    Button("Webhook'u sil", role: .destructive) {
                        context.delete(hook)
                        try? context.save()
                    }
                }
            }
            Section {
                TextField("https://", text: $newURL)
                    .keyboardType(.URL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                Button("Webhook ekle") { add() }
                    .disabled(newURL.isEmpty || hooks.count >= 5)
            } header: {
                Text("Yeni adres")
            } footer: {
                Text(urlError ?? "En fazla 5 adres. Yalnızca https:// kabul edilir. İmza biçimi Web erişimi > API belgesi'nde.")
            }
        }
        .navigationTitle("Webhook'lar")
    }

    private func add() {
        let trimmed = newURL.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: trimmed), url.scheme == "https", url.host != nil else {
            urlError = "Adres https:// ile başlamalı ve bir alan adı içermeli."
            return
        }
        context.insert(Webhook(url: url.absoluteString, secret: WebhookSender.newSecret()))
        try? context.save()
        newURL = ""
        urlError = nil
    }
}

private struct WebAccessView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.openURL) private var openURL
    @State private var confirmOff = false
    @State private var serverText = ""
    @State private var invite = ""

    var body: some View {
        Form {
            Section {
                Text("Web erişimi açıkken Freeband her senkrondan sonra verilerini aşağıdaki sunucuya da gönderir. Böylece tarayıcıdan panelini görebilir, API ile verine ulaşabilir, sunucu tarafında webhook kurabilirsin. Kapattığında sunucudaki tüm verin silinir.")
                    .font(.callout)
                    .foregroundStyle(Theme.secondary)
            }

            if model.hubEnabled {
                Section {
                    Button("Web panelini aç") { if let url = model.hub.panelURL() { openURL(url) } }
                    Button("API anahtarını kopyala") { UIPasteboard.general.string = Vault.hubToken }
                    Button("API belgesini aç") { openURL(model.hubURL.appendingPathComponent("docs")) }
                    Button("Şimdi gönder") { Task { await model.pushToHub() } }
                    Button("API anahtarını yenile") { Task { await model.rotateToken() } }
                } footer: {
                    Text("API anahtarı bir parola gibidir. Kopyaladığın yerde saklarken dikkat et; sızdıysa yenile.")
                }
                Section {
                    Button("Web erişimini kapat", role: .destructive) { confirmOff = true }
                }
            } else {
                Section {
                    TextField("Davet kodu", text: $invite)
                        .textInputAutocapitalization(.characters)
                        .autocorrectionDisabled()
                    Button("Web erişimini aç") { Task { await model.enableWebAccess(invite: invite) } }
                        .disabled(model.hubBusy || invite.trimmingCharacters(in: .whitespaces).isEmpty)
                } footer: {
                    Text("Sunucu davetle çalışıyor; kodu sunucuyu işleten kişiden al.")
                }
            }

            Section {
                if model.hubEnabled {
                    LabeledContent("Sunucu", value: model.hubURL.host ?? model.hubURL.absoluteString)
                } else {
                    TextField(HubClient.defaultURL.absoluteString, text: $serverText)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .onSubmit {
                            if let url = URL(string: serverText), url.scheme == "https" { model.hubURL = url }
                        }
                }
            } header: {
                Text("Sunucu")
            } footer: {
                if let status = model.hubStatus { Text(status) }
            }
        }
        .navigationTitle("Web erişimi")
        .overlay { if model.hubBusy { ProgressView() } }
        .onAppear { serverText = model.hubURL.absoluteString }
        .confirmationDialog("Web erişimi kapatılsın mı?", isPresented: $confirmOff, titleVisibility: .visible) {
            Button("Kapat ve sunucudaki veriyi sil", role: .destructive) { Task { await model.disableWebAccess() } }
        } message: {
            Text("Sunucudaki hesabın, verin ve webhook'ların kalıcı olarak silinir. Telefondaki veri kalır.")
        }
    }
}

private struct DiagnosticsView: View {
    @EnvironmentObject private var link: BandLink

    var body: some View {
        List {
            Section {
                LabeledContent("Durum", value: link.phase.label.isEmpty ? "Boşta" : link.phase.label)
            }
            Section("Son oturum") {
                if link.log.isEmpty {
                    Text("Henüz oturum yok.").foregroundStyle(Theme.secondary)
                }
                ForEach(Array(link.log.enumerated()), id: \.offset) { entry in
                    Text(entry.element).font(.caption.monospaced())
                }
            }
        }
        .navigationTitle("Tanılama")
        .toolbar {
            if !link.log.isEmpty {
                ShareLink(item: link.log.joined(separator: "\n"))
            }
        }
    }
}

private struct AboutView: View {
    @EnvironmentObject private var model: AppModel
    @AppStorage("onboarded") private var onboarded = true
    @Environment(\.openURL) private var openURL

    var body: some View {
        Form {
            Section {
                LabeledContent("Sürüm", value: Payload.appVersion)
                Button("Gizlilik") { openURL(model.hubURL.appendingPathComponent("privacy")) }
                Button("İlk kurulumu yeniden göster") { onboarded = false }
            }
            Section {
                Text("Freeband bağımsız bir projedir ve Xiaomi ile bağlantılı değildir. Xiaomi, Mi Band ve Mi Fitness, Xiaomi Inc.'in markalarıdır.")
                    .font(.footnote)
                    .foregroundStyle(Theme.secondary)
            }
        }
        .navigationTitle("Hakkında")
    }
}
