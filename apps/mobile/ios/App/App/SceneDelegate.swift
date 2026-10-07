import Capacitor
import MurageShell
import UIKit

/// Builds the window in code (no Main storyboard): the launcher is the root,
/// and the "Switch computer" shortcut returns to it on a cold or warm launch.
class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?
    private var coverWindow: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }
        if connectionOptions.shortcutItem?.type == ShellCoordinator.switchShortcut {
            ShellCoordinator.shared.launcherRequested = true
        }
        #if DEBUG
        ShellCoordinator.shared.applyDebugArguments(ProcessInfo.processInfo.arguments)
        #endif
        window = UIWindow(windowScene: windowScene)
        window?.backgroundColor = ShellColors.canvas
        window?.rootViewController = MobileViewController()
        window?.makeKeyAndVisible()
        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
    }

    func windowScene(_ windowScene: UIWindowScene, performActionFor shortcutItem: UIApplicationShortcutItem, completionHandler: @escaping (Bool) -> Void) {
        guard shortcutItem.type == ShellCoordinator.switchShortcut else { completionHandler(false); return }
        ShellCoordinator.shared.showLauncher()
        completionHandler(true)
    }

    func sceneWillResignActive(_ scene: UIScene) {
        guard coverWindow == nil, let windowScene = scene as? UIWindowScene else { return }
        // Its own window above alerts, so nothing presented while the app is inactive
        // (a push tap from the lock screen, a permission prompt) can land over it.
        let coverWindow = UIWindow(windowScene: windowScene)
        coverWindow.windowLevel = .alert + 1
        coverWindow.backgroundColor = ShellColors.canvas
        let cover = UIView()
        cover.frame = coverWindow.bounds
        cover.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        cover.backgroundColor = ShellColors.canvas
        cover.isOpaque = true
        cover.accessibilityViewIsModal = true
        coverWindow.addSubview(cover)
        coverWindow.isHidden = false
        self.coverWindow = coverWindow
    }

    func sceneDidBecomeActive(_ scene: UIScene) {
        coverWindow?.isHidden = true
        coverWindow = nil
        PushSetup.becameActive()
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }
}
