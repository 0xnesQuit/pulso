import SwiftUI
import UniformTypeIdentifiers

@main
struct BandProbeApp: App {
    @StateObject private var probe = Probe()

    var body: some Scene {
        WindowGroup {
            ContentView().environmentObject(probe)
        }
    }
}

struct ContentView: View {
    @EnvironmentObject var probe: Probe
    @Environment(\.scenePhase) private var scenePhase
    @State private var pickingKey = false

    var body: some View {
        NavigationStack {
            List {
                Section {
                    BandCard()
                }

                Section("Auth key") {
                    if let key = probe.bandKey {
                        LabeledContent("Key", value: key.masked)
                        Text(verbatim: key.name.trimmingCharacters(in: .whitespaces))
                            .font(.caption).foregroundStyle(.secondary)
                    } else {
                        Text("Henüz key yok. Mi Fitness klasörünü seç; key yalnız bu telefonun Keychain'inde saklanır.")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    if probe.foundKeys.count > 1 {
                        Picker("Cihaz", selection: Binding(get: { probe.bandKey?.hex ?? "" },
                                                            set: { hex in
                                                                if let k = probe.foundKeys.first(where: { $0.hex == hex }) { probe.choose(k) }
                                                            })) {
                            ForEach(probe.foundKeys, id: \.hex) { k in Text(verbatim: "\(k.name) \(k.masked)").tag(k.hex) }
                        }
                    }
                    Button(probe.bandKey == nil ? "Mi Fitness klasörünü seç" : "Key'i yeniden oku") { pickingKey = true }
                }

                Section("Teknik") {
                    DisclosureGroup("Bağlantı günlüğü (\(probe.authLog.count))") {
                        ForEach(Array(probe.authLog.enumerated()), id: \.offset) { entry in
                            Text(verbatim: entry.element).font(.caption2.monospaced())
                        }
                    }
                    DisclosureGroup("GATT taraması") {
                        SurveyRows()
                    }
                }
            }
            .navigationTitle("BandProbe")
            .fileImporter(isPresented: $pickingKey, allowedContentTypes: [.folder, .item]) { result in
                if case .success(let url) = result { probe.importKey(from: url) }
            }
            .onChange(of: scenePhase) { _, phase in
                if phase != .active { probe.stopLive(reason: "uygulama arka plana geçti") }
            }
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    ShareLink(item: probe.reportFile()) {
                        Image(systemName: "square.and.arrow.up")
                    }
                }
            }
        }
    }
}

struct BandCard: View {
    @EnvironmentObject var probe: Probe

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 8) {
                Circle()
                    .fill(probe.liveRunning ? Color.green : Color.secondary.opacity(0.4))
                    .frame(width: 10, height: 10)
                VStack(alignment: .leading, spacing: 2) {
                    Text(verbatim: bandName).font(.headline)
                    Text(probe.authState).font(.caption).foregroundStyle(.secondary)
                }
            }

            LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 12) {
                Metric(title: "Adım (bugün)", value: probe.live.map { "\($0.steps)" }, symbol: "figure.walk")
                Metric(title: "Nabız", value: heartRate, symbol: "heart.fill", tint: .red)
                Metric(title: "Pil", value: probe.authBattery, symbol: "battery.75percent", tint: .green)
                Metric(title: "Kalori", value: probe.live.map { "\($0.calories)" }, symbol: "flame.fill", tint: .orange)
            }

            if let updated = probe.liveUpdated {
                Text("Son güncelleme \(updated.formatted(date: .omitted, time: .standard))")
                    .font(.caption2).foregroundStyle(.secondary)
            }

            Button {
                if probe.liveRunning {
                    probe.stopLive(reason: "kullanıcı durdurdu")
                } else {
                    probe.runAuth()
                }
            } label: {
                Label(probe.liveRunning ? "Durdur" : "Bağlan ve canlı veriyi başlat",
                      systemImage: probe.liveRunning ? "stop.fill" : "dot.radiowaves.left.and.right")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .disabled(probe.bandKey == nil)

            Text("Mi Fitness bu sırada kapalı olmalı. Canlı veri \(Int(Probe.liveLimit)) sn sonra ya da uygulama arka plana geçince durur ve kanal Mi Fitness'a geri verilir.")
                .font(.caption2).foregroundStyle(.secondary)
        }
        .padding(.vertical, 6)
    }

    private var bandName: String {
        (probe.connectedName ?? probe.bandKey?.name ?? "Bant").trimmingCharacters(in: .whitespaces)
    }

    private var heartRate: String? {
        guard let live = probe.live else { return nil }
        return live.heartRate > 10 ? "\(live.heartRate)" : "ölçülüyor"
    }
}

struct Metric: View {
    let title: String
    let value: String?
    let symbol: String
    var tint: Color = .accentColor

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Label(title, systemImage: symbol)
                .font(.caption).foregroundStyle(tint)
            Text(verbatim: value ?? "–")
                .font(.system(size: value == "ölçülüyor" ? 20 : 30, weight: .semibold, design: .rounded))
                .monospacedDigit()
                .lineLimit(1)
                .minimumScaleFactor(0.6)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 12))
    }
}

/// Phase 2 read-only GATT survey, kept for diagnostics.
struct SurveyRows: View {
    @EnvironmentObject var probe: Probe

    var body: some View {
        Button("Taramayı yenile") { probe.refresh() }
        Text(probe.state).font(.caption)
        ForEach(probe.candidates) { c in
            Button { probe.probe(c) } label: {
                VStack(alignment: .leading) {
                    Text(c.name)
                    Text(c.source).font(.caption).foregroundStyle(.secondary)
                }
            }
        }
        if !probe.services.isEmpty {
            LabeledContent("BLE V2 (FE95 + 005E/005F)", value: probe.hasV2 ? "VAR" : "yok")
            ForEach(probe.services) { s in
                VStack(alignment: .leading, spacing: 2) {
                    Text(verbatim: label(s.uuid)).font(.subheadline.monospaced()).bold()
                    ForEach(s.characteristics) { c in
                        Text(verbatim: "  \(label(c.uuid))  [\(c.properties.joined(separator: ", "))]\(c.value.map { " = \($0)" } ?? "")")
                            .font(.caption2.monospaced())
                    }
                }
            }
        }
        ForEach(Array(probe.log.enumerated()), id: \.offset) { entry in
            Text(verbatim: entry.element).font(.caption2.monospaced()).foregroundStyle(.secondary)
        }
    }

    private func label(_ uuid: String) -> String {
        Probe.known[uuid].map { "\(uuid) · \($0)" } ?? uuid
    }
}
