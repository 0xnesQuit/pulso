import SwiftData
import SwiftUI

struct TodayView: View {
    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var link: BandLink
    @Query(sort: \Band.addedAt) private var bands: [Band]
    @AppStorage("selectedBand") private var selectedBand = ""

    private var band: Band? { bands.first { $0.id.uuidString == selectedBand } ?? bands.first }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    header
                    if let band {
                        ConnectionStatus(band: band)
                        DayContent(band: band)
                            .id(band.id)
                    } else {
                        Text("Henüz bant eklenmedi. Ayarlar > Bantlar'dan Mi Fitness klasörünü seçerek ekle.")
                            .foregroundStyle(Theme.secondary)
                    }
                }
                .padding(.horizontal, 20)
                .padding(.vertical, 12)
            }
            .background(Theme.ground)
            .toolbar(.hidden, for: .navigationBar)
            .task(id: bands.count) {
                while !Task.isCancelled {
                    link.refreshNearby(bands.map { ($0.id, $0.macSuffix) })
                    try? await Task.sleep(for: .seconds(10))
                }
            }
        }
    }

    private var header: some View {
        HStack(alignment: .firstTextBaseline) {
            Text(Date().formatted(.dateTime.weekday(.wide).day().month(.wide).locale(Theme.locale)))
                .font(.title2.weight(.semibold))
                .foregroundStyle(Theme.ink)
            Spacer()
            if bands.count > 1 {
                Menu {
                    ForEach(bands) { b in
                        Button(b.displayName) { selectedBand = b.id.uuidString }
                    }
                } label: {
                    Label(band?.displayName ?? "Bant", systemImage: "chevron.up.chevron.down")
                        .font(.subheadline.weight(.medium))
                        .labelStyle(.titleAndIcon)
                }
            } else if let band {
                Text(band.displayName)
                    .font(.subheadline)
                    .foregroundStyle(Theme.secondary)
            }
        }
    }
}

/// Today's samples for one band, live from SwiftData while a session writes them.
private struct DayContent: View {
    let band: Band
    @Query private var samples: [Sample]
    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var link: BandLink

    init(band: Band) {
        self.band = band
        let id = band.id
        let start = Calendar.current.startOfDay(for: Date())
        _samples = Query(filter: #Predicate<Sample> { $0.bandID == id && $0.ts >= start }, sort: \Sample.ts)
    }

    private var live: [Sample] { samples.filter { $0.kind == "live" } }
    private var latest: Sample? { live.last }
    private var lastHeart: Sample? { live.last { $0.heartRate > 10 } }
    private var isThisBand: Bool { link.bandID == band.id }
    private var busy: Bool { isThisBand && link.phase.isBusy }
    private var liveRunning: Bool { isThisBand && link.phase == .live }

    var body: some View {
        VStack(alignment: .leading, spacing: 28) {
            DayDial(hourlySteps: hourlySteps,
                    heartRates: lastHeart == nil ? [] : live.filter { $0.heartRate > 10 }.map { (hour(of: $0.ts), $0.heartRate) },
                    nowHour: hour(of: Date()),
                    centerValue: lastHeart.map { "\($0.heartRate)" },
                    centerCaption: heartCaption)
                .frame(maxWidth: 360)
                .frame(maxWidth: .infinity)

            if hourlySteps.reduce(0, +) == 0, latest != nil {
                Text("Saatlik dağılım OpenBand gün içinde senkronize ettikçe dolar.")
                    .font(.footnote)
                    .foregroundStyle(Theme.secondary)
            }

            HStack(alignment: .top) {
                figure(latest.map { $0.steps.formatted(.number.locale(Theme.locale)) } ?? "–", "adım", tint: Theme.saffron)
                Spacer()
                figure(latest.map { $0.calories.formatted(.number.locale(Theme.locale)) } ?? "–", "kalori", tint: Theme.ink)
                Spacer()
                figure(band.lastBattery.map { "%\($0)" } ?? "–", "pil", tint: Theme.ink)
            }

            VStack(spacing: 4) {
                Button {
                    model.start(band, .sync)
                } label: {
                    if busy && !liveRunning {
                        ProgressView().tint(Theme.ground)
                    } else {
                        Text("Senkronize et")
                    }
                }
                .buttonStyle(PrimaryButtonStyle())
                .disabled(link.phase.isBusy)

                Button(liveRunning ? "Canlı nabzı durdur" : "Canlı nabzı başlat") {
                    if liveRunning { model.stop() } else { model.start(band, .live) }
                }
                .buttonStyle(QuietButtonStyle(tint: liveRunning ? Theme.pomegranate : Theme.ink))
                .disabled(link.phase.isBusy && !liveRunning)
            }
        }
    }

    private func figure(_ value: String, _ label: String, tint: Color) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(value)
                .font(Theme.figure(44))
                .foregroundStyle(tint)
                .contentTransition(.numericText())
            Text(label)
                .font(.subheadline)
                .foregroundStyle(Theme.secondary)
        }
    }

    private var heartCaption: String {
        guard let lastHeart else { return "nabız yok" }
        if liveRunning { return "bpm, şimdi" }
        return "bpm, \(lastHeart.ts.formatted(date: .omitted, time: .shortened))"
    }

    /// Steps per hour from consecutive cumulative readings; the first reading of the day has
    /// no known spread, so it adds nothing.
    private var hourlySteps: [Int] {
        var out = Array(repeating: 0, count: 24)
        var previous: Sample?
        for sample in live {
            if let previous, sample.steps >= previous.steps {
                out[Calendar.current.component(.hour, from: sample.ts)] += sample.steps - previous.steps
            }
            previous = sample
        }
        return out
    }

    private func hour(of date: Date) -> Double {
        let c = Calendar.current.dateComponents([.hour, .minute], from: date)
        return Double(c.hour ?? 0) + Double(c.minute ?? 0) / 60
    }
}
