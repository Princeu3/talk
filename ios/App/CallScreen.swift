import SwiftUI
import WebRTC

// In-app call screen, black in both themes like the web's. CallKit draws the
// ringing and lock-screen UI; this shows once a call is placed or answered.
struct CallScreen: View {
  @Environment(Talk.self) private var talk
  @Environment(Calls.self) private var calls
  let call: CallView
  @State private var chrome = true
  @State private var adding = false

  var body: some View {
    // A group shows its title, or the one other person's name once it's down to two.
    let name = call.group.map { call.tiles.count == 1 ? talk.name(call.tiles[0].id) : $0 } ?? talk.name(call.peer)
    let grid = call.tiles.count > 1 && call.phase != .ended
    let showRemote = !grid && call.phase != .ended && call.remoteCamera && call.remote != nil && call.since != nil
    let showLocal = call.phase != .ended && call.camera && call.local != nil
    ZStack {
      Color.black.ignoresSafeArea()
      if showRemote, let t = call.remote { VideoView(track: t, mirror: false).ignoresSafeArea() }
      if showLocal, let t = call.local {
        if showRemote || grid || call.since != nil {
          VideoView(track: t, mirror: call.front)
            .frame(width: grid ? 90 : 110, height: grid ? 120 : 150).clipShape(.rect(cornerRadius: 16))
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topTrailing)
            .padding(.top, 60).padding(.trailing, 12)
            .zIndex(1)
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
          if showRemote || grid {
            VStack {
              Text(name).font(.headline)
              Text(status).font(.subheadline).monospacedDigit().opacity(0.8)
            }
          } else {
            Label("End-to-end encrypted", systemImage: "lock.fill").font(.caption).opacity(0.7)
          }
          Spacer()
          addButton
        }
        .padding(.horizontal, 8)

        if grid {
          TileGrid(tiles: call.tiles)
        } else {
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
        }

        if call.phase != .ended {
          HStack(spacing: 12) {
            round(call.muted ? "Unmute" : "Mute", call.muted ? "mic.slash.fill" : "mic.fill", pressed: call.muted) { calls.toggleMute() }
            round(call.speaker ? "Turn speaker off" : "Turn speaker on", "speaker.wave.2.fill", pressed: call.speaker) { calls.toggleSpeaker() }
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
    .sheet(isPresented: $adding) { RingSheet(convId: call.convId) } // after the white text, so the sheet keeps the app's colors
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

  // A group call we're in can ring more of the chat.
  @ViewBuilder private var addButton: some View {
    if call.group != nil, call.phase != .incoming, call.phase != .ended {
      Button("Add people", systemImage: "person.badge.plus") { adding = true }
        .labelStyle(.iconOnly).font(.title2).frame(width: 44, height: 44)
    } else {
      Color.clear.frame(width: 44, height: 44)
    }
  }

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
    // A group call is on as soon as we're in it; its timer starts when someone else is.
    if c.group != nil, c.tiles.isEmpty, [.ringing, .connecting, .live].contains(c.phase) { return "Waiting for others…" }
    return switch c.phase {
    case .incoming: Format.callNoun(c.kind, group: c.group != nil)
    case .calling: "Calling…"
    case .ringing: "Ringing…"
    case .connecting: "Connecting…"
    case .reconnecting: "Reconnecting…"
    case .live: Duration.seconds(Date().timeIntervalSince(c.since ?? Date())).formatted(.time(pattern: .minuteSecond))
    case .ended: c.note ?? "Call ended"
    }
  }

  var body: some View {
    let name = call.group ?? talk.name(call.peer)
    TimelineView(.periodic(from: .now, by: 1)) { _ in
      HStack(spacing: 10) {
        Button { calls.minimized = false } label: {
          HStack(spacing: 10) {
            Avatar(name: name, size: 28)
            Text(name).font(.headline).lineLimit(1)
            if call.group != nil { Label("\(call.tiles.count + 1)", systemImage: "person.2.fill").font(.subheadline).monospacedDigit() }
            Text(Self.status(call)).monospacedDigit().opacity(0.8)
            Spacer()
          }
        }
        .accessibilityLabel(call.group == nil ? "Return to call with \(name)" : "Return to call in \(name), \(call.tiles.count + 1) people")
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

// Everyone else in a group call: their video, or their avatar with the camera off.
private struct TileGrid: View {
  @Environment(Talk.self) private var talk
  let tiles: [Tile]

  var body: some View {
    let g = callGrid(tiles.count)
    GeometryReader { geo in
      let h = (geo.size.height - CGFloat(g.rows - 1) * 6) / CGFloat(g.rows)
      ScrollView {
        LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 6), count: g.columns), spacing: 6) {
          ForEach(tiles) { tile($0).frame(height: h) }
        }
      }
      .scrollDisabled(!g.scrolls)
      .scrollBounceBehavior(.basedOnSize)
    }
    .padding(.horizontal, 6)
  }

  private func tile(_ t: Tile) -> some View {
    let name = talk.name(t.id)
    return ZStack(alignment: .bottomLeading) {
      Color.white.opacity(0.1)
      if t.camera, let v = t.video {
        VideoView(track: v, mirror: false)
      } else {
        Avatar(name: name, size: 72).frame(maxWidth: .infinity, maxHeight: .infinity)
      }
      HStack(spacing: 4) {
        if t.muted { Image(systemName: "mic.slash.fill") }
        Text(name).lineLimit(1)
      }
      .font(.footnote.weight(.semibold))
      .padding(.horizontal, 8).padding(.vertical, 4)
      .background(.black.opacity(0.45), in: .capsule)
      .padding(8)
    }
    .clipShape(.rect(cornerRadius: 16))
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(t.muted ? "\(name), muted" : name)
  }
}

// Join on a chat with a group call on (chat list, chat banner), as on the web.
struct JoinPill: View {
  var label = "Join"
  let kind: String
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      Label(label, systemImage: kind == "video" ? "video.fill" : "phone.fill").font(.subheadline.weight(.semibold))
        .padding(.horizontal, 14).padding(.vertical, 6)
        .background(Color.fill, in: .capsule).foregroundStyle(Color.onFill)
    }
    .buttonStyle(.borderless)
  }
}

// Add people: the chat's members who aren't in the call, each rung with a tap.
private struct RingSheet: View {
  @Environment(Talk.self) private var talk
  @Environment(Calls.self) private var calls
  @Environment(\.dismiss) private var dismiss
  let convId: String
  @State private var error: String?

  var body: some View {
    let live = talk.me?.conversations.first { $0.id == convId }?.call
    NavigationStack {
      List {
        let people = outside(live)
        if people.isEmpty { Text("Everyone in this chat is in the call.").foregroundStyle(Color.mut) }
        ForEach(people, id: \.self) { row($0, ringing: live?.ringing?.contains($0) == true) }
        if let error { Text(error).foregroundStyle(Color.danger) }
      }
      .navigationTitle("Add people")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
    }
    .tint(Color.accent)
    .presentationDetents([.medium, .large])
    .presentationBackground(Color.bg) // over the black call screen, the default glass turns grey
  }

  // In the chat, not in the call, by name.
  private func outside(_ live: GroupCall?) -> [String] {
    let conv = talk.me?.conversations.first { $0.id == convId }
    return (conv?.members ?? []).filter { $0 != talk.account.userId && live?.peers.contains($0) != true && talk.user($0)?.deleted != true }
      .sorted { talk.name($0) < talk.name($1) }
  }

  private func row(_ userId: String, ringing: Bool) -> some View {
    HStack(spacing: 12) {
      Avatar(name: talk.name(userId), size: 40)
      Text(talk.name(userId)).foregroundStyle(Color.ink)
      Spacer()
      if ringing {
        Text("Ringing…").font(.subheadline).foregroundStyle(Color.mut)
      } else {
        Button("Ring") { Task { error = await calls.ring(userId) } }
          .buttonStyle(.borderedProminent).buttonBorderShape(.capsule).tint(Color.fill).foregroundStyle(Color.onFill)
      }
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
