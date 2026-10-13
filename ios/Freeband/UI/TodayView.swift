import Charts
import SwiftData
import SwiftUI

/// One screen that reads at a glance: who is connected, the day dial with the latest pulse,
/// today's totals, a pulse curve, and the two actions pinned above the tab bar.
struct TodayView: View {
    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var link: BandLink
    @Query(sort: \Band.addedAt) private var bands: [Band]
    @AppStorage("selectedBand") private var selectedBand = ""

    private var band: Band? { bands.first { $0.id.uuidString == selectedBand } ?? bands.first }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
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
                .padding(.horizontal, 16)
                .padding(.top, 8)
                .padding(.bottom, 16)
            }
            .refreshable {
                if let band { await model.syncAndWait(band) }
            }
            .safeAreaInset(edge: .bottom) {
                if let band { ActionBar(band: band) }
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
                .font(Theme.headline(24))
                .foregroundStyle(Theme.ink)
                .lineLimit(1)
                .minimumScaleFactor(0.8)
            Spacer(minLength: 8)
            if bands.count > 1 {
                Menu {
                    ForEach(bands) { b in
                        Button(b.displayName) { selectedBand = b.id.uuidString }
                    }
                } label: {
                    HStack(spacing: 4) {
                        Text(band?.displayName ?? "Bant")
                        Image(systemName: "chevron.up.chevron.down").font(.caption2)
                    }
                    .font(Theme.mono(13))
                    .foregroundStyle(Theme.ink)
                }
            } else if let band {
                Text(band.displayName)
                    .font(Theme.mono(13))
                    .foregroundStyle(Theme.secondary)
            }
        }
    }
}

/// Sync and live, pinned above the tab bar so they never scroll away.
private struct ActionBar: View {
    let band: Band
    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var link: BandLink

    private var mine: Bool { link.bandID == band.id }
    private var live: Bool { mine && link.phase == .live }
    private var syncing: Bool { mine && link.phase.isBusy && !live }

    var body: some View {
        HStack(spacing: 10) {
            Button {
                model.start(band, .sync)
            } label: {
                if syncing {
                    ProgressView().tint(Theme.ground)
                } else {
                    Text("Senkronize et")
                }
            }
            .buttonStyle(PrimaryButtonStyle())
            .disabled(link.phase.isBusy)

            Button {
                if live { model.stop() } else { model.start(band, .live) }
            } label: {
                Text(live ? "Durdur" : "♥ Canlı")
                    .frame(minWidth: 84)
            }
            .buttonStyle(OutlineButtonStyle(tint: Theme.pulse, filled: live))
            .disabled(link.phase.isBusy && !live)
            .accessibilityLabel(live ? "Canlı nabzı durdur" : "Canlı nabzı başlat")
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(Theme.ground)
        .overlay(alignment: .top) { Rectangle().fill(Theme.line).frame(height: 1) }
    }
}

/// Today's samples for one band, live from SwiftData while a session writes them.
private struct DayContent: View {
    let band: Band
    @Query private var samples: [Sample]
    @EnvironmentObject private var link: BandLink

    init(band: Band) {
        self.band = band
        let id = band.id
        let start = Calendar.current.startOfDay(for: Date())
        _samples = Query(filter: #Predicate<Sample> { $0.bandID == id && $0.ts >= start }, sort: \Sample.ts)
    }

    private var live: [Sample] { samples.filter { $0.kind == "live" } }
    private var hearts: [Sample] { live.filter { $0.heartRate > 10 } }
    private var latest: Sample? { live.last }
    private var lastHeart: Sample? { hearts.last }
    private var liveNow: Bool { link.bandID == band.id && link.phase == .live }

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            hero
            Rectangle().fill(Theme.line).frame(height: 1)
            facts
            Rectangle().fill(Theme.line).frame(height: 1)
            pulseChart
        }
    }

    // MARK: hero: dial with the pulse in its centre, totals beside it

