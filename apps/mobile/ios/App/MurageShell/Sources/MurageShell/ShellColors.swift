#if os(iOS)
import UIKit

/// The launch canvas (Assets.xcassets LaunchCanvas, styles.css --color-app),
/// behind every WebView so a load never flashes white.
public enum ShellColors {
    public static let canvas = UIColor { traits in
        traits.userInterfaceStyle == .dark ? UIColor(white: 10 / 255, alpha: 1) : UIColor(white: 247 / 255, alpha: 1)
    }
    public static let ink = UIColor { traits in
        traits.userInterfaceStyle == .dark ? UIColor(white: 245 / 255, alpha: 1) : UIColor(white: 13 / 255, alpha: 1)
    }
    public static let inkSecondary = UIColor { traits in
        traits.userInterfaceStyle == .dark ? UIColor(white: 168 / 255, alpha: 1) : UIColor(white: 85 / 255, alpha: 1)
    }
    public static let accent = UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 1, green: 107 / 255, blue: 53 / 255, alpha: 1)
            : UIColor(red: 184 / 255, green: 72 / 255, blue: 31 / 255, alpha: 1)
    }
    /// Ink on a filled accent (styles.css --color-accent-ink / white on light).
    public static let accentInk = UIColor { traits in
        traits.userInterfaceStyle == .dark ? UIColor(red: 42 / 255, green: 18 / 255, blue: 7 / 255, alpha: 1) : .white
    }
    /// styles.css --color-card.
    public static let card = UIColor { traits in
        traits.userInterfaceStyle == .dark ? UIColor(white: 31 / 255, alpha: 1) : .white
    }
}
#endif
