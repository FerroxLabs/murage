import SwiftUI
import UIKit

/// Readable columns for the phone-first surfaces when they run in a wider
/// iPad window. Compact windows naturally remain narrower than these caps.
enum CompanionLayout {
    static let rosterWidth: CGFloat = 680
    static let chatWidth: CGFloat = 760
    static let headerWidth: CGFloat = 900

    /// The expanding island animation is anchored to iPhone hardware. On an
    /// iPad it reads as an unexplained floating black card.
    static var supportsIslandPresentation: Bool {
        UIDevice.current.userInterfaceIdiom == .phone
    }
}
