// Native file writers bound to the installation this process owns
// (0.1.52 R2-T1/R2-T2, audits B1 and B3).
//
// main.mjs registers these handlers directly, so the node tests exercise the
// same root resolution, sender check and refusal order the app runs. Electron
// pieces (dialogs, reveal, windows) are injected; nothing here imports
// Electron.
import path from "node:path";

import { isOwnedMainSender } from "./main-trust.mjs";
import { withSavableFile } from "./save-file.mjs";

function refusal(code, message) {
  return Object.assign(new Error(message), { code });
}

/**
 * The data root that native writers (Save, recorder) may use.
 *
 * Packaged: only the root this process holds the installation lease for. After
 * a separate restore that is the SELECTED installation, not the requested
 * original that `MURAGE_DATA_DIR` / `~/.murage` still names, so the environment
 * is deliberately not consulted. Recovery or closing refuses outright.
 *
 * Development: the explicit fixture root (`MURAGE_DATA_DIR`) or `~/.murage`,
 * the same root the development server was started with. An empty override is
 * invalid, as it is for the packaged lease.
 */
export function activeDesktopDataRoot({ packaged, recovery, closing, owner, dataDirectory, env = {}, home } = {}) {
  if (recovery) throw refusal("NATIVE_ROOT_RECOVERY", "Murage is reviewing installation recovery, so nothing was saved.");
  if (closing) throw refusal("NATIVE_ROOT_CLOSING", "Murage is closing, so nothing was saved.");
  if (packaged) {
    if (!owner || typeof dataDirectory !== "string" || !path.isAbsolute(dataDirectory)) {
      throw refusal("NATIVE_ROOT_UNOWNED", "This window does not own an installation, so nothing was saved.");
    }
    return dataDirectory;
  }
  const explicit = env.MURAGE_DATA_DIR;
  if (explicit !== undefined) {
    if (typeof explicit !== "string" || !path.isAbsolute(explicit)) {
      throw refusal("NATIVE_ROOT_UNOWNED", "The development data folder is invalid, so nothing was saved.");
    }
    return explicit;
  }
  if (typeof home !== "string" || !path.isAbsolute(home)) {
    throw refusal("NATIVE_ROOT_UNOWNED", "The development data folder is invalid, so nothing was saved.");
  }
  return path.join(home, ".murage");
}

function assertOwnedSender(event, { window, origin }, message) {
  if (!isOwnedMainSender(event, { window: window(), origin: origin() })) {
    throw refusal("NATIVE_SENDER_UNTRUSTED", message);
  }
}

/**
 * `desktop:save-file`. Order matters: sender, then active root, then source
 * validation, and only then the native dialog, so a refused request never
 * shows a dialog or touches a destination.
 */
export function createSaveFileHandler({ window, origin, activeRoot, chooseDestination, reveal, saveFile = withSavableFile }) {
  return async (event, rawPath) => {
    assertOwnedSender(event, { window, origin }, "Files can only be saved from the Murage window.");
    const root = activeRoot();
    return saveFile(rawPath, { root }, async ({ defaultName, copyTo }) => {
      const destination = await chooseDestination({ event, defaultName });
      // Cancelling is a decision, not a failure — the bubble stays quiet.
      if (!destination) return null;
      await copyTo(destination);
      reveal(destination);
      return destination;
    });
  };
}

/**
 * `skill-recorder:save`. The recording is written only beneath the active
 * owned root; ownership is resolved before any directory is created.
 */
export function createSkillRecordingSaveHandler({ window, origin, activeRoot, saveRecording }) {
  return (event, payload) => {
    assertOwnedSender(event, { window, origin }, "Skill recordings can only be saved from the Murage window.");
    const dataRoot = activeRoot();
    return saveRecording(payload, { dataRoot });
  };
}
