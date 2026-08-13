// Pure desktop capability detection shared by Electron main tests and the
// renderer contract. Keep this file free of Electron imports so every branch
// is deterministic and unit-testable.

const DESKTOP_PLATFORMS = new Set(["darwin", "linux", "win32"]);

function normalizedPlatform(platform) {
  return DESKTOP_PLATFORMS.has(platform) ? platform : "other";
}

function linuxSession(platform, env) {
  if (platform !== "linux") return "unknown";
  const declared = String(env.XDG_SESSION_TYPE ?? "").toLowerCase();
  if (declared === "wayland") return "wayland";
  if (declared === "x11" || declared === "xorg") return "x11";
  // A Wayland user session may also expose DISPLAY for XWayland. Prefer the
  // Wayland signal so the UI never bypasses portal-mediated behavior.
  if (env.WAYLAND_DISPLAY) return "wayland";
  if (env.DISPLAY) return "x11";
  return "headless";
}

function localComputerReady(platform, connection) {
  if (platform === "darwin") {
    return connection?.mode === "embedded" || connection?.mode === "standalone";
  }
  return (
    platform === "linux" &&
    connection?.schemaVersion === 1 &&
    connection?.mode === "linux-x11-supervised" &&
    connection?.platform === "linux" &&
    connection?.session === "x11" &&
    connection?.enabled === true &&
    connection?.status === "ready"
  );
}

function desktopCapabilities({
  platform = process.platform,
  env = process.env,
  packaged = false,
  localConnection = null,
  homeDir = require("node:os").homedir(),
} = {}) {
  const hostPlatform = normalizedPlatform(platform);
  const isMac = hostPlatform === "darwin";
  const hostSession = linuxSession(hostPlatform, env);
  const linuxPreview = hostPlatform === "linux" && hostSession !== "headless";
  const localAvailable = localComputerReady(hostPlatform, localConnection);
  const screenPreview = {
    available: isMac || linuxPreview,
    interaction:
      isMac || hostSession === "x11"
        ? "direct"
        : hostSession === "wayland"
          ? "portal-picker"
          : "none",
  };
  if (!(isMac || linuxPreview)) {
    screenPreview.reasonCode =
      hostPlatform === "linux" ? "headless-session" : "unsupported-platform";
  }
  const dictation = {
    available: isMac,
    engine: isMac ? "apple-speech" : "none",
    onDevice: isMac,
  };
  if (!isMac) dictation.reasonCode = "unsupported-platform";
  const localComputer = {
    available: localAvailable,
    support:
      localAvailable && hostPlatform === "linux"
        ? "limited"
        : localAvailable
          ? "supported"
          : "unsupported",
    enabled: connectionEnabled(hostPlatform, localConnection),
    status: localAvailable ? "ready" : localConnection?.status ?? "unavailable",
  };
  if (typeof localConnection?.message === "string") {
    localComputer.message = localConnection.message;
  }
  if (typeof localConnection?.driver?.path === "string") {
    localComputer.driverPath = localConnection.driver.path;
  }
  if (typeof localConnection?.driver?.version === "string") {
    localComputer.driverVersion = localConnection.driver.version;
  }
  if (!localAvailable) {
    localComputer.reasonCode =
      localConnection?.reasonCode ??
      (hostPlatform === "darwin" ? "cua-driver-unavailable" : "unsupported-platform");
  }

  return {
    host: {
      platform: hostPlatform,
      label:
        hostPlatform === "darwin"
          ? "macOS"
          : hostPlatform === "linux"
            ? "Linux"
            : hostPlatform === "win32"
              ? "Windows"
              : "Desktop",
      session: hostSession,
      packaged: Boolean(packaged),
      // so the renderer can show paths as ~/… without a Node builtin in
      // the sandboxed preload
      homeDir,
    },
    windowChrome: isMac ? "mac-inset" : "native",
    screenPreview,
    dictation,
    localComputer,
  };
}

function connectionEnabled(platform, connection) {
  if (platform === "darwin") return localComputerReady(platform, connection);
  return platform === "linux" && connection?.enabled === true;
}

module.exports = { connectionEnabled, desktopCapabilities, linuxSession, localComputerReady };
