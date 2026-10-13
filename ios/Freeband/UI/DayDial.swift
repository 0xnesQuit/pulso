import SwiftUI

/// The day as a 24-hour watch face (docs/DESIGN.md): 00 at the top, clockwise. Outer bars are
/// steps per hour, inner dots are heart-rate readings (further out = higher), night hours are
/// shaded on the track and a tick marks now.
struct DayDial: View {
    let hourlySteps: [Int]
    let heartRates: [(hour: Double, bpm: Int)]
    let nowHour: Double
    let centerValue: String?
    let centerCaption: String

    @State private var grown = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        GeometryReader { geo in
            let size = min(geo.size.width, geo.size.height)
            let track = size * 0.33
            let peak = max(hourlySteps.max() ?? 0, 1)

            ZStack {
                Circle()
                    .stroke(Theme.dial, lineWidth: size * 0.028)
                    .frame(width: track * 2, height: track * 2)

                nightArc(from: 22, to: 24, track: track, size: size)
                nightArc(from: 0, to: 6, track: track, size: size)

                ForEach(0..<24, id: \.self) { hour in
                    let value = CGFloat(hourlySteps[safe: hour] ?? 0) / CGFloat(peak)
                    let length = value > 0 ? max(size * 0.018, value * size * 0.11) : 0
                    Capsule()
                        .fill(Theme.saffron)
                        .frame(width: size * 0.022, height: length)
                        .scaleEffect(x: 1, y: grown ? 1 : 0.001, anchor: .bottom)
                        .offset(y: -(track + size * 0.035 + length / 2))
                        .rotationEffect(.degrees((Double(hour) + 0.5) / 24 * 360))
                        .animation(reduceMotion ? nil : .easeOut(duration: 0.3).delay(Double(hour) * 0.012),
                                   value: grown)
                }

                let center = CGPoint(x: geo.size.width / 2, y: geo.size.height / 2)
                Path { path in
                    var previous: Double?
                    for reading in heartRates.sorted(by: { $0.hour < $1.hour }) {
                        let p = point(reading, center: center, track: track, size: size)
                        if let previous, reading.hour - previous < 0.5 { path.addLine(to: p) } else { path.move(to: p) }
                        previous = reading.hour
                    }
                }
                .stroke(Theme.pomegranate.opacity(0.45), style: StrokeStyle(lineWidth: 1.5, lineCap: .round, lineJoin: .round))

                ForEach(Array(heartRates.enumerated()), id: \.offset) { _, reading in
                    Circle()
                        .fill(Theme.pomegranate)
                        .frame(width: size * 0.011, height: size * 0.011)
                        .position(point(reading, center: center, track: track, size: size))
                }

                Capsule()
                    .fill(Theme.pomegranate)
                    .frame(width: 3, height: size * 0.05)
                    .offset(y: -track)
                    .rotationEffect(.degrees(nowHour / 24 * 360))

                ForEach([0, 6, 12, 18], id: \.self) { hour in
                    let angle = Double(hour) / 24 * 2 * .pi
                    let r = track - size * 0.06
                    Text(String(format: "%02d", hour))
                        .font(.caption2.weight(.medium))
                        .monospacedDigit()
                        .foregroundStyle(Theme.secondary)
                        .offset(x: sin(angle) * r, y: -cos(angle) * r)
                }

                if centerValue != nil || !centerCaption.isEmpty {
                VStack(spacing: 0) {
                    Text(centerValue ?? "–")
                        .font(Theme.figure(size * 0.17))
                        .foregroundStyle(centerValue == nil ? Theme.secondary : Theme.pomegranate)
                        .contentTransition(.numericText())
                    Text(centerCaption)
                        .font(.footnote)
                        .foregroundStyle(Theme.secondary)
                }
                }
            }
            .frame(width: geo.size.width, height: geo.size.height)
        }
        .aspectRatio(1, contentMode: .fit)
        .onAppear { grown = true }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilitySummary)
    }

    private func nightArc(from: Double, to: Double, track: CGFloat, size: CGFloat) -> some View {
        Circle()
            .trim(from: from / 24, to: to / 24)
            .stroke(Theme.night, lineWidth: size * 0.028)
            .frame(width: track * 2, height: track * 2)
            .rotationEffect(.degrees(-90))
    }

    /// The day's own heart-rate range (at least 30 bpm wide) spans from just outside the centre
    /// figure to just inside the hour labels, so a day's rise and fall stays visible.
    private var heartRange: (lo: Double, hi: Double) {
        let values = heartRates.map { Double($0.bpm) }
        guard let lo = values.min(), let hi = values.max() else { return (40, 180) }
        let mid = (lo + hi) / 2
        let half = max((hi - lo) / 2 + 5, 15)
        return (mid - half, mid + half)
    }

    private func point(_ reading: (hour: Double, bpm: Int), center: CGPoint, track: CGFloat, size: CGFloat) -> CGPoint {
        let inner = size * 0.19
        let outer = track - size * 0.1
        let range = heartRange
        let t = min(max((Double(reading.bpm) - range.lo) / (range.hi - range.lo), 0), 1)
        let r = inner + CGFloat(t) * (outer - inner)
        let angle = reading.hour / 24 * 2 * .pi
        return CGPoint(x: center.x + sin(angle) * r, y: center.y - cos(angle) * r)
    }

    private var accessibilitySummary: String {
        let steps = hourlySteps.reduce(0, +)
        var parts = ["Günün kadranı"]
        if let busiest = hourlySteps.indices.max(by: { hourlySteps[$0] < hourlySteps[$1] }), steps > 0 {
            parts.append("en hareketli saat \(busiest):00")
        }
        if let value = centerValue { parts.append("nabız \(value)") }
        return parts.joined(separator: ", ")
    }
}

extension Array {
    subscript(safe index: Int) -> Element? { indices.contains(index) ? self[index] : nil }
}
