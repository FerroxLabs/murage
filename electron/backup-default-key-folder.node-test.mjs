import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { defaultRecoveryKeyFolder, createRecoveryKeyFlow, recoveryKeyAutomaticExclusions } from "./backup-recovery-key.mjs";
import { safeWipeSync } from "../server/testing/safe-wipe.mjs";

test("missing, unconfigured or non-directory Documents uses home and still opens the picker", async () => {
  const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "murage-key-default-")));
  try {
    const home = path.join(root, "home"), documents = path.join(home, "Documents"), file = path.join(root, "file");
    mkdirSync(home); mkdirSync(path.join(root, "installation")); writeFileSync(file, "not a directory");
    for (const value of [undefined, documents, file, home]) {
      const getPath = name => {
        if (name === "home") return home;
        if (value === undefined) throw new Error("no XDG documents directory");
        return value;
      };
      assert.equal(defaultRecoveryKeyFolder(getPath), home);
      assert.deepEqual(recoveryKeyAutomaticExclusions(getPath), []);
      let picked = false;
      const flow = createRecoveryKeyFlow({ defaultFolder: () => defaultRecoveryKeyFolder(getPath),
        installation: () => path.join(root, "installation"), selectedDestination: () => path.join(root, "backups"),
        chooseFile: async suggested => { picked = true; assert.equal(path.dirname(suggested), home); return null; } });
      assert.deepEqual(await flow.create(), { cancelled: true });
      assert.equal(picked, true);
      const automatic = createRecoveryKeyFlow({
        installation: () => path.join(root, "installation"),
        defaultFolders: () => [home], neverAutomatic: () => recoveryKeyAutomaticExclusions(getPath),
      });
      assert.equal(path.dirname(automatic.createFor(path.join(root, "backups")).file), home);
    }
    mkdirSync(documents);
    assert.equal(defaultRecoveryKeyFolder(name => name === "documents" ? documents : home), documents);
    assert.deepEqual(recoveryKeyAutomaticExclusions(name => name === "documents" ? documents : home), [documents]);
  } finally { safeWipeSync(root); }
});
