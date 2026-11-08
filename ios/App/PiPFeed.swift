import WebRTC

// Puts PiP's renderer on the track it shows while the window is up, and only then, so frames are
// converted only while it shows. It follows the track: a camera back on, or video that came late.
final class PiPFeed {
  private let renderer: RTCVideoRenderer
  private var on: RTCVideoTrack? // the track the renderer is on
  var track: RTCVideoTrack? { didSet { sync() } }
  var up = false { didSet { sync() } }

  init(_ renderer: RTCVideoRenderer) { self.renderer = renderer }

  private func sync() {
    let want = up ? track : nil
    guard want !== on else { return }
    on?.remove(renderer)
    want?.add(renderer)
    on = want
  }
}
