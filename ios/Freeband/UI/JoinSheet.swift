import SwiftUI

/// Confirms an invite opened from a QR code before anything is sent to a server.
struct JoinSheet: View {
    let invite: AppModel.Invite
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @State private var tried = false

    private var joined: Bool { tried && model.hubEnabled }

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text(joined ? "Katıldın." : "Web erişimine katıl")
                .font(.largeTitle.weight(.bold))
                .foregroundStyle(Theme.ink)

            if joined {
                Text("Verilerin her senkrondan sonra \(invite.hub.host ?? "sunucuya") da gider. Panelini tarayıcıda açabilir, API anahtarını Ayarlar > Web erişimi'nden alabilirsin.")
                    .foregroundStyle(Theme.ink)
            } else if model.hubEnabled {
                Text("Web erişimin zaten açık (\(model.hubURL.host ?? "")). Başka bir sunucuya geçmek için önce Ayarlar > Web erişimi'nden kapat.")
                    .foregroundStyle(Theme.ink)
            } else {
                Text("Katılınca Freeband verilerini telefonun yanında bu sunucuya da gönderir; tarayıcıdan panelini görür, API ile verine ulaşırsın. İstediğin an kapatıp sunucudaki verini silebilirsin.")
                    .foregroundStyle(Theme.ink)
                VStack(alignment: .leading, spacing: 4) {
                    Text(invite.hub.host ?? invite.hub.absoluteString)
                        .font(.title3.weight(.semibold))
                        .foregroundStyle(Theme.ink)
                    Text("Davet kodu \(invite.code)")
                        .font(.subheadline)
                        .foregroundStyle(Theme.secondary)
                }
                if !invite.isDefaultHub {
                    Text("Bu, Freeband'in varsayılan sunucusu değil. Sağlık verin buraya gidecek; yalnızca güvendiğin birinden geldiyse katıl.")
                        .font(.callout)
                        .foregroundStyle(Theme.pomegranate)
                }
                if tried, let status = model.hubStatus {
                    Text(status).font(.callout).foregroundStyle(Theme.pomegranate)
                }
            }

            Spacer()
            if joined {
                Button("Web panelini aç") {
                    if let url = model.hub.panelURL() { openURL(url) }
                }
                .buttonStyle(PrimaryButtonStyle())
                Button("Kapat") { dismiss() }
                    .buttonStyle(QuietButtonStyle())
            } else if model.hubEnabled {
                Button("Kapat") { dismiss() }
                    .buttonStyle(PrimaryButtonStyle())
            } else {
                Button {
                    tried = true
                    Task { await model.accept(invite) }
                } label: {
                    if model.hubBusy { ProgressView().tint(Theme.ground) } else { Text("Katıl") }
                }
                .buttonStyle(PrimaryButtonStyle())
                .disabled(model.hubBusy)
                Button("Vazgeç") { dismiss() }
                    .buttonStyle(QuietButtonStyle(tint: Theme.secondary))
            }
        }
        .padding(24)
        .background(Theme.ground)
        .presentationDetents([.large])
    }
}