    private var hero: some View {
        HStack(alignment: .center, spacing: 18) {
            OpeningDial(hourlySteps: hourlySteps,
                    heartRates: hearts.map { (hour(of: $0.ts), $0.heartRate) },
                    nowHour: hour(of: Date()),
                    centerValue: lastHeart.map { "\($0.heartRate)" },
                    centerCaption: lastHeart == nil ? "nabız yok" : (liveNow ? "bpm, şimdi" : "bpm"))
                .containerRelativeFrame(.horizontal) { width, _ in min(width * 0.48, 200) }

            VStack(alignment: .leading, spacing: 12) {
                total(latest.map { $0.steps.formatted(.number.locale(Theme.locale)) }, "adım", tint: Theme.phosphor, size: 40)
                total(latest.map { $0.calories.formatted(.number.locale(Theme.locale)) }, "kalori", tint: Theme.ink, size: 28)
                total(band.lastBattery.map { "%\($0)" }, "pil", tint: Theme.ink, size: 28)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func total(_ value: String?, _ label: String, tint: Color, size: CGFloat) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            MonoLabel(label)
            Text(value ?? "–")
                .font(Theme.figure(size))
                .foregroundStyle(value == nil ? Theme.faint : tint)
                .contentTransition(.numericText())
                .lineLimit(1)
                .minimumScaleFactor(0.5)
        }
    }

    // MARK: facts: four small readings in two columns

    private var facts: some View {
        HairlineGrid(columns: 2, cells: [
            fact("Nabız aralığı", heartRange),
            fact("Ayakta", latest.map { "\($0.standingHours) saat" }),
            fact("Aktif saat", activeHours > 0 ? "\(activeHours) saat" : nil),
            fact("Son ölçüm", lastHeart.map { $0.ts.formatted(.dateTime.hour(.twoDigits(amPM: .omitted)).minute(.twoDigits).locale(Theme.locale)) }),
        ])
    }

    private func fact(_ label: String, _ value: String?) -> AnyView {
        AnyView(factView(label, value))
    }

    private func factView(_ label: String, _ value: String?) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            MonoLabel(label)
            Text(value ?? "–")
                .font(Theme.mono(18))
                .foregroundStyle(value == nil ? Theme.faint : Theme.ink)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
        }
    }

    private var heartRange: String? {
        let values = hearts.map(\.heartRate)
        guard let lo = values.min(), let hi = values.max() else { return nil }
        return lo == hi ? "\(lo) bpm" : "\(lo)–\(hi) bpm"
    }

    /// Hours with more than 250 steps.
    private var activeHours: Int { hourlySteps.filter { $0 > 250 }.count }

    // MARK: pulse over the day

    @ViewBuilder private var pulseChart: some View {
        VStack(alignment: .leading, spacing: 8) {
            MonoLabel("nabız, bugün")
            if hearts.count >= 2 {
                let values = hearts.map(\.heartRate)
                let lo = (values.min() ?? 50) - 5
                let hi = (values.max() ?? 120) + 5
                let start = Calendar.current.startOfDay(for: Date())
                Chart(hearts) { s in
                    LineMark(x: .value("Saat", s.ts), y: .value("bpm", s.heartRate))
                        .interpolationMethod(.stepCenter)
                        .lineStyle(StrokeStyle(lineWidth: 1.5))
                        .foregroundStyle(Theme.pulse)
                }
                .chartXScale(domain: start...start.addingTimeInterval(86_400))
                .chartYScale(domain: lo...hi)
                .chartXAxis {
                    AxisMarks(values: .stride(by: .hour, count: 6)) {
                        AxisGridLine().foregroundStyle(Theme.line)
                        AxisValueLabel(format: .dateTime.hour(.twoDigits(amPM: .omitted)))
                            .font(Theme.mono(10))
                            .foregroundStyle(Theme.secondary)
                    }
                }
                .chartYAxis {
                    AxisMarks(position: .trailing, values: .automatic(desiredCount: 3)) {
                        AxisGridLine().foregroundStyle(Theme.line)
                        AxisValueLabel()
                            .font(Theme.mono(10))
                            .foregroundStyle(Theme.secondary)
                    }
                }
                .environment(\.locale, Theme.locale)
                .frame(height: 96)
            } else {
                Text("Canlı nabzı açtıkça ya da senkronize ettikçe günün nabız eğrisi burada belirir.")
                    .font(Theme.mono(12))
                    .foregroundStyle(Theme.faint)
            }
        }
    }

    // MARK: helpers

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
