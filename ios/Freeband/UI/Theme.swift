import SwiftUI
import UIKit

/// Tokens from docs/DESIGN.md (v2): always dark, hairline grids, Departure Mono for figures and
/// labels, light SF Pro for headlines. Accent colours belong to data: phosphor is steps, pulse is
/// heart rate (and destructive actions). Buttons stay monochrome.
enum Theme {
    static let ground = Color(hex: 0x0A0A0A)
    static let surface = Color(hex: 0x111111)
    static let line = Color(hex: 0x1F1F1F)
    static let ink = Color(hex: 0xEDEDED)
    static let secondary = Color(hex: 0x8A8A8A)
    static let faint = Color(hex: 0x4A4A4A)
    static let phosphor = Color(hex: 0x8BE36B)
    static let pulse = Color(hex: 0xFF5C5C)

    /// The interface is Turkish; dates and numbers follow it whatever the phone's language.
    static let locale = Locale(identifier: "tr_TR")

    static let monoName = "DepartureMono-Regular"

    /// Departure Mono, the pixel monospace used for figures, labels and buttons.
    static func mono(_ size: CGFloat) -> Font { .custom(monoName, size: size) }

    /// Large figures (steps, pulse, battery).
    static func figure(_ size: CGFloat) -> Font { mono(size) }

    /// Headlines: thin and quiet next to the pixel figures.
    static func headline(_ size: CGFloat) -> Font { .system(size: size, weight: .light) }
}

extension Color {
    init(hex: UInt32, alpha: Double = 1) {
        self.init(.sRGB, red: Double((hex >> 16) & 0xFF) / 255, green: Double((hex >> 8) & 0xFF) / 255,
                  blue: Double(hex & 0xFF) / 255, opacity: alpha)
    }
}

/// Full-width light button: the one primary action on a screen.
struct PrimaryButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(Theme.mono(16))
            .foregroundStyle(Theme.ground)
            .frame(maxWidth: .infinity, minHeight: 50)
            .background(Theme.ink.opacity(isEnabled ? (configuration.isPressed ? 0.8 : 1) : 0.35),
                        in: RoundedRectangle(cornerRadius: 2))
    }
}

/// Dark button with a hairline border.
struct OutlineButtonStyle: ButtonStyle {
    var tint: Color = Theme.ink
    var filled = false

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(Theme.mono(16))
            .foregroundStyle(filled ? Theme.ground : tint)
            .frame(minHeight: 50)
            .padding(.horizontal, 16)
            .background(filled ? tint : Theme.surface, in: RoundedRectangle(cornerRadius: 2))
            .overlay(RoundedRectangle(cornerRadius: 2).stroke(filled ? tint : Theme.line, lineWidth: 1))
            .opacity(configuration.isPressed ? 0.7 : 1)
    }
}

/// Quiet text action under a primary button.
struct QuietButtonStyle: ButtonStyle {
    var tint: Color = Theme.ink

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(Theme.mono(15))
            .foregroundStyle(tint.opacity(configuration.isPressed ? 0.6 : 1))
            .frame(maxWidth: .infinity, minHeight: 44)
            .contentShape(Rectangle())
    }
}

/// Small monospace label above a value.
struct MonoLabel: View {
    let text: String
    init(_ text: String) { self.text = text }

    var body: some View {
        Text(text)
            .font(Theme.mono(12))
            .foregroundStyle(Theme.secondary)
            .textCase(.lowercase)
    }
}

/// Cells that share 1 px borders, like the hairline grids on ade.chele.bi.
struct HairlineGrid<Cell: View>: View {
    let columns: Int
    let cells: [Cell]

    var body: some View {
        let rows = stride(from: 0, to: cells.count, by: columns).map { Array(cells[$0..<min($0 + columns, cells.count)]) }
        VStack(spacing: 0) {
            ForEach(rows.indices, id: \.self) { r in
                if r > 0 { Rectangle().fill(Theme.line).frame(height: 1) }
                HStack(spacing: 0) {
                    ForEach(rows[r].indices, id: \.self) { c in
                        if c > 0 { Rectangle().fill(Theme.line).frame(width: 1) }
                        rows[r][c]
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(12)
                    }
                }
                .fixedSize(horizontal: false, vertical: true)
            }
        }
        .overlay(Rectangle().stroke(Theme.line, lineWidth: 1))
    }
}
