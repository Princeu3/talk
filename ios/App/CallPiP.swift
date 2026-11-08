import AVKit
import Combine
import SwiftUI
import WebRTC

// Picture in Picture for video calls (developer.apple.com, "Adopting Picture in Picture for video calls"):
// the call keeps showing in a floating window over other apps or the chat list, and while it shows, iOS
// keeps our camera running (Calls turns on multitasking camera access), so the other side's video of us
// doesn't freeze. It starts on its own when the app goes to the background, and from Back to chat.
final class CallPiP: NSObject, AVPictureInPictureControllerDelegate {
  static let shared = CallPiP()

  private let content = AVPictureInPictureVideoCallViewController()
  private let video = PiPVideoView()
  private let fallback = UIHostingController(rootView: PiPFallback(name: ""))
  private var controller: AVPictureInPictureController?
  private var anchor: UIView?
  private var track: RTCVideoTrack? // what PiP shows: the first person with their camera on
  private var shown: RTCVideoTrack? // what the renderer is on, only while PiP is up
  private var pending = false // Back to chat: start once the call bar is the source
  private var possible: AnyCancellable?

  override init() {
    super.init()
    content.preferredContentSize = CGSize(width: 1080, height: 1920)
    fallback.view.backgroundColor = .black
    for v in [fallback.view!, video] {
      v.frame = content.view.bounds
      v.autoresizingMask = [.flexibleWidth, .flexibleHeight]
      content.view.addSubview(v)
    }
  }

  // The call screen or call bar entered the window: PiP grows from it and returns to it.
  func claim(_ view: UIView, full: Bool) {
    guard anchor !== view, AVPictureInPictureController.isPictureInPictureSupported() else { return }
    anchor = view
    let source = AVPictureInPictureController.ContentSource(activeVideoCallSourceView: view, contentViewController: content)
    if let controller {
      controller.contentSource = source
    } else {
      let c = AVPictureInPictureController(contentSource: source)
      c.delegate = self
      possible = c.publisher(for: \.isPictureInPicturePossible).sink { [weak self] ok in
        guard ok, let self, self.pending else { return }
        self.pending = false
        self.controller?.startPictureInPicture()
      }
      controller = c
    }
    // Back in the full call screen: the floating window isn't needed.
    if full {
      pending = false
      if controller?.isPictureInPictureActive == true { controller?.stopPictureInPicture() }
    } else if pending, controller?.isPictureInPicturePossible == true {
      pending = false
      controller?.startPictureInPicture()
    }
  }

  // What PiP shows; `enabled` is false once there's no video either way, or the call is over.
  func show(track: RTCVideoTrack?, name: String, enabled: Bool) {
    controller?.canStartPictureInPictureAutomaticallyFromInline = enabled
    guard enabled else { return stop() }
    fallback.rootView = PiPFallback(name: name)
    video.isHidden = track == nil
    guard self.track !== track else { return }
    self.track = track
    if shown != nil { attach() }
  }

  // Float the other person's video over the chat list, as the call goes to the bar.
  func startSoon() {
    guard track != nil else { return }
    pending = true
  }

  // The call is gone (its screen and bar too).
  func stop() {
    pending = false
    controller?.canStartPictureInPictureAutomaticallyFromInline = false
    if controller?.isPictureInPictureActive == true { controller?.stopPictureInPicture() }
    track = nil
    detach()
  }

  // Frames are converted only while the window shows.
  private func attach() {
    detach()
    track?.add(video.renderer)
    shown = track
  }

  private func detach() {
    shown?.remove(video.renderer)
    shown = nil
  }

  func pictureInPictureControllerWillStartPictureInPicture(_ c: AVPictureInPictureController) { attach() }
  func pictureInPictureControllerDidStopPictureInPicture(_ c: AVPictureInPictureController) { detach() }
  func pictureInPictureController(_ c: AVPictureInPictureController, failedToStartPictureInPictureWithError error: Error) {
    print("[pip]", error)
    detach()
  }
  // Tapped to go back: open the full call screen.
  func pictureInPictureController(_ c: AVPictureInPictureController, restoreUserInterfaceForPictureInPictureStopWithCompletionHandler done: @escaping (Bool) -> Void) {
    Calls.shared.minimized = false
    done(true)
  }
}

// Where PiP grows from: the call screen, or the call bar while minimized. Also feeds it what to show.
struct PiPAnchor: UIViewRepresentable {
  @Environment(Talk.self) private var talk
  let call: CallView
  let full: Bool

  func makeUIView(context: Context) -> AnchorView {
    let v = AnchorView(full: full)
    v.isUserInteractionEnabled = false
    return v
  }

  func updateUIView(_ v: AnchorView, context: Context) {
    let tile = call.tiles.first { $0.camera && $0.video != nil }
    let name = tile.map { talk.name($0.id) } ?? call.group ?? talk.name(call.peer)
    let on = call.phase != .ended && call.phase != .incoming && (call.camera || call.tiles.contains { $0.camera })
    CallPiP.shared.show(track: tile?.video, name: name, enabled: on)
  }

  // The bar replaces the screen and back again; only a call that's over takes PiP down.
  static func dismantleUIView(_ v: AnchorView, coordinator: ()) {
    if Calls.shared.current == nil { CallPiP.shared.stop() }
  }

  final class AnchorView: UIView {
    let full: Bool
    init(full: Bool) {
      self.full = full
      super.init(frame: .zero)
    }
    required init?(coder: NSCoder) { fatalError() }
    override func didMoveToWindow() {
      if window != nil { CallPiP.shared.claim(self, full: full) }
    }
  }
}

