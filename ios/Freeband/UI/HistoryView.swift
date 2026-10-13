import Charts
import SwiftData
import SwiftUI

/// Picks the band shown on Today (shared selection) for the other tabs.
struct SelectedBand<Content: View>: View {
    @Query(sort: \Band.addedAt) private var bands: [Band]
    @AppStorage("selectedBand") private var selectedBand = ""
    @ViewBuilder let content: (Band?) -> Content

    var body: some View {
        content(bands.first { $0.id.uuidString == selectedBand } ?? bands.first)
    }
}

struct HistoryView: View {
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    Text("Geçmiş")
                        .font(Theme.headline(34))
                        .foregroundStyle(Theme.ink)
                    SelectedBand { band in
                        if let band {
                            HistoryContent(band: band).id(band.id)
                        } else {
                            Text("Henüz bant eklenmedi.").foregroundStyle(Theme.secondary)
                        }
                    }
                }
                .padding(.horizontal, 20)
                .padding(.vertical, 12)
            }
            .background(Theme.ground)
            .toolbar(.hidden, for: .navigationBar)
        }
    }
}

private struct DayStat: Identifiable {
    let day: Date
    let steps: Int
    let calories: Int
    let heartMin: Int?
    let heartMax: Int?
    var id: Date { day }
}

private struct HistoryContent: View {
    let band: Band
    @Query private var samples: [Sample]

    init(band: Band) {
        self.band = band
        let id = band.id
        let since = Calendar.current.date(byAdding: .day, value: -30, to: Calendar.current.startOfDay(for: Date()))!
        _samples = Query(filter: #Predicate<Sample> { $0.bandID == id && $0.kind == "live" && $0.ts >= since },
                         sort: \Sample.ts)
    }

    private var days: [DayStat] {
        let calendar = Calendar.current
        return Dictionary(grouping: samples) { calendar.startOfDay(for: $0.ts) }
            .map { day, items in
                let hearts = items.map(\.heartRate).filter { $0 > 10 }
                return DayStat(day: day, steps: items.map(\.steps).max() ?? 0,
                               calories: items.map(\.calories).max() ?? 0,
                               heartMin: hearts.min(), heartMax: hearts.max())
            }
            .sorted { $0.day > $1.day }
    }

    var body: some View {
        let days = self.days
        VStack(alignment: .leading, spacing: 24) {
            if days.isEmpty {
                Text("Henüz geçmiş yok. Bugün ekranından senkronize ettikçe günler burada birikir.")
                    .foregroundStyle(Theme.secondary)
            } else {
                stepsChart(days)
                VStack(spacing: 0) {
                    ForEach(days) { day in
                        row(day)
                        if day.id != days.last?.id { Rectangle().fill(Theme.line).frame(height: 1) }
                    }
                }
            }
            Text("Günlük toplamlar Freeband'in o gün yaptığı senkronlardan gelir. Bandın kendi kaydettiği dakikalık geçmişi ve uykuyu okumak bir sonraki sürümde ekleniyor.")
                .font(.footnote)
                .foregroundStyle(Theme.secondary)
        }
    }

    private func stepsChart(_ days: [DayStat]) -> some View {
        let recent = days.prefix(14)
        let average = recent.isEmpty ? 0 : recent.map(\.steps).reduce(0, +) / recent.count
        return VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                Text("Adım, son 14 gün").font(.headline).foregroundStyle(Theme.ink)
                Spacer()
                Text("ortalama \(average.formatted(.number.locale(Theme.locale)))")
                    .font(.subheadline)
                    .foregroundStyle(Theme.secondary)
            }
            Chart(recent) { day in
                BarMark(x: .value("Gün", day.day, unit: .day), y: .value("Adım", day.steps))
                    .foregroundStyle(Theme.phosphor)
                    .cornerRadius(0)
            }
            .chartXAxis {
                AxisMarks(values: .stride(by: .day, count: 2)) {
                    AxisValueLabel(format: .dateTime.day().month(.abbreviated))
                        .font(Theme.mono(10))
                        .foregroundStyle(Theme.secondary)
                }
            }
            .environment(\.locale, Theme.locale)
            .frame(height: 180)
        }
    }

    private func row(_ day: DayStat) -> some View {
        HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: 2) {
                Text(day.day.formatted(.dateTime.weekday(.wide).day().month(.wide).locale(Theme.locale)))
                    .font(.subheadline)
                    .foregroundStyle(Theme.ink)
                if let lo = day.heartMin, let hi = day.heartMax {
                    Text("nabız \(lo)–\(hi) bpm")
                        .font(.footnote)
                        .foregroundStyle(Theme.pulse)
                }
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 0) {
                Text(day.steps.formatted(.number.locale(Theme.locale)))
                    .font(Theme.figure(24))
                    .foregroundStyle(Theme.phosphor)
                Text("\(day.calories.formatted(.number.locale(Theme.locale))) kalori")
                    .font(.footnote)
                    .foregroundStyle(Theme.secondary)
            }
        }
        .padding(.vertical, 12)
    }
}

struct SleepView: View {
    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 18) {
                Text("Uyku")
                    .font(Theme.headline(34))
                    .foregroundStyle(Theme.ink)
                DayDial(hourlySteps: Array(repeating: 0, count: 24), heartRates: [], nowHour: 7,
                        centerValue: nil, centerCaption: "")
                    .frame(width: 200)
                    .frame(maxWidth: .infinity)
                    .accessibilityHidden(true)
                Text("Gecen burada evreleriyle görünecek: derin, hafif, REM ve uyanık süreler.")
                    .foregroundStyle(Theme.ink)
                Text("Bant uykunu kendi içinde kaydediyor. Freeband'in bu kaydı okuması üzerinde çalışılıyor; hazır olduğunda senkron uykuyu da getirecek.")
                    .font(.callout)
                    .foregroundStyle(Theme.secondary)
                Spacer()
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.ground)
            .toolbar(.hidden, for: .navigationBar)
        }
    }
}
