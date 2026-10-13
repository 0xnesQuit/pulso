#if DEBUG
import Foundation
import SwiftData

/// Debug-only sample day for simulator screenshots: launch with `-openband-demo`.
enum DemoData {
    @MainActor
    static func seed(_ context: ModelContext) {
        try? context.delete(model: Sample.self)
        try? context.delete(model: Band.self)
        let band = Band(name: "Xiaomi Smart Band 10 Pro", mac: "20:25:CC:78:D9:B9")
        band.lastBattery = 46
        band.lastSyncAt = Date().addingTimeInterval(-90)
        context.insert(band)

        let start = Calendar.current.startOfDay(for: Date())
        let perHour = [0, 0, 0, 0, 0, 0, 120, 640, 980, 300, 280, 420, 760, 510, 300, 260, 410, 900, 1100, 600, 280, 90, 0, 0]
        let nowHour = Calendar.current.component(.hour, from: Date())
        var steps = 0
        for hour in 0...nowHour {
            for quarter in 0..<4 {
                let ts = start.addingTimeInterval(TimeInterval(hour * 3600 + quarter * 900 + 300))
                guard ts < Date() else { break }
                steps += perHour[hour] / 4
                let bpm = hour < 7 ? 54 + quarter : 62 + (perHour[hour] / 40) + quarter * 3
                let draft = SampleDraft(kind: "live", ts: ts, steps: steps, calories: steps / 27,
                                        heartRate: bpm, standingHours: max(0, hour - 7))
                context.insert(Sample(bandID: band.id, draft: draft))
            }
        }
        context.insert(Sample(bandID: band.id, draft: .battery(46, at: Date().addingTimeInterval(-90))))
        UserDefaults.standard.set(true, forKey: "onboarded")
        try? context.save()
    }
}
#endif
