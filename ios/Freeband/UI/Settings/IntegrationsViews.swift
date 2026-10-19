import AppIntents
import SwiftData
import SwiftUI
import UIKit

/// Web access: join the hub with an invite, use an existing API key, open the panel and docs,
/// push now, renew the key, switch servers, or turn it off and delete the server copy.
struct WebAccessView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.openURL) private var openURL
    @State private var confirmOff = false
    @State private var serverText = ""
    @State private var invite = ""
    @State private var apiKey = ""

    var body: some View {
        Form {
            Section {
                Text("With web access on, Pulso also sends your data to the server below after every sync. You can open your panel in a browser, reach your data through the API and set up server-side webhooks. Turning it off deletes everything on the server.")
                    .textStyle(.subhead)
                    .foregroundStyle(.textSecondary)
            }
            .fbFormRow()

            if model.hubEnabled {
                Section {
                    Button(String(localized: "Open web panel")) { if let url = model.hub.panelURL() { openURL(url) } }
                    Button(String(localized: "Copy API key")) { UIPasteboard.general.string = Vault.hubToken }
                    Button(String(localized: "Open API docs")) { openURL(model.hubURL.appendingPathComponent("docs")) }
                    Button(String(localized: "Send now")) { Task { await model.pushToHub() } }
                    Button(String(localized: "Renew API key")) { Task { await model.rotateToken() } }
                } footer: {
                    Text("Treat the API key like a password. If it leaked, renew it.")
                }
                .fbFormRow()
                Section {
                    Button(String(localized: "Turn off web access"), role: .destructive) { confirmOff = true }
                }
                .fbFormRow()
            } else {
                Section {
                    TextField(String(localized: "Invite code"), text: $invite)
                        .textInputAutocapitalization(.characters)
                        .autocorrectionDisabled()
                    Button(String(localized: "Turn on web access")) { Task { await model.enableWebAccess(invite: invite) } }
                        .disabled(model.hubBusy || invite.trimmingCharacters(in: .whitespaces).isEmpty)
                } footer: {
                    Text("The server works by invitation. Ask the person who runs it for a code.")
                }
                .fbFormRow()
            }

            Section {
                SecureField(String(localized: "API key"), text: $apiKey)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                Button(String(localized: "Enter API key")) {
                    Task {
                        await model.enterAPIKey(apiKey)
                        if model.hubEnabled, Vault.hubToken == apiKey.trimmingCharacters(in: .whitespacesAndNewlines) { apiKey = "" }
                    }
                }
                .disabled(model.hubBusy || apiKey.trimmingCharacters(in: .whitespaces).isEmpty)
            } footer: {
                Text("If you renewed the key on the web panel, or your account is open on another phone, paste the key here.")
            }
            .fbFormRow()

            Section {
                if model.hubEnabled {
                    LabeledContent(String(localized: "Server"), value: model.hubURL.host ?? model.hubURL.absoluteString)
                } else {
                    TextField(HubClient.defaultURL.absoluteString, text: $serverText)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .onSubmit {
                            if let url = URL(string: serverText), url.scheme == "https" { model.hubURL = url }
                        }
                }
            } header: {
                Text("Server")
            } footer: {
                if let status = model.hubStatus { Text(status) }
            }
            .fbFormRow()
        }
        .fbFormStyle()
        .navigationTitle(String(localized: "Web access"))
        .navigationBarTitleDisplayMode(.inline)
        .overlay { if model.hubBusy { ProgressView() } }
        .onAppear { serverText = model.hubURL.absoluteString }
        .confirmationDialog(String(localized: "Turn off web access?"), isPresented: $confirmOff, titleVisibility: .visible) {
            Button(String(localized: "Turn off and delete server data"), role: .destructive) { Task { await model.disableWebAccess() } }
        } message: {
            Text("Your account, data and webhooks on the server are deleted for good. Data on this phone stays.")
        }
    }
}

/// Up to five signed https endpoints that get each sync's data.
struct WebhooksView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.modelContext) private var context
    @Query(sort: \Webhook.createdAt) private var hooks: [Webhook]
    @State private var newURL = ""
    @State private var urlError: String?

    var body: some View {
        Form {
            Section {
                Text("After every sync Pulso sends that sync's data to these addresses as JSON. Requests are signed; check them with the secret on the receiving side.")
                    .textStyle(.subhead)
                    .foregroundStyle(.textSecondary)
            }
            .fbFormRow()
            ForEach(hooks) { hook in
                Section {
                    Toggle(isOn: Binding(get: { hook.enabled }, set: { hook.enabled = $0; try? context.save() })) {
                        Text(hook.url).lineLimit(2).textStyle(.subhead)
                    }
                    LabeledContent(String(localized: "Secret")) {
                        Button(String(localized: "Copy")) { UIPasteboard.general.string = hook.secret }
                    }
                    if let status = hook.lastStatus, let at = hook.lastAt {
                        LabeledContent(String(localized: "Last delivery"), value: "\(status), \(FBFormat.time(at))")
                    }
                    Button(String(localized: "Send a test")) { Task { await model.ping(hook) } }
                    Button(String(localized: "Delete webhook"), role: .destructive) {
                        context.delete(hook)
                        try? context.save()
                    }
                }
                .fbFormRow()
            }
            Section {
                TextField("https://", text: $newURL)
                    .keyboardType(.URL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                Button(String(localized: "Add webhook")) { add() }
                    .disabled(newURL.isEmpty || hooks.count >= 5)
            } header: {
                Text("New address")
            } footer: {
                Text(urlError ?? String(localized: "Up to 5 addresses, https:// only. The signature format is in the API docs (Web access › Open API docs)."))
            }
            .fbFormRow()
        }
        .fbFormStyle()
        .navigationTitle(String(localized: "Webhooks"))
        .navigationBarTitleDisplayMode(.inline)
    }

    private func add() {
        let trimmed = newURL.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: trimmed), url.scheme == "https", url.host != nil else {
            urlError = String(localized: "The address must start with https:// and include a domain.")
            return
        }
        context.insert(Webhook(url: url.absoluteString, secret: WebhookSender.newSecret()))
        try? context.save()
        newURL = ""
        urlError = nil
    }
}

