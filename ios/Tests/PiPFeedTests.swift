import Testing
import WebRTC

// While PiP is up, its renderer follows the video it shows. Their camera going off
// (or pausing while their phone is locked) and back on left the window on a frozen frame.
@MainActor
struct PiPFeedTests {
  nonisolated final class Frames: NSObject, RTCVideoRenderer {
    nonisolated(unsafe) var count = 0
    func setSize(_ size: CGSize) {}
    func renderFrame(_ frame: RTCVideoFrame?) { count += 1 }
  }

  let factory: RTCPeerConnectionFactory = {
    RTCInitializeSSL()
    return RTCPeerConnectionFactory()
  }()

  @Test func followsTheirCameraBackOn() {
    let source = factory.videoSource()
    let track = factory.videoTrack(with: source, trackId: "video")
    let capturer = RTCVideoCapturer(delegate: source)
    var ns: Int64 = 0
    // A source hands each frame straight to the renderers on the track.
    func send() {
      ns += 33_000_000
      source.capturer(capturer, didCapture: RTCVideoFrame(buffer: RTCI420Buffer(width: 16, height: 16), rotation: ._0, timeStampNs: ns))
    }
    let frames = Frames()
    let feed = PiPFeed(frames)

    feed.track = track
    send()
    #expect(frames.count == 0) // the window isn't up: nothing is converted
    feed.up = true
    send()
    #expect(frames.count == 1)
    feed.track = nil // camera off: the window shows who it is
    send()
    #expect(frames.count == 1)
    feed.track = track // camera back on
    send()
    #expect(frames.count == 2)
    feed.up = false
    send()
    #expect(frames.count == 2)
  }

  @Test func picksUpVideoThatArrivesAfterTheWindowIsUp() {
    let source = factory.videoSource()
    let track = factory.videoTrack(with: source, trackId: "video")
    let capturer = RTCVideoCapturer(delegate: source)
    let frames = Frames()
    let feed = PiPFeed(frames)

    feed.up = true // went home before their video arrived
    feed.track = track
    source.capturer(capturer, didCapture: RTCVideoFrame(buffer: RTCI420Buffer(width: 16, height: 16), rotation: ._0, timeStampNs: 33_000_000))
    #expect(frames.count == 1)
  }
}
