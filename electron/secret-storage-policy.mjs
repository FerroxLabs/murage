// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// When may the desktop WRITE a secret with Electron's safeStorage?
//
// On Linux safeStorage can fall back to the "basic_text" backend: a key that
// is only obfuscated, readable by anything that can read the file, and still
// reported as available. Writing a person's provider keys that way while the
// panel says "saved" is the audit finding C7. So a write on Linux needs a real
// keyring behind it (gnome-keyring, KWallet, or another libsecret store that is
// unlocked), or the person's explicit opt-in. Everywhere else the answer is
// unchanged: safeStorage says whether it can encrypt.
//
// Reads are not gated here: a file written earlier must still open, and the
// person can then move it to a keyring.

export const GENERIC_STORE_UNAVAILABLE = "The operating-system credential store is unavailable";

/** The sentence a person reads where a key could not be saved. Names the fix
 * and the one explicit way around it. No em dash, no price, no scare words. */
export const LINUX_KEYRING_REQUIRED =
  "Murage will not save this key yet. This computer has no unlocked keyring, so a saved key would only be hidden, not protected. "
  + "Install and unlock a keyring such as gnome-keyring or KWallet, then restart Murage and try again. "
  + "If you want keys kept as plain text on this computer anyway, start Murage with MURAGE_ALLOW_PLAINTEXT_SECRETS=1.";

export const PLAINTEXT_OPT_IN_ENV = "MURAGE_ALLOW_PLAINTEXT_SECRETS";

/** The backend safeStorage chose, or "unknown" when it cannot say. Only asked on Linux. */
export function selectedStorageBackend(safeStorage, platform) {
  if (platform !== "linux") return null;
  try {
    const backend = typeof safeStorage?.getSelectedStorageBackend === "function" ? safeStorage.getSelectedStorageBackend() : "unknown";
    return typeof backend === "string" && backend ? backend : "unknown";
  } catch {
    return "unknown";
  }
}

/** Why a secret write must not go ahead, as a sentence for the person, or null
 * when it may. */
export async function secretWriteRefusal({ safeStorage, platform = process.platform, env = process.env }) {
  const optedIn = String(env?.[PLAINTEXT_OPT_IN_ENV] ?? "").trim() === "1";
  if (platform === "linux" && !optedIn) {
    const backend = selectedStorageBackend(safeStorage, platform);
    if (backend === "basic_text" || backend === "unknown") return LINUX_KEYRING_REQUIRED;
  }
  let available = false;
  try {
    available = await safeStorage.isAsyncEncryptionAvailable();
  } catch {
    available = false;
  }
  if (!available) return platform === "linux" ? LINUX_KEYRING_REQUIRED : GENERIC_STORE_UNAVAILABLE;
  return null;
}