/// What Siri and Shortcuts can do with Freeband.
struct ShortcutsView: View {
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: FBSpace.l) {
                ListCard {
                    ListRow(title: String(localized: "Find band"), subtitle: String(localized: "“Find my band with Pulso”"),
                            systemImage: "dot.radiowaves.left.and.right", accessory: .none)
                    ListRow(title: String(localized: "Send to band"), subtitle: String(localized: "“Send a message to my band with Pulso”"),
                            systemImage: "text.bubble", accessory: .none)
                    ListRow(title: String(localized: "Sync band"), subtitle: String(localized: "“Sync my band with Pulso”"),
                            systemImage: "arrow.triangle.2.circlepath", accessory: .none, showsDivider: false)
                }
                Footnote(String(localized: "Shortcuts open Pulso for a moment: the band only talks to the app while it runs."))
                ShortcutsLink()
                    .shortcutsLinkStyle(.automaticOutline)
                    .frame(maxWidth: .infinity)
            }
            .padding(.horizontal, FBSpace.gutter)
            .padding(.bottom, FBSpace.xl)
        }
        .fbScreen()
        .navigationTitle(String(localized: "Shortcuts & Siri"))
        .navigationBarTitleDisplayMode(.inline)
    }
}

/// Claude usage on the band: where the PC script publishes it, and a button to send it now.
struct ClaudeBandView: View {
    @EnvironmentObject private var model: AppModel
    @State private var gistID = ClaudeBand.gistID
    @State private var problem: String?
    @State private var sending = false

    var body: some View {
        Form {
            Section {
                Text("The Claude app on the band shows your 5-hour, weekly and Fable limits and your API credit. A script on your PC publishes them to a secret gist; Pulso reads the gist and sends it to the band.")
                    .textStyle(.subhead)
                    .foregroundStyle(.textSecondary)
            }
            .fbFormRow()

            Section {
                TextField(String(localized: "Gist ID"), text: $gistID)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .onSubmit { ClaudeBand.gistID = gistID }
            } footer: {
                Text("Printed by claude_usage.py --setup.")
            }
            .fbFormRow()

            Section {
                Button(sending ? String(localized: "Sending…") : String(localized: "Show on the band now")) { send(launch: true) }
                    .disabled(sending || gistID.isEmpty)
                Button(String(localized: "Update without opening the app")) { send(launch: false) }
                    .disabled(sending || gistID.isEmpty)
            } footer: {
                ClaudeBandStatus(link: model.link, problem: problem)
            }
            .fbFormRow()

            Section {
                Button(String(localized: "Add the Claude card to the band")) { editCards(add: true) }
                    .disabled(sending)
                Button(String(localized: "Restore the band's original cards")) { editCards(add: false) }
                    .disabled(sending)
                Button(String(localized: "Make Claude first in More (move other apps out)")) { editAppOrder(first: true) }
                    .disabled(sending)
                Button(String(localized: "Restore the band's app order")) { editAppOrder(first: false) }
                    .disabled(sending)
            } header: {
                Text("Experimental")
            } footer: {
                Text("Writes the band's card list the way Mi Fitness does. The original list is saved first; restore puts it back. Check Diagnostics for the band's answer.")
            }
            .fbFormRow()
        }
        .fbFormStyle()
        .navigationTitle(String(localized: "Claude on the band"))
        .navigationBarTitleDisplayMode(.inline)
        .onDisappear { ClaudeBand.gistID = gistID }
    }

    private func editCards(add: Bool) {
        guard let band = model.selectedBand() else {
            problem = String(localized: "There's no band in Pulso yet.")
            return
        }
        problem = nil
        model.editCards(band, addPackage: add ? ClaudeBand.package : nil, name: "Claude")
    }

    private func editAppOrder(first: Bool) {
        guard let band = model.selectedBand() else {
            problem = String(localized: "There's no band in Pulso yet.")
            return
        }
        problem = nil
        model.editAppOrder(band, firstPackage: first ? ClaudeBand.package : nil, name: "Claude")
    }

    private func send(launch: Bool) {
        ClaudeBand.gistID = gistID
        guard let band = model.selectedBand() else {
            problem = String(localized: "There's no band in Pulso yet.")
            return
        }
        sending = true
        Task {
            problem = await model.sendClaudeUsage(to: band, launch: launch)
            sending = false
        }
    }
}

/// The running session's state, or why sending couldn't start.
private struct ClaudeBandStatus: View {
    @ObservedObject var link: BandLink
    let problem: String?

    var body: some View {
        Text(problem ?? link.phase.label)
    }
}
