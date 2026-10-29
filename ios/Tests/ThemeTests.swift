import SwiftUI
import Testing

@Test @MainActor func themeColorsResolveOffMainThread() async {
  // UIKit/SwiftUI can resolve dynamic colors on rendering workers.
  // Match the app's MainActor default so an inherited actor assertion regresses here.
  let colors = [Color.bg, .surface, .raised, .ink, .mut, .accent, .fill,
                .onFill, .mine, .bubble, .danger].map { UIColor($0) }
  await Task.detached {
    for style in [UIUserInterfaceStyle.light, .dark] {
      let traits = UITraitCollection(userInterfaceStyle: style)
      for color in colors {
        let resolved = color.resolvedColor(with: traits)
        var red: CGFloat = 0, green: CGFloat = 0, blue: CGFloat = 0, alpha: CGFloat = 0
        #expect(resolved.getRed(&red, green: &green, blue: &blue, alpha: &alpha))
        #expect(alpha > 0)
      }
    }
  }.value
}
