import CoreBluetooth
import SwiftUI

/// Answers two questions at a glance: is the band with the phone, and is Freeband talking to
/// it right now (searching, reading, live, failed)?
struct ConnectionStatus: View {
    let band: Band
    @EnvironmentObject private var link: BandLink
    @State private var pulse = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var mine: Bool { link.bandID == band.id }

    var body: some View {
        HStack(spacing: 10) {
            glyph
                .frame(width: 16, height: 16)
            VStack(alignment: .leading, spacing: 1) {
                HStack(alignment: .firstTextBaseline) {
                    Text(title)
                        .font(Theme.mono(13))
                        .foregroundStyle(tone == .alert ? Theme.pulse : Theme.ink)
                        .lineLimit(1)
                    Spacer(minLength: 8)
                    if let trailing {
                        Text(trailing)
                            .font(Theme.mono(12))
                            .foregroundStyle(Theme.secondary)
                            .lineLimit(1)
                    }
                }
                if let detail {
                    Text(detail)
                        .font(Theme.mono(12))
                        .foregroundStyle(Theme.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(background)
        .overlay(Rectangle().stroke(tone == .alert || tone == .live ? Theme.pulse.opacity(0.5) : Theme.line, lineWidth: 1))
        .animation(.easeInOut(duration: 0.2), value: title)
        .accessibilityElement(children: .combine)
    }

    private enum Tone { case quiet, busy, live, alert }

    private var tone: Tone {
        switch link.bluetooth {
        case .poweredOff, .unauthorized, .unsupported: return .alert
        default: break
        }
        guard mine else { return .quiet }
        switch link.phase {
        case .searching, .connecting, .authenticating, .reading: return .busy
        case .live: return .live
        case .failed: return .alert
        default: return .quiet
        }
    }

    private var title: String {
        switch link.bluetooth {
        case .poweredOff: return "Bluetooth kapalı"
        case .unauthorized: return "Bluetooth izni yok"
        case .unsupported: return "Bluetooth LE yok"
        default: break
        }
        if mine {
            switch link.phase {
            case .searching: return "Bant aranıyor"
            case .connecting: return "Bağlanılıyor"
            case .authenticating: return "Bağlandı, kimlik doğrulanıyor"
            case .reading: return "Bağlı, veri okunuyor"
            case .live: return "Bağlı, canlı nabız açık"
            case .failed: return "Bağlanılamadı"
            default: break
            }
        }
        return link.nearby.contains(band.id) ? "Bant telefona bağlı" : "Bant şu an görünmüyor"
    }

    private var detail: String? {
        switch link.bluetooth {
        case .poweredOff: return "Denetim Merkezi'nden Bluetooth'u aç."
        case .unauthorized: return "Ayarlar > Freeband'den Bluetooth'a izin ver."
        default: break
        }
        if mine, case .failed(let message) = link.phase { return message }
        if mine, link.phase == .live { return "En fazla \(Int(BandLink.liveLimit)) saniye sürer; durdurunca kanal Mi Fitness'a döner." }
        if mine, link.phase.isBusy { return "Mi Fitness bu sırada kapalı olmalı." }
        return nil
    }

    /// Quiet states keep to one line: the last sync goes on the right.
    private var trailing: String? {
        guard tone == .quiet else { return nil }
        guard let at = band.lastSyncAt else { return "henüz senkron yok" }
        return "senkron \(at.formatted(.relative(presentation: .named).locale(Theme.locale)))"
    }

    @ViewBuilder private var glyph: some View {
        switch tone {
        case .busy:
            ProgressView().controlSize(.small).tint(Theme.ink)
        case .live:
            Rectangle()
                .fill(Theme.pulse)
                .frame(width: 8, height: 8)
                .scaleEffect(pulse ? 1.25 : 0.85)
                .opacity(pulse ? 1 : 0.6)
                .onAppear {
                    guard !reduceMotion else { return }
                    withAnimation(.easeInOut(duration: 0.6).repeatForever(autoreverses: true)) { pulse = true }
                }
                .onDisappear { pulse = false }
        case .alert:
            Image(systemName: "exclamationmark.circle.fill").foregroundStyle(Theme.pulse)
        case .quiet:
            if link.nearby.contains(band.id) {
                Rectangle().fill(Theme.phosphor).frame(width: 8, height: 8)
            } else {
                Rectangle().stroke(Theme.secondary, lineWidth: 1).frame(width: 8, height: 8)
            }
        }
    }

    private var background: Color {
        switch tone {
        case .live, .alert: return Theme.pulse.opacity(0.08)
        default: return Theme.surface
        }
    }
}
