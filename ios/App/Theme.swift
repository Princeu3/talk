import SwiftUI

// The web palette (src/styles.css): soft white, sage, deep olive, split
// 60/30/10. Each token holds both themes.
extension Color {
  private static func pair(_ light: UInt32, _ dark: UInt32, alpha: Double = 1) -> Color {
    Color(UIColor { $0.userInterfaceStyle == .dark ? .hex(dark, alpha) : .hex(light, alpha) })
  }
  static let bg = pair(0xe8e9df, 0x12170f)
  static let surface = pair(0xf3f4ee, 0x1a2116)
  static let raised = pair(0xdadecd, 0x263020)
  static let ink = pair(0x1e2819, 0xe8e9df)
  static let mut = pair(0x1e2819, 0xe8e9df, alpha: 0.68)
  static let accent = pair(0x2e3d28, 0xa9b887)
  static let fill = pair(0x2e3d28, 0xa9b887)
  static let onFill = pair(0xf3f4ee, 0x12170f)
  static let mine = pair(0xa9b887, 0x3e5034)
  static let bubble = pair(0xfafaf6, 0x222b1d)
  static let danger = pair(0xa3352d, 0xf0998e)
  // Call screens are black in both themes; these are the universal call colors.
  static let endCall = Color(UIColor.hex(0xe5484d))
  static let acceptCall = Color(UIColor.hex(0x30a46c))
}

extension UIColor {
  static func hex(_ v: UInt32, _ alpha: Double = 1) -> UIColor {
    UIColor(red: CGFloat(v >> 16 & 0xff) / 255, green: CGFloat(v >> 8 & 0xff) / 255, blue: CGFloat(v & 0xff) / 255, alpha: alpha)
  }
}

// Generative art seeded by the name, the same math as Avatar in
// src/components/Sidebar.tsx, so a person looks the same on the web and here.
struct Avatar: View {
  let name: String
  var size: CGFloat = 44
  private static let shades: [UInt32] = [0x2e3d28, 0x4f6340, 0x7e9466, 0xa9b887, 0xcdd6b8, 0xe8e9df]

  var body: some View {
    Canvas { ctx, sz in
      var h = avatarSeed(name)
      func next(_ n: UInt32) -> CGFloat {
        h = (h ^ (h >> 15)) &* 2246822507
        return CGFloat(h % n)
      }
      var pool = Self.shades
      let bg = pool.remove(at: 1 + Int(next(4)))
      let block = pool.remove(at: Int(next(UInt32(pool.count))))
      let dot = pool.remove(at: Int(next(UInt32(pool.count))))
      let bar = pool.remove(at: Int(next(UInt32(pool.count))))
      let color = { (v: UInt32) in GraphicsContext.Shading.color(Color(UIColor.hex(v))) }

      ctx.scaleBy(x: sz.width / 80, y: sz.height / 80)
      ctx.fill(Path(CGRect(x: 0, y: 0, width: 80, height: 80)), with: color(bg))
      let rect = CGRect(x: 10 + next(20), y: -10 + next(30), width: 40 + next(30), height: 40 + next(30))
      let radius: CGFloat = next(2) > 0 ? 40 : 4
      let turn = next(360)
      var r = ctx
      r.translateBy(x: 40, y: 40)
      r.rotate(by: .degrees(turn))
      r.translateBy(x: -40, y: -40)
      r.fill(Path(roundedRect: rect, cornerRadius: min(radius, rect.width / 2, rect.height / 2)), with: color(block))
      let c = CGPoint(x: 20 + next(40), y: 20 + next(40))
      let rad = 10 + next(12)
      ctx.fill(Path(ellipseIn: CGRect(x: c.x - rad, y: c.y - rad, width: rad * 2, height: rad * 2)), with: color(dot))
      let y1 = 30 + next(20), y2 = 30 + next(20), width = 3 + next(4)
      var l = ctx
      l.translateBy(x: 40, y: 40)
      l.rotate(by: .degrees(next(180)))
      l.translateBy(x: -40, y: -40)
      var line = Path()
      line.move(to: CGPoint(x: -10, y: y1))
      line.addLine(to: CGPoint(x: 90, y: y2))
      l.stroke(line, with: color(bar), lineWidth: width)
    }
    .frame(width: size, height: size)
    .clipShape(.circle)
    .accessibilityHidden(true)
  }
}
