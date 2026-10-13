import SwiftData
import SwiftUI

@main
struct FreebandApp: App {
    private let container: ModelContainer
    @StateObject private var model: AppModel

    init() {
        let container: ModelContainer
        do {
            container = try ModelContainer(for: Band.self, Sample.self, Webhook.self)
        } catch {
            fatalError("Veri deposu açılamadı: \(error)")
        }
        self.container = container
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("-freeband-demo") { DemoData.seed(container.mainContext) }
        #endif
        _model = StateObject(wrappedValue: AppModel(context: container.mainContext))
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(model)
                .environmentObject(model.link)
                .tint(Theme.ink)
                .preferredColorScheme(.dark)
                .font(Theme.body)
        }
        .modelContainer(container)
    }
}

struct RootView: View {
    @AppStorage("onboarded") private var onboarded = false
    @EnvironmentObject private var model: AppModel
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        Group {
            if onboarded {
                TabView {
                    TodayView()
                        .tabItem { Label("Bugün", systemImage: "circle.dashed") }
                    SleepView()
                        .tabItem { Label("Uyku", systemImage: "moon") }
                    HistoryView()
                        .tabItem { Label("Geçmiş", systemImage: "calendar") }
                    SettingsView()
                        .tabItem { Label("Ayarlar", systemImage: "slider.horizontal.3") }
                }
                .sheet(item: $model.pendingInvite) { JoinSheet(invite: $0) }
            } else {
                OnboardingView()
            }
        }
        .onOpenURL { model.handle($0) }
        // Live mode keeps the band measuring; never leave it running in the background.
        .onChange(of: scenePhase) { _, phase in
            if phase == .background { model.stop() }
        }
    }
}
