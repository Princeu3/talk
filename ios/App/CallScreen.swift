import SwiftUI
import WebRTC

// In-app call screen, black in both themes like the web's. CallKit draws the
// ringing and lock-screen UI; this shows once a call is placed or answered.
struct CallScreen: View {
  @Environment(Talk.self) private var talk
  @Environment(Calls.self) private var calls
  let call: CallView
  @State private var chrome = true

  var body: some View {
    let name = talk.name(call.peer)
    let showRemote = call.phase != .ended && call.remoteCamera && call.remote != nil && call.since != nil
    let showLocal = call.phase != .ended && call.camera && call.local != nil
    ZStack {
      Color.black.ignoresSafeArea()
      if showRemote, let t = call.remote { VideoView(track: t, mirror: false).ignoresSafeArea() }
      if showLocal, let t = call.local {
        if showRemote || call.since != nil {
          VideoView(track: t, mirror: call.front)
            .frame(width: 110, height: 150).clipShape(.rect(cornerRadius: 16))
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topTrailing)
            .padding(.top, 60).padding(.trailing, 12)
        } else {
          VideoView(track: t, mirror: call.front).ignoresSafeArea().opacity(0.6)
        }
      }

      VStack {
        HStack {
          Button("Back to chat", systemImage: "chevron.down") {
            calls.minimized = true
            calls.openChat = call.convId
          }
          .labelStyle(.iconOnly).font(.title2).frame(width: 44, height: 44)
          Spacer()
          if showRemote {
            VStack {
              Text(name).font(.headline)
              Text(status).font(.subheadline).monospacedDigit().opacity(0.8)
            }
          } else {
            Label("End-to-end encrypted", systemImage: "lock.fill").font(.caption).opacity(0.7)
          }
          Spacer()
          Color.clear.frame(width: 44, height: 44)
        }
        .padding(.horizontal, 8)

        Spacer()
        if !showRemote {
          VStack(spacing: 16) {
            Avatar(name: name, size: 120)
            Text(name).font(.largeTitle.weight(.semibold))
            Text(status).font(.title3).monospacedDigit().opacity(0.75)
            if call.remoteMuted && call.phase != .ended { Label("\(name) is muted", systemImage: "mic.slash").font(.subheadline).opacity(0.75) }
          }
        }
        Spacer()

        if call.phase != .ended {
          HStack(spacing: 16) {
            round(call.muted ? "Unmute" : "Mute", call.muted ? "mic.slash.fill" : "mic.fill", pressed: call.muted) { calls.toggleMute() }
            round(call.camera ? "Turn camera off" : "Turn camera on", call.camera ? "video.fill" : "video.slash.fill", pressed: !call.camera) { calls.toggleCamera() }
            if showLocal { round("Switch camera", "arrow.triangle.2.circlepath.camera") { calls.flip() } }
            round("End call", "phone.down.fill", tone: .endCall) { calls.hangup() }
          }
          .padding(10)
          .glassEffect(.regular, in: .capsule)
          .padding(.bottom, 24)
        }
      }
      .opacity(showRemote && !chrome ? 0 : 1)
      .animation(.easeInOut(duration: 0.3), value: chrome)
    }
    .foregroundStyle(.white)
    .contentShape(.rect)
    .onTapGesture { chrome.toggle() }
    .task(id: chrome) {
      // In a video call the controls fade after a few seconds; a tap brings them back.
      guard chrome, showRemote else { return }
      try? await Task.sleep(for: .seconds(4))
      chrome = false
    }
  }

  private var status: String { CallBar.status(call) }

  private func round(_ label: String, _ icon: String, pressed: Bool = false, tone: Color = .white.opacity(0.15), action: @escaping () -> Void) -> some View {
    Button(label, systemImage: icon, action: action)
      .labelStyle(.iconOnly).font(.title2)
      .frame(width: 60, height: 60)
      .background(pressed ? .white : tone, in: .circle)
      .foregroundStyle(pressed ? .black : .white)
  }
}

// The minimized call: a bar above the app, like a phone's in-call banner.
struct CallBar: View {
  @Environment(Talk.self) private var talk
  @Environment(Calls.self) private var calls
  let call: CallView

  static func status(_ c: CallView) -> String {
    switch c.phase {
    case .incoming: c.kind == "video" ? "Video call" : "Voice call"
    case .calling: "Calling…"
    case .ringing: "Ringing…"
    case .connecting: "Connecting…"
    case .reconnecting: "Reconnecting…"
    case .live: Duration.seconds(Date().timeIntervalSince(c.since ?? Date())).formatted(.time(pattern: .minuteSecond))
    case .ended: c.note ?? "Call ended"
    }
  }

  var body: some View {
    TimelineView(.periodic(from: .now, by: 1)) { _ in
      HStack(spacing: 10) {
        Button { calls.minimized = false } label: {
          HStack(spacing: 10) {
            Avatar(name: talk.name(call.peer), size: 28)
            Text(talk.name(call.peer)).font(.headline).lineLimit(1)
            Text(Self.status(call)).monospacedDigit().opacity(0.8)
            Spacer()
          }
        }
        .accessibilityLabel("Return to call with \(talk.name(call.peer))")
        if call.phase != .ended {
          Button(call.muted ? "Unmute" : "Mute", systemImage: call.muted ? "mic.slash.fill" : "mic.fill") { calls.toggleMute() }
            .labelStyle(.iconOnly).frame(width: 44, height: 44)
          Button("End call", systemImage: "phone.down.fill") { calls.hangup() }
            .labelStyle(.iconOnly).frame(width: 44, height: 44)
            .background(Color.endCall, in: .circle).foregroundStyle(.white)
        }
      }
      .padding(.horizontal, 12).padding(.vertical, 6)
      .background(Color.fill)
      .foregroundStyle(Color.onFill)
    }
  }
}

private struct VideoView: UIViewRepresentable {
  let track: RTCVideoTrack
  let mirror: Bool

  func makeUIView(context: Context) -> RTCMTLVideoView {
    let v = RTCMTLVideoView()
    v.videoContentMode = .scaleAspectFill
    track.add(v)
    context.coordinator.track = track
    return v
  }

  func updateUIView(_ v: RTCMTLVideoView, context: Context) {
    if context.coordinator.track !== track {
      context.coordinator.track?.remove(v)
      track.add(v)
      context.coordinator.track = track
    }
    v.transform = mirror ? CGAffineTransform(scaleX: -1, y: 1) : .identity
  }

  static func dismantleUIView(_ v: RTCMTLVideoView, coordinator: Coordinator) { coordinator.track?.remove(v) }

  func makeCoordinator() -> Coordinator { Coordinator() }
  final class Coordinator { var track: RTCVideoTrack? }
}
