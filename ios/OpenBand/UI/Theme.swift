import SwiftUI
import UIKit

/// Tokens from docs/DESIGN.md. Accent colours belong to data: Saffron is steps, Pomegranate is
/// heart rate (and destructive actions). Buttons are ink, never coloured.
enum Theme {
    static let ground = Color(light: 0xF1F3F5, dark: 0x121A2B)
    static let ink = Color(light: 0x16202B, dark: 0xE8ECF1)
    static let dial = Color(light: 0xD9DFE6, dark: 0x2A3348)
    static let saffron = Color(light: 0xE2A013, dark: 0xF0B43A)
    static let pomegranate = Color(light: 0xD2344A, dark: 0xF0566A)
    static let night = Color(light: 0x121A2B, dark: 0x000000, lightAlpha: 0.16, darkAlpha: 0.28)
    static let secondary = Color(light: 0x16202B, dark: 0xE8ECF1, lightAlpha: 0.6, darkAlpha: 0.6)

    /// The interface is Turkish; dates and numbers follow it whatever the phone's language.
    static let locale = Locale(identifier: "tr_TR")

    /// Compressed SF Pro for figures, like the numerals on a watch dial.
    static func figure(_ size: CGFloat) -> Font {
        .system(size: size, weight: .semibold).width(.compressed).monospacedDigit()
    }
}

extension Color {
    init(light: UInt32, dark: UInt32, lightAlpha: CGFloat = 1, darkAlpha: CGFloat = 1) {
        self.init(UIColor { traits in
            traits.userInterfaceStyle == .dark
                ? UIColor(hex: dark, alpha: darkAlpha)
                : UIColor(hex: light, alpha: lightAlpha)
        })
    }
}

extension UIColor {
    convenience init(hex: UInt32, alpha: CGFloat = 1) {
        self.init(red: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255,
                  blue: CGFloat(hex & 0xFF) / 255, alpha: alpha)
    }
}

/// Full-width ink button: the one primary action on a screen.
struct PrimaryButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.body.weight(.semibold))
            .foregroundStyle(Theme.ground)
            .frame(maxWidth: .infinity, minHeight: 52)
            .background(Theme.ink.opacity(isEnabled ? (configuration.isPressed ? 0.8 : 1) : 0.3),
                        in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    }
}

/// Quiet text action under a primary button.
struct QuietButtonStyle: ButtonStyle {
    var tint: Color = Theme.ink

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.body.weight(.medium))
            .foregroundStyle(tint.opacity(configuration.isPressed ? 0.6 : 1))
            .frame(maxWidth: .infinity, minHeight: 44)
            .contentShape(Rectangle())
    }
}
