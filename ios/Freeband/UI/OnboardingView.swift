import SwiftData
import SwiftUI
import UniformTypeIdentifiers

/// First run, three real steps (docs/DESIGN.md): what Freeband is, get the band key, connect.
struct OnboardingView: View {
    @AppStorage("onboarded") private var onboarded = false
    @State private var step = 1
    @State private var added: [Band] = []

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("\(step) / 3")
                .font(Theme.mono(13))
                .foregroundStyle(Theme.secondary)
                .padding(.bottom, 20)

            Group {
                switch step {
                case 1: WelcomeStep { step = 2 }
                case 2: KeyStep { bands in added = bands; step = 3 }
                default: ConnectStep(bands: added) { onboarded = true }
                }
            }
            .transition(.asymmetric(insertion: .move(edge: .trailing).combined(with: .opacity),
                                    removal: .opacity))
        }
        .animation(.easeInOut(duration: 0.25), value: step)
        .padding(.horizontal, 24)
        .padding(.top, 32)
        .padding(.bottom, 16)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(Theme.ground)
    }
}

private struct StepTitle: View {
    let text: String

    var body: some View {
        Text(text)
            .font(Theme.headline(34))
            .foregroundStyle(Theme.ink)
            .fixedSize(horizontal: false, vertical: true)
    }
}

private struct WelcomeStep: View {
    let next: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            OpeningDial(hourlySteps: [0, 0, 0, 0, 0, 0, 120, 640, 980, 300, 280, 420, 760, 510, 300, 260, 410, 900, 1100, 600, 280, 90, 0, 0],
                        heartRates: [], nowHour: 18.5, centerValue: nil, centerCaption: "", showsHours: false)
                .frame(width: 180)
                .padding(.bottom, 8)
                .accessibilityHidden(true)

            StepTitle(text: "Bandın, sadece senin.")
            Text("Freeband, Xiaomi Smart Band 10 ve 10 Pro ile doğrudan konuşur. Hesap gerekmez; verilerin bu telefonda kalır ve sen açmadıkça hiçbir yere gitmez.")
                .foregroundStyle(Theme.ink)
            Text("Mi Fitness'ı silme. Bandın anahtarını ondan okuyacağız ve bant güncellemeleri için arada bir gerekecek.")
                .foregroundStyle(Theme.secondary)
            Text("Bandı Mi Fitness'tan kaldırma ve fabrika ayarlarına döndürme. Anahtar değişir, Freeband bağlanamaz.")
                .font(.callout)
                .foregroundStyle(Theme.pulse)

            Spacer()
            Button("Başlayalım", action: next)
                .buttonStyle(PrimaryButtonStyle())
        }
    }
}

/// Picks the Mi Fitness folder, reads the keys on the phone and lets the user choose bands.
/// Also used from Settings to add or re-read a band.
struct KeyStep: View {
    var title = "Bandın anahtarını al"
    let done: ([Band]) -> Void

    @EnvironmentObject private var model: AppModel
    @State private var picking = false
    @State private var found: [BandKey] = []
    @State private var chosen: Set<String> = []
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            StepTitle(text: title)
            Text("Bant yalnızca kendi anahtarını bilen uygulamayla konuşur. Bu anahtar telefonundaki Mi Fitness klasöründe duruyor; Freeband onu oradan okur ve yalnızca bu telefonun anahtar zincirinde saklar.")
                .foregroundStyle(Theme.ink)

