import Capacitor
import MurageShell
import UIKit

/// The launcher: Capacitor's view controller, showing only the bundled page.
final class MobileViewController: CAPBridgeViewController {
    private var launched = false

    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(ShellPlugin())
        view.backgroundColor = ShellColors.canvas
        bridge?.webView?.isOpaque = false
        bridge?.webView?.backgroundColor = ShellColors.canvas
        bridge?.webView?.scrollView.backgroundColor = ShellColors.canvas
        ShellCoordinator.shared.launcher = self
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        guard !launched else { return }
        launched = true
        ShellCoordinator.shared.launchIfNeeded()
    }
}
