"use strict";

/**
 * The built-in browser depends on Electron's production renderer sandbox.
 * Windows was held off while electron/electron#51761 was open; Electron 43.7.7
 * (the shipped version) no longer crashes, so Windows is offered again.
 */
function browserSurfaceSupported(platform = process.platform) {
  return platform === "darwin" || platform === "linux" || platform === "win32";
}

module.exports = { browserSurfaceSupported };