// Camera off: who it is, as on the call screen.
private struct PiPFallback: View {
  let name: String
  var body: some View {
    VStack(spacing: 12) {
      Avatar(name: name, size: 96)
      Text(name).font(.title2.weight(.semibold)).foregroundStyle(.white).lineLimit(1)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(.black)
  }
}

// PiP can't show Metal views drawn by a backgrounded app, so remote video goes through an
// AVSampleBufferDisplayLayer, turned by the frame's rotation the way RTCMTLVideoView does.
final class PiPVideoView: UIView {
  private let display = AVSampleBufferDisplayLayer()
  private var rotation = RTCVideoRotation._0
  lazy var renderer = PiPRenderer(display: display) { [weak self] r in
    Task { @MainActor in
      self?.rotation = r
      self?.setNeedsLayout()
    }
  }

  override init(frame: CGRect) {
    super.init(frame: frame)
    backgroundColor = .black
    display.videoGravity = .resizeAspectFill
    layer.addSublayer(display)
  }
  required init?(coder: NSCoder) { fatalError() }

  override func layoutSubviews() {
    super.layoutSubviews()
    let quarter = rotation == ._90 || rotation == ._270
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    display.setAffineTransform(.identity)
    display.bounds = CGRect(x: 0, y: 0, width: quarter ? bounds.height : bounds.width, height: quarter ? bounds.width : bounds.height)
    display.position = CGPoint(x: bounds.midX, y: bounds.midY)
    display.setAffineTransform(CGAffineTransform(rotationAngle: CGFloat(rotation.rawValue) * .pi / 180))
    CATransaction.commit()
  }
}

// Called on WebRTC's decode thread, one frame at a time.
nonisolated final class PiPRenderer: NSObject, RTCVideoRenderer {
  private nonisolated(unsafe) let display: AVSampleBufferDisplayLayer
  private nonisolated(unsafe) var rotation = RTCVideoRotation._0
  private let rotated: @Sendable (RTCVideoRotation) -> Void

  init(display: AVSampleBufferDisplayLayer, rotated: @escaping @Sendable (RTCVideoRotation) -> Void) {
    self.display = display
    self.rotated = rotated
  }

  func setSize(_ size: CGSize) {}

  func renderFrame(_ frame: RTCVideoFrame?) {
    guard let frame, let pb = Self.pixelBuffer(frame.buffer), let sample = Self.sample(pb) else { return }
    if frame.rotation != rotation {
      rotation = frame.rotation
      rotated(rotation)
    }
    let r = display.sampleBufferRenderer
    if r.status == .failed { r.flush() } // the layer fails after a trip to the background
    r.enqueue(sample)
  }

  // Hardware-decoded frames (H.264) are pixel buffers already; software ones (VP8 from a browser)
  // come as I420, which the layer can't show, so copy them into NV12.
  // shortcut: a new buffer per frame, only while PiP shows; move to a CVPixelBufferPool if it shows up in CPU traces.
  private static func pixelBuffer(_ b: RTCVideoFrameBuffer) -> CVPixelBuffer? {
    if let b = b as? RTCCVPixelBuffer { return b.pixelBuffer }
    let i = b.toI420()
    var out: CVPixelBuffer?
    let attrs = [kCVPixelBufferIOSurfacePropertiesKey: [:]] as CFDictionary
    CVPixelBufferCreate(nil, Int(i.width), Int(i.height), kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange, attrs, &out)
    guard let out else { return nil }
    CVPixelBufferLockBaseAddress(out, [])
    defer { CVPixelBufferUnlockBaseAddress(out, []) }
    guard let y = CVPixelBufferGetBaseAddressOfPlane(out, 0)?.assumingMemoryBound(to: UInt8.self),
          let uv = CVPixelBufferGetBaseAddressOfPlane(out, 1)?.assumingMemoryBound(to: UInt8.self) else { return nil }
    let ys = CVPixelBufferGetBytesPerRowOfPlane(out, 0), uvs = CVPixelBufferGetBytesPerRowOfPlane(out, 1)
    for r in 0..<Int(i.height) { memcpy(y + r * ys, i.dataY + r * Int(i.strideY), Int(i.width)) }
    for r in 0..<Int(i.chromaHeight) {
      let d = uv + r * uvs, u = i.dataU + r * Int(i.strideU), v = i.dataV + r * Int(i.strideV)
      for c in 0..<Int(i.chromaWidth) {
        d[2 * c] = u[c]
        d[2 * c + 1] = v[c]
      }
    }
    return out
  }

  private static func sample(_ pb: CVPixelBuffer) -> CMSampleBuffer? {
    var format: CMFormatDescription?
    CMVideoFormatDescriptionCreateForImageBuffer(allocator: nil, imageBuffer: pb, formatDescriptionOut: &format)
    guard let format else { return nil }
    var timing = CMSampleTimingInfo(duration: .invalid, presentationTimeStamp: CMClockGetTime(CMClockGetHostTimeClock()), decodeTimeStamp: .invalid)
    var sample: CMSampleBuffer?
    CMSampleBufferCreateReadyWithImageBuffer(allocator: nil, imageBuffer: pb, formatDescription: format, sampleTiming: &timing, sampleBufferOut: &sample)
    guard let sample, let list = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: true), CFArrayGetCount(list) > 0 else { return nil }
    // Live video: show each frame as it comes, with no clock to schedule against.
    let d = unsafeBitCast(CFArrayGetValueAtIndex(list, 0), to: CFMutableDictionary.self)
    CFDictionarySetValue(d, Unmanaged.passUnretained(kCMSampleAttachmentKey_DisplayImmediately).toOpaque(), Unmanaged.passUnretained(kCFBooleanTrue).toOpaque())
    return sample
  }
}
