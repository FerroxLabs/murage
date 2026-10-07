// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The within-DATA_DIR delete behind unlink and a dead-session relink (design 3.5). It removes exactly the bridge
// directories of one connection and, for scope "all", that connection's receipt ledgers. Every target is derived from
// a validated connection id, resolved through the real path of DATA_DIR, and refused if it escapes it or if any
// ancestor below DATA_DIR is a symbolic link. Production code does not import from server/testing.
import { lstatSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";

const CONNECTION_ID = /^[a-zA-Z0-9-]{1,100}$/;

export type WipeScope = "auth" | "all";

/** Every path a wipe of `connectionId` removes. Exported so the tests pin the exact set. */
export function wipeTargets(dataDir: string, connectionId: string, scope: WipeScope): string[] {
  if (!CONNECTION_ID.test(connectionId)) throw new Error("Invalid WhatsApp connection id");
  const bridge = join(dataDir, "whatsapp");
  const targets = [join(bridge, "auth"), join(bridge, "media", connectionId)];
  for (const dir of ["ingress", "outbound"]) {
    // The journal, its backup and compaction temp files all start with `<connectionId>.`.
    let names: string[] = [];
    try { names = readdirSync(join(bridge, dir)); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    for (const name of names) if (name.startsWith(connectionId + ".")) targets.push(join(bridge, dir, name));
  }
  if (scope === "all") targets.push(join(dataDir, "channels", "whatsapp", connectionId));
  return targets;
}

function assertInside(root: string, target: string): void {
  let current = target;
  // Walk up to the root: no ancestor strictly between them may be a symbolic link.
  while (current !== root) {
    const parent = dirname(current);
    if (parent === current || !current.startsWith(root + sep)) throw new Error("WhatsApp data path escapes the data folder");
    if (current !== target) {
      try { if (lstatSync(current).isSymbolicLink()) throw new Error("WhatsApp data path crosses a symbolic link"); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    }
    current = parent;
  }
}

export async function wipeWhatsAppData(dataDir: string, connectionId: string, scope: WipeScope): Promise<void> {
  const root = realpathSync(dataDir);
  for (const target of wipeTargets(dataDir, connectionId, scope)) {
    const real = join(root, relative(dataDir, target));
    assertInside(root, real);
    // A symbolic link at the leaf is removed as a link; rmSync never follows it.
    rmSync(real, { recursive: true, force: true });
  }
}
