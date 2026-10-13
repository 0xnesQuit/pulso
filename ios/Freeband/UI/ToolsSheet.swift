import SwiftUI

/// Things the phone can make the band do: show a notification, vibrate to be found.
struct ToolsSheet: View {
    let band: Band
    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var link: BandLink
    @Environment(\.dismiss) private var dismiss
    @State private var title = "Freeband"
    @State private var message = "Merhaba bilek, ben telefon."
    @State private var lastAction: String?

    private var busy: Bool { link.phase.isBusy }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    VStack(alignment: .leading, spacing: 12) {
                        MonoLabel("bildirim gönder")
                        field("Başlık", text: $title)
                        field("Mesaj", text: $message, lines: 3)
                        Button("Banda gönder") {
                            lastAction = "Bildirim"
                            model.notify(band, title: title, body: message)
                        }
                        .buttonStyle(PrimaryButtonStyle())
                        .disabled(busy || message.trimmingCharacters(in: .whitespaces).isEmpty)
                    }

                    Rectangle().fill(Theme.line).frame(height: 1)

                    VStack(alignment: .leading, spacing: 12) {
                        MonoLabel("bandı bul")
                        Text("Bant titreşmeye başlar; bantta dokununca ya da Durdur'a basınca susar.")
                            .foregroundStyle(Theme.secondary)
                        HStack(spacing: 10) {
                            Button("Titret") {
                                lastAction = "Titreşim"
                                model.findBand(band, start: true)
                            }
                            .buttonStyle(OutlineButtonStyle(tint: Theme.ink))
                            Button("Durdur") {
                                lastAction = "Durdurma"
                                model.findBand(band, start: false)
                            }
                            .buttonStyle(OutlineButtonStyle(tint: Theme.secondary))
                        }
                        .disabled(busy)
                    }

                    if let lastAction, link.bandID == band.id, link.phase != .idle {
                        Text(status(for: lastAction))
                            .font(Theme.mono(13))
                            .foregroundStyle(isFailure ? Theme.pulse : Theme.secondary)
                    }

                    Text("Mi Fitness bu sırada kapalı olmalı. Her gönderimde Freeband banda kısa bir süre bağlanır ve kanalı geri bırakır.")
                        .font(Theme.mono(12))
                        .foregroundStyle(Theme.faint)
                }
                .padding(16)
            }
            .background(Theme.ground)
            .navigationTitle("Araçlar")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) { Button("Kapat") { dismiss() } }
            }
        }
    }

    private var isFailure: Bool {
        if case .failed = link.phase { return true }
        return false
    }

    private func status(for action: String) -> String {
        switch link.phase {
        case .done: return "\(action) banda gönderildi."
        case .failed(let message): return message
        default: return link.phase.label
        }
    }

    private func field(_ label: String, text: Binding<String>, lines: Int = 1) -> some View {
        TextField(label, text: text, axis: .vertical)
            .lineLimit(lines...max(lines, 4))
            .padding(12)
            .background(Theme.surface)
            .overlay(Rectangle().stroke(Theme.line, lineWidth: 1))
    }
}
