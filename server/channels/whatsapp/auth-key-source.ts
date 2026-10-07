// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Where the server gets the WhatsApp auth key (design 3.3). Desktop: over the private utility parent port, from the
// OS-encrypted credential document owned by Electron main. Headless or dev (no parent port): the exported
// MURAGE_WHATSAPP_AUTH_KEY, else a 0600 file created exactly like the browser engine's key. Nothing here logs a key,
// and an existing key is never regenerated. An auth dir with no key file is `key-missing`: no second key is minted
// beside an existing session.
import { constants, closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { AuthKeyUnavailable, parentPortKeyProvider, validAuthKey, type AuthKeyProvider, type KeyPort } from "./auth-key.ts";

/** Reads or creates `dataDir/whatsapp/auth-key`. O_EXCL create, O_NOFOLLOW read, 65 bytes, 0600, owned by this user
 * (the mode and uid checks are skipped on Windows, where they carry no meaning). */
export function fileAuthKey(dataDir: string): string {
  const directory = join(dataDir, "whatsapp");
  const file = join(directory, "auth-key");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!existsSync(file) && existsSync(join(directory, "auth"))) throw new AuthKeyUnavailable("key-missing");
  try {
    const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    try { writeFileSync(fd, `${randomBytes(32).toString("hex")}\n`); } finally { closeSync(fd); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new AuthKeyUnavailable("credential-store");
  }
  try {
    if (lstatSync(file).isSymbolicLink()) throw new Error("symbolic link");
    const fd = openSync(file, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW));
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size !== 65 || (process.platform !== "win32" && ((stat.mode & 0o777) !== 0o600 || stat.uid !== process.getuid?.()))) throw new Error("invalid key file");
      const key = readFileSync(fd, "utf8").trim();
      if (!validAuthKey(key)) throw new Error("invalid key content");
      return key;
    } finally { closeSync(fd); }
  } catch { throw new AuthKeyUnavailable("key-missing"); }
}

export function whatsappAuthKeySource(options: { dataDir: string; parentPort?: KeyPort; env?: NodeJS.ProcessEnv; timeoutMs?: number }): AuthKeyProvider {
  if (options.parentPort) return parentPortKeyProvider(options.parentPort, options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {});
  return {
    async get() {
      const exported = (options.env ?? process.env).MURAGE_WHATSAPP_AUTH_KEY;
      if (exported !== undefined && exported !== "") {
        if (!validAuthKey(exported)) throw new AuthKeyUnavailable("credential-store");
        return exported;
      }
      return fileAuthKey(options.dataDir);
    },
  };
}
