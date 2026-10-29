import Intents
import SwiftUI
import UserNotifications

@main
struct TalkApp: App {
  @UIApplicationDelegateAdaptor private var delegate: AppDelegate
  @State private var talk: Talk? = Vault.load().map { Talk(account: $0) }
  @Environment(\.scenePhase) private var phase
  private let calls = Calls.shared

  var body: some Scene {
    WindowGroup {
      Group {
        if let talk {
          Main().environment(talk)
        } else {
          SignInView { signedIn($0) }
        }
      }
      .environment(calls)
      .onAppear { if let talk { start(talk) } }
      .onChange(of: phase) { _, p in talk?.setActive(p == .active) }
      // Calling back from Recents or Siri.
      .onContinueUserActivity("INStartCallIntent") { activity in
        guard let talk, let intent = activity.interaction?.intent as? INStartCallIntent,
              let peer = intent.contacts?.first?.personHandle?.value,
              let conv = talk.me?.conversations.first(where: { $0.kind == "dm" && $0.members.contains(peer) }) else { return }
        calls.start(convId: conv.id, peer: peer, kind: intent.callCapability == .videoCall ? "video" : "audio")
      }
    }
  }

  private func signedIn(_ account: Account) {
    let t = Talk(account: account)
    talk = t
    start(t)
  }

  private func start(_ t: Talk) {
    t.onSignedOut = {
      Vault.clear()
      calls.detach()
      talk = nil
    }
    calls.attach(t)
    delegate.talk = t
    t.start(active: phase == .active)
    Task { @MainActor in
      let ok = (try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])) ?? false
      if ok { UIApplication.shared.registerForRemoteNotifications() }
    }
  }
}

private struct Main: View {
  @Environment(Talk.self) private var talk
  @Environment(Calls.self) private var calls

  var body: some View {
    let showScreen = calls.current.map { $0.phase != .incoming && !calls.minimized } ?? false
    ChatsView()
      .safeAreaInset(edge: .top, spacing: 0) {
        if let c = calls.current, calls.minimized { CallBar(call: c) }
      }
      .fullScreenCover(isPresented: .constant(showScreen)) {
        if let c = calls.current { CallScreen(call: c).environment(talk).environment(calls) }
      }
      .onChange(of: talk.totalUnread) { _, n in UNUserNotificationCenter.current().setBadgeCount(n) }
      #if DEBUG
      // `-demoCall <name>` launch argument: show a call with that person, for App Store screenshots.
      .task(id: talk.me == nil) {
        guard let name = UserDefaults.standard.string(forKey: "demoCall"), let me = talk.me,
              let u = me.users.first(where: { $0.name == name }),
              let c = me.conversations.first(where: { $0.kind == "dm" && $0.members.contains(u.id) }) else { return }
        calls.demo(convId: c.id, peer: u.id)
      }
      #endif
  }
}

final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
  var talk: Talk?

  func application(_ app: UIApplication, didFinishLaunchingWithOptions _: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
    Calls.shared.registerForVoIP()
    UNUserNotificationCenter.current().delegate = self
    return true
  }

  func application(_ app: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken token: Data) {
    talk?.registerDevice(token: token, kind: "alert")
  }

  // The open app shows new messages itself.
  func userNotificationCenter(_ c: UNUserNotificationCenter, willPresent n: UNNotification) async -> UNNotificationPresentationOptions {
    let convId = n.request.content.userInfo["convId"] as? String
    return convId != nil && convId == talk?.activeId ? [] : [.banner, .sound]
  }

  func userNotificationCenter(_ c: UNUserNotificationCenter, didReceive r: UNNotificationResponse) async {
    if let convId = r.notification.request.content.userInfo["convId"] as? String { Calls.shared.openChat = convId }
  }
}