            if found.isEmpty {
                VStack(alignment: .leading, spacing: 10) {
                    instruction(1, "Aşağıdaki Klasörü seç'e dokun.")
                    instruction(2, "Gözat > iPhone'umda > Mi Fitness klasörüne dokun.")
                    instruction(3, "Sağ üstteki Aç'a dokun.")
                }
                .padding(.top, 4)
            } else {
                Text(BandKey.groupedByBand(found).count == 1 ? "Bu bant bulundu:" : "Bu bantlar bulundu. Eklemek istediklerini seç:")
                    .foregroundStyle(Theme.secondary)
                ForEach(BandKey.groupedByBand(found), id: \.first!.hex) { group in
                    let lead = group[0]
                    let picked = group.allSatisfy { chosen.contains($0.hex) }
                    Button {
                        for key in group { if picked { chosen.remove(key.hex) } else { chosen.insert(key.hex) } }
                    } label: {
                        HStack {
                            Image(systemName: picked ? "checkmark.circle.fill" : "circle")
                                .foregroundStyle(Theme.ink)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(Band.displayName(name: BandKey.bestName(group), mac: lead.mac))
                                    .foregroundStyle(Theme.ink)
                                Text(group.count == 1 ? "Anahtar \(lead.masked)" : "\(group.count) anahtar bulundu; çalışanı Freeband seçer")
                                    .font(.footnote)
                                    .foregroundStyle(Theme.secondary)
                            }
                        }
                    }
                }
            }

            if let error {
                Text(error)
                    .font(.callout)
                    .foregroundStyle(Theme.pulse)
                Text("Mi Fitness klasörü görünmüyorsa Mi Fitness'ı bir kez açıp bandın senkronize olmasını bekle.")
                    .font(.footnote)
                    .foregroundStyle(Theme.secondary)
            }

            Spacer()
            if found.isEmpty {
                Button("Klasörü seç") { picking = true }
                    .buttonStyle(PrimaryButtonStyle())
            } else {
                Button("Devam") {
                    done(model.add(keys: found.filter { chosen.contains($0.hex) }))
                }
                .buttonStyle(PrimaryButtonStyle())
                .disabled(chosen.isEmpty)
                Button("Başka bir klasör seç") { picking = true }
                    .buttonStyle(QuietButtonStyle())
            }
        }
        .fileImporter(isPresented: $picking, allowedContentTypes: [.folder, .item]) { result in
            guard case .success(let url) = result else { return }
            do {
                found = try KeyLoader.load(from: url)
                chosen = Set(found.map(\.hex))
                error = nil
            } catch {
                found = []
                self.error = error.localizedDescription
            }
        }
    }

    private func instruction(_ number: Int, _ text: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text("\(number)")
                .font(Theme.figure(22))
                .foregroundStyle(Theme.phosphor)
                .frame(width: 18, alignment: .leading)
            Text(text)
                .foregroundStyle(Theme.ink)
        }
    }
}

private struct ConnectStep: View {
    let bands: [Band]
    let finish: () -> Void

    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var link: BandLink
    @State private var tried = false

    private var band: Band? { bands.first }
    private var succeeded: Bool { tried && link.phase == .done && link.bandID == band?.id }

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            StepTitle(text: succeeded ? "Bağlandı." : "Bandı bağla")

            if succeeded {
                Text(summary)
                    .font(Theme.headline(22))
                    .foregroundStyle(Theme.ink)
                if bands.count > 1 {
                    Text("Diğer bantlar ilk senkronda bağlanacak.")
                        .foregroundStyle(Theme.secondary)
                }
            } else {
                Text("Mi Fitness'ı uygulama değiştiriciden yukarı kaydırıp kapat ve \(band?.displayName ?? "bandı") bileğinde tut.")
                    .foregroundStyle(Theme.ink)
                if link.phase.isBusy {
                    Text(link.phase.label).foregroundStyle(Theme.secondary)
                } else if case .failed(let message) = link.phase, tried {
                    Text(message).foregroundStyle(Theme.pulse)
                }
            }

            Spacer()
            if succeeded {
                Button("Başla", action: finish)
                    .buttonStyle(PrimaryButtonStyle())
            } else {
                Button {
                    guard let band else { return }
                    tried = true
                    model.start(band, .check)
                } label: {
                    if link.phase.isBusy { ProgressView().tint(Theme.ground) } else { Text(tried ? "Tekrar dene" : "Bandı bağla") }
                }
                .buttonStyle(PrimaryButtonStyle())
                .disabled(link.phase.isBusy || band == nil)
                Button("Şimdilik geç", action: finish)
                    .buttonStyle(QuietButtonStyle(tint: Theme.secondary))
            }
        }
    }

    private var summary: String {
        var parts: [String] = []
        if let battery = link.battery { parts.append("Pil %\(battery)") }
        if let stats = link.stats { parts.append("bugün \(Int(stats.steps).formatted(.number.locale(Theme.locale))) adım") }
        return parts.isEmpty ? "Bant cevap verdi." : parts.joined(separator: ", ") + "."
    }
}
