// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later

import { lstatSync, realpathSync, statfsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export function validateCredentialFile({ expectedUid, uid, env, directory, file, storeType }) {
  if (!Number.isSafeInteger(expectedUid) || expectedUid <= 0 || uid !== expectedUid) throw Error("NOT_CANARY_ACCOUNT");
  if (Object.keys(env).some(name => /^(?:MURAGE_|ANTHROPIC_|CLAUDE_|AWS_|GOOGLE_APPLICATION_CREDENTIALS$)/i.test(name)) ||
      storeType !== 0x01021994 || !directory?.isDirectory() || directory.uid !== uid || (directory.mode & 0o777) !== 0o700 ||
      !file?.isFile() || file.uid !== uid || (file.mode & 0o777) !== 0o600 || file.nlink !== 1 || file.size === 0) {
    throw Error("NO_CREDENTIAL");
  }
  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [uidText] = process.argv.slice(2);
  const expectedUid = Number(uidText);
  const uid = process.getuid?.();
  if (process.platform !== "linux" || !Number.isSafeInteger(expectedUid) || expectedUid <= 0 || uid !== expectedUid) {
    throw Error("NOT_CANARY_ACCOUNT");
  }
  const realHome = realpathSync(homedir());
  if (realHome !== process.env.HOME || lstatSync(realHome).uid !== uid) throw Error("NO_CREDENTIAL");
  const root = join(realHome, ".claude");
  const directory = lstatSync(root, { throwIfNoEntry: false });
  const credentialPath = join(root, ".credentials.json");
  const credential = directory?.isDirectory() ? lstatSync(credentialPath, { throwIfNoEntry: false }) : null;
  const storeType = credential?.isFile() ? statfsSync(credentialPath).type : null;
  validateCredentialFile({ expectedUid, uid, env: process.env, directory, file: credential, storeType });
  console.log(JSON.stringify({ credentialFileReady: true }));
}
