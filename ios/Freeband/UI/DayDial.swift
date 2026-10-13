import SwiftUI

/// The day as a 24-hour dial drawn on a pixel grid (docs/DESIGN.md v2): 00 at the top, clockwise.
/// Every cell is a square pixel that is on or off; shades come from a 4×4 Bayer ordered dither.
/// Outer bars are steps per hour (phosphor), the inner trace is heart rate (pulse; further out is
/// higher), night hours are a sparser dither on the track and a white tick marks now.
struct DayDial: View, Animatable {
    let hourlySteps: [Int]
    let heartRates: [(hour: Double, bpm: Int)]
    let nowHour: Double
    let centerValue: String?
    let centerCaption: String
    var showsHours = true

    /// 0…24: how far round the dial the pixels have lit up (the opening animation).
    var progress: Double = 24
    var animatableData: Double {
        get { progress }
        set { progress = newValue }
    }

    static let grid = 72
    private static let bayer: [[Double]] = [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]]
        .map { $0.map { ($0 + 0.5) / 16 } }

    var body: some View {
        GeometryReader { geo in
            let size = min(geo.size.width, geo.size.height)
            ZStack {
                Canvas(rendersAsynchronously: false) { context, canvasSize in
                    draw(in: &context, size: min(canvasSize.width, canvasSize.height))
                }
                .frame(width: size, height: size)

                if showsHours {
                    ForEach([0, 6, 12, 18], id: \.self) { hour in
                        let angle = Double(hour) / 24 * 2 * .pi
                        let r = size * 0.27
                        Text(String(format: "%02d", hour))
                            .font(Theme.mono(max(9, size * 0.05)))
                            .foregroundStyle(Theme.faint)
                            .offset(x: sin(angle) * r, y: -cos(angle) * r)
                    }
                }

                if centerValue != nil || !centerCaption.isEmpty {
                    VStack(spacing: 2) {
                        Text(centerValue ?? "–")
                            .font(Theme.mono(size * 0.16))
                            .foregroundStyle(centerValue == nil ? Theme.faint : Theme.pulse)
                            .contentTransition(.numericText())
                        Text(centerCaption)
                            .font(Theme.mono(max(9, size * 0.05)))
                            .foregroundStyle(Theme.secondary)
                    }
                }
            }
            .frame(width: geo.size.width, height: geo.size.height)
        }
        .aspectRatio(1, contentMode: .fit)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilitySummary)
    }

    // MARK: pixels

    private func draw(in context: inout GraphicsContext, size: CGFloat) {
        let n = Self.grid
        let cell = size / CGFloat(n)
        let c = Double(n) / 2
        let track = Double(n) * 0.34
        let trackHalf = 1.2
        let barStart = track + 2.4
        let barMax = Double(n) * 0.13
        let peak = Double(max(hourlySteps.max() ?? 0, 1))
        let lit = min(max(progress, 0), 24)

        var pixels: [(Int, Int, Color)] = []
        pixels.reserveCapacity(n * n / 3)

        for y in 0..<n {
            for x in 0..<n {
                let dx = Double(x) + 0.5 - c
                let dy = Double(y) + 0.5 - c
                let r = (dx * dx + dy * dy).squareRoot()
                var angle = atan2(dx, -dy)
                if angle < 0 { angle += 2 * .pi }
                let hour = angle / (2 * .pi) * 24
                let threshold = Self.bayer[y % 4][x % 4]

                // hourly step bars, outside the track
                if r >= barStart, r <= barStart + barMax, hour <= lit {
                    let h = Int(hour)
                    let offset = hour - Double(h)
                    let value = Double(hourlySteps[safe: h] ?? 0) / peak
                    if value > 0, offset > 0.2, offset < 0.8, r <= barStart + max(1.2, value * barMax) {
                        pixels.append((x, y, Theme.phosphor))
                        continue
                    }
                }
                // track, with a sparser dither for night hours (22–06)
                if abs(r - track) <= trackHalf {
                    let night = hour >= 22 || hour < 6
                    if threshold < (night ? 0.12 : 0.3) { pixels.append((x, y, Theme.faint)) }
                }
            }
        }

        // heart-rate trace: one pixel per reading, 1-pixel lines between close readings
        let range = heartRange
        let inner = Double(n) * 0.17
        let outer = track - 3.5
        var previous: (Double, Int, Int)?
        for reading in heartRates.sorted(by: { $0.hour < $1.hour }) where reading.hour <= lit {
            let t = min(max((Double(reading.bpm) - range.lo) / (range.hi - range.lo), 0), 1)
            let r = inner + t * (outer - inner)
            let a = reading.hour / 24 * 2 * .pi
            let px = Int((c + sin(a) * r).rounded(.down))
            let py = Int((c - cos(a) * r).rounded(.down))
            if let (ph, qx, qy) = previous, reading.hour - ph < 0.5 {
                for (lx, ly) in Self.line(from: (qx, qy), to: (px, py)) { pixels.append((lx, ly, Theme.pulse)) }
            } else {
                pixels.append((px, py, Theme.pulse))
            }
            previous = (reading.hour, px, py)
        }

        // now tick: a short white bar across the track
        let a = nowHour / 24 * 2 * .pi
        for step in stride(from: track - 2.5, through: track + 2.5, by: 0.5) {
            pixels.append((Int((c + sin(a) * step).rounded(.down)), Int((c - cos(a) * step).rounded(.down)), Theme.ink))
        }

        for (x, y, color) in pixels where x >= 0 && y >= 0 && x < n && y < n {
            context.fill(Path(CGRect(x: CGFloat(x) * cell, y: CGFloat(y) * cell, width: cell, height: cell)),
                         with: .color(color))
        }
    }

    /// The day's own heart-rate range, at least 30 bpm wide, so its rise and fall stays visible.
    private var heartRange: (lo: Double, hi: Double) {
        let values = heartRates.map { Double($0.bpm) }
        guard let lo = values.min(), let hi = values.max() else { return (40, 180) }
        let mid = (lo + hi) / 2
        let half = max((hi - lo) / 2 + 5, 15)
        return (mid - half, mid + half)
    }

    /// Bresenham line between two grid cells.
    static func line(from a: (Int, Int), to b: (Int, Int)) -> [(Int, Int)] {
        var (x0, y0) = a
        let (x1, y1) = b
        let dx = abs(x1 - x0), sx = x0 < x1 ? 1 : -1
        let dy = -abs(y1 - y0), sy = y0 < y1 ? 1 : -1
        var err = dx + dy
        var out: [(Int, Int)] = []
        while true {
            out.append((x0, y0))
            if x0 == x1 && y0 == y1 { break }
            let e2 = 2 * err
            if e2 >= dy { err += dy; x0 += sx }
            if e2 <= dx { err += dx; y0 += sy }
        }
        return out
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

/// Lights the dial's pixels from 00 round to now once, unless Reduce Motion is on.
struct OpeningDial: View {
    let hourlySteps: [Int]
    let heartRates: [(hour: Double, bpm: Int)]
    let nowHour: Double
    let centerValue: String?
    let centerCaption: String
    var showsHours = true

    @State private var progress: Double = 0
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        DayDial(hourlySteps: hourlySteps, heartRates: heartRates, nowHour: nowHour,
                centerValue: centerValue, centerCaption: centerCaption, showsHours: showsHours, progress: progress)
            .onAppear {
                if reduceMotion {
                    progress = 24
                } else {
                    withAnimation(.easeOut(duration: 0.5)) { progress = 24 }
                }
            }
    }
}

extension Array {
    subscript(safe index: Int) -> Element? { indices.contains(index) ? self[index] : nil }
}
