import type { CapacitorConfig } from "@capacitor/cli";

// Capacitor runs ONLY the bundled launcher (spec §2). The workspace is our own
// WebView and never sees Capacitor's bridge.
const config: CapacitorConfig = {
  appId: "com.murage.mobile",
  appName: "Murage",
  webDir: "dist",
  loggingBehavior: "none",
  server: { androidScheme: "https" },
  // handleApplicationNotifications: false keeps Capacitor from making its
  // NotificationRouter the UNUserNotificationCenter delegate when the launcher
  // loads. It did, after PushSetup.launch() had set PushResponder, so a
  // notification tap never reached PushResponder (no Capacitor push plugin
  // answers it) and the iPhone stayed on the chat it showed (device, 2026-09-28).
  ios: { contentInset: "never", webContentsDebuggingEnabled: false, handleApplicationNotifications: false },
  android: { allowMixedContent: false, webContentsDebuggingEnabled: false },
  // The launcher never uses either, and both reach the shared cookie jars
  // (CapacitorCookies can clear WKWebsiteDataStore.default(); CapacitorHttp
  // sends requests through HTTPCookieStorage.shared). Off, the launcher's
  // fetch and document.cookie stay unpatched. This is not the protection: on
  // iOS the workspace keeps its own data store (P15), and Android's
  // CapacitorCookies.load() clears session cookies whatever this says.
  plugins: { CapacitorCookies: { enabled: false }, CapacitorHttp: { enabled: false } },
};

export default config;
