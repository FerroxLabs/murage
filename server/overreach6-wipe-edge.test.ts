// SPDX-License-Identifier: AGPL-3.0-or-later
// OVERREACH #6 (MAIN-RULING 2026-11-27T01:45Z (2)+(3)): wipes are the edge in every mode. A script this session wrote that deletes the home folder, a
// whole mounted volume, and a script body that cannot be read get the SAME wipe card at Full access and at No limits. Full is never looser than No limits.
// Production entry: autoVerdict (the approval listener's verdict) with a real script file on disk and the session-written set, as outside-wire hands it.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

process.env.HOME = "/home/tester";
process.env.USERPROFILE = "/home/tester";
vi.resetModules();
const { autoVerdict } = await import("./auto-approve.ts");
// after vi.resetModules, so the reader is installed in the module instance autoVerdict uses
const { installWipeContextReader } = await import("./wipe/context.ts");
type AutoContext = import("./auto-approve.ts").AutoContext;

const FULL = { autoApprove: true, fullAccess: true };
const NO_LIMITS = { autoApprove: true, fullAccess: true, noLimits: true, permissionExplicit: true };
const HOME = "/home/tester";
const OWN = { fullAccessOrigin: "owner", ownerStarted: true, outsideRead: null } as Partial<AutoContext>;

const dir = mkdtempSync(join(tmpdir(), "overreach6-"));
mkdirSync(join(dir, "w"));
mkdirSync(join(dir, "w", "sub"));
const cwd = join(dir, "w");
const files: Record<string, string> = {
  "wipe.sh": "echo start\nrm -rf ~\n",
  "wipe.py": "import shutil, os\nshutil.rmtree(os.path.expanduser('~'))\n",
  "wipe.js": "const fs = require('fs');\nfs.rmSync(process.env.HOME, { recursive: true });\n",
  "outer.sh": "bash wipe.sh\n",
  "volume.sh": "rm -rf /Volumes/Backup\n",
  "fine.sh": "echo fine\nls\n",
  "Mixed.sh": "rm -rf ~\n",
  // written with a composed accent (NFC); a macOS volume reads the decomposed spelling (NFD) as the same file
  "caf\u00e9.sh": "rm -rf ~\n",
  // deletes the folder the shell is in: a wipe only when that folder is the home folder
  "dot.sh": "rm -rf .\n",
};
for (const [name, body] of Object.entries(files)) writeFileSync(join(cwd, name), body);
writeFileSync(join(cwd, "sub", "inner.sh"), "rm -rf ~\n");
// the same name in the start folder (harmless) and in the folder the text moves to (deletes home): the harmless one must not mask it
writeFileSync(join(cwd, "twin.sh"), "echo harmless\n");
writeFileSync(join(cwd, "sub", "twin.sh"), "rm -rf ~\n");
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const written = new Set([...Object.keys(files), "gone.sh", "huge.sh", "sub/inner.sh", "twin.sh", "sub/twin.sh"].map((name) => join(cwd, name)));
writeFileSync(join(cwd, "huge.sh"), "#".repeat(131_073));

// The mount inventory the production classifier consults (server/wipe/roots.ts), with a path port that can stat: these two volumes are mounted here.
const MOUNTED = new Set(["/Volumes/Backup", "/mnt/backup", "/media/tester/disk", "/run/media/tester/disk"]);
let uninstall = (): void => {};
beforeAll(() => {
  uninstall = installWipeContextReader(() => ({
    mountInventory: { contains: (path: string) => MOUNTED.has(path), has: (path: string) => MOUNTED.has(path) },
    pathPort: { realpath: (path: string) => path, isBlockDevice: () => null, stat: () => ({ dev: 1, ino: 1 }), lstat: () => ({ dev: 1, ino: 1 }) },
  }));
});
afterAll(() => uninstall());
const ask = (bot: object, tool: string, text: string, extra: Partial<AutoContext> = {}) =>
  autoVerdict(bot, tool, text, {
    ...(tool === "Bash" ? { commandText: text } : {}), commandCwd: cwd, stopLine: null, promptFacts: { cwd, home: HOME }, workFolder: cwd,
    unseen: { platform: "posix", sessionEdits: written }, ...OWN, ...extra,
  } as AutoContext);

const WIPE_RULES = ["delete-home", "delete-root", "wipe-check-fault"];
// SITES (grep: script runners in the wipe reader): a shell or interpreter given the file, source, `.`, the file's own path, a script that runs a script, and no file.
const WIPE_ROWS: [string, string][] = [
  ["a shell run of a written script that deletes home", "bash wipe.sh"],
  ["sh -e (an option that takes no code)", "sh -e wipe.sh"],
  ["source of a written script", "source wipe.sh"],
  ["dot of a written script", ". wipe.sh"],
  ["the written script run by its own path", `${join(cwd, "wipe.sh")}`],
  ["a python script that removes home", "python3 wipe.py"],
  ["a node script that removes home", "node wipe.js"],
  ["a script that runs a script that deletes home", "bash outer.sh"],
  ["a script whose body deletes a whole volume", "bash volume.sh"],
  ["a script after other commands", "cd . && echo go && bash wipe.sh"],
  ["a script run by relative path after a cd into its folder", "cd sub && bash inner.sh"],
  ["a same-named harmless script in the start folder does not mask the one a cd runs", "cd sub && bash twin.sh"],
  ["a long chain of cd to distinct folders still finishes and finds the script (bounded candidates)", `${Array.from({ length: 40 }, (_, i) => `cd d${i}`).join(" ; ")} ; cd ${join(cwd, "sub")} && bash inner.sh`],
  ["the candidate folders overflow after a cd into the folder holding the script (never evicts it: fails closed)", `cd ${join(cwd, "sub")} ; ${Array.from({ length: 31 }, (_, i) => `cd /nowhere${i}`).join(" ; ")} ; bash inner.sh`],
  ["a script run by relative path after pushd into its folder", "pushd sub && bash inner.sh"],
  ["a written script whose file is gone (cannot be read)", "bash gone.sh"],
  ["a written script past the read bound", "bash huge.sh"],
  ["rm -rf of a whole mounted volume (macOS)", "rm -rf /Volumes/Backup"],
  ["rm -rf of a whole mounted volume (/mnt)", "rm -rf /mnt/backup"],
  ["rm -rf of a whole mounted volume (/media/user)", "rm -rf /media/tester/disk"],
  ["rm -rf of a whole mounted volume (/run/media)", "rm -rf /run/media/tester/disk"],
];
// A folder the text returns to is the folder it is in: the home folder is the working folder here, so a script that deletes "." wipes home.
const REVISIT_HOME = "/home/tester";
// [label, text, the exact card rule]: a revisit finds the home folder (delete-home); an overflow cannot, and says so (wipe-check-fault)
const REVISIT_ROWS: [string, string, string][] = [
  ["a revisit below the cap (cd home ; cd away ; cd home)", `cd ${REVISIT_HOME} ; cd /elsewhere ; cd ${REVISIT_HOME} ; bash ${join(cwd, "dot.sh")}`, "delete-home"],
  ["an absolute-path script after the candidate set overflowed (the folder it runs in is unknown: fails closed)", `${Array.from({ length: 31 }, (_, i) => `cd /e${i}`).join(" ; ")} ; cd ${REVISIT_HOME} ; bash ${join(cwd, "dot.sh")}`, "wipe-check-fault"],
  ["a revisit with the candidate set one below the cap", `cd ${REVISIT_HOME} ; ${Array.from({ length: 29 }, (_, i) => `cd /e${i}`).join(" ; ")} ; cd ${REVISIT_HOME} ; bash ${join(cwd, "dot.sh")}`, "delete-home"],
  ["a revisit with the candidate set exactly full (the revisit must not overflow)", `cd ${REVISIT_HOME} ; ${Array.from({ length: 30 }, (_, i) => `cd /e${i}`).join(" ; ")} ; cd ${REVISIT_HOME} ; bash ${join(cwd, "dot.sh")}`, "delete-home"],
];
// past the overflow a written script spelled in another letter case is the same file on a case-insensitive volume: it fails closed (wipe-check-fault)
const CASE_ROWS: [string, string][] = [
  ["a relative script spelled in another case after the candidate folders overflowed", `${Array.from({ length: 33 }, (_, i) => `cd /e${i}`).join(" ; ")} ; bash WIPE.SH`],
  ["an absolute script spelled in another case after the candidate folders overflowed", `${Array.from({ length: 33 }, (_, i) => `cd /e${i}`).join(" ; ")} ; bash ${join(cwd, "Wipe.Sh")}`],
  ["a written script whose own name has capitals, run spelled in capitals after the candidate folders overflowed", `${Array.from({ length: 33 }, (_, i) => `cd /e${i}`).join(" ; ")} ; bash MIXED.SH`],
  ["a relative path-tail in another case after the candidate folders overflowed", `${Array.from({ length: 33 }, (_, i) => `cd /e${i}`).join(" ; ")} ; bash SUB/Inner.sh`],
  ["a written script whose name has a composed accent, run spelled decomposed after the candidate folders overflowed", `${Array.from({ length: 33 }, (_, i) => `cd /e${i}`).join(" ; ")} ; bash cafe\u0301.sh`],
  ["an absolute path to a composed-accent script, spelled decomposed after the candidate folders overflowed", `${Array.from({ length: 33 }, (_, i) => `cd /e${i}`).join(" ; ")} ; bash ${join(cwd, "cafe\u0301.sh")}`],
  ["a composed-accent script run in capitals after the candidate folders overflowed", `${Array.from({ length: 33 }, (_, i) => `cd /e${i}`).join(" ; ")} ; bash CAF\u00c9.SH`],
];
const RUN_ROWS: [string, string][] = [
  ["a written script that deletes nothing", "bash fine.sh"],
  ["a shell given only code (no file)", "bash -c 'echo hi'"],
  ["a script this session did not write is not read", "bash notwritten.sh"],
  ["a folder inside a volume", "rm -rf /Volumes/Backup/old"],
  ["a folder inside /mnt", "rm -rf /mnt/backup/old"],
  ["a volume-shaped folder that is not a mount here", "rm -rf /mnt/plain"],
  // past the overflow only a name this session wrote fails closed: a script it did not write is not read and not carded (relative and absolute)
  ["a script this session did not write, after the candidate folders overflowed", `${Array.from({ length: 33 }, (_, i) => `cd /e${i}`).join(" ; ")} ; bash notwritten.sh`],
  ["an absolute script this session did not write, after the candidate folders overflowed", `${Array.from({ length: 33 }, (_, i) => `cd /e${i}`).join(" ; ")} ; bash ${join(cwd, "notwritten.sh")}`],
];

describe("OVERREACH #6 wipes are the edge at Full access and No limits", () => {
  for (const [label, text] of WIPE_ROWS) {
    it(`${label}: No limits cards it as a wipe`, () => {
      const noLimits = ask(NO_LIMITS, "Bash", text);
      expect(noLimits, `No limits: ${text}`).toMatchObject({ approve: null, source: "always-ask" });
      expect(WIPE_RULES, `No limits rule ${noLimits.rule}`).toContain(noLimits.rule);
    });
    it(`${label}: Full access cards it as a wipe, never looser than No limits`, () => {
      const full = ask(FULL, "Bash", text);
      expect(full, `Full access: ${text}`).toMatchObject({ approve: null, source: "always-ask" });
      expect(WIPE_RULES, `Full access rule ${full.rule}`).toContain(full.rule);
      // the same card as No limits; a "could not finish checking" fault (the candidate folders overflowed) is the one case where Full's own reader
      // may name the wipe it found: still a wipe card, never looser
      const noLimitsRule = ask(NO_LIMITS, "Bash", text).rule;
      if (noLimitsRule !== "wipe-check-fault") expect(full.rule, `the same card as No limits: ${text}`).toBe(noLimitsRule);
    });
  }
  for (const [label, text] of CASE_ROWS) {
    for (const [level, bot] of [["No limits", NO_LIMITS], ["Full access", FULL]] as const) {
      it(`${label}: ${level} cards it as a wipe-check-fault`, () => {
        const verdict = ask(bot, "Bash", text);
        expect(verdict, text).toMatchObject({ approve: null, source: "always-ask" });
        expect(WIPE_RULES, `rule ${verdict.rule}`).toContain(verdict.rule);
        // No limits has no reader of its own for the overflowed name: the fault is the exact card (Full access may name the wipe its reader found)
        if (bot === NO_LIMITS) expect(verdict.rule, text).toBe("wipe-check-fault");
      });
    }
  }
  for (const [label, text] of RUN_ROWS) {
    it(`${label}: runs at both levels`, () => {
      expect(ask(NO_LIMITS, "Bash", text), `No limits: ${text}`).toMatchObject({ approve: expect.any(String) });
      expect(ask(FULL, "Bash", text), `Full access: ${text}`).toMatchObject({ approve: expect.any(String), source: "full-access" });
    });
  }
  for (const [label, text, rule] of REVISIT_ROWS) {
    // Full access also has its own unseen-script reader that cards these independently of the candidate folders: its rows guard "never looser", the receipts target No limits
    for (const [level, bot] of [["No limits", NO_LIMITS], ["Full access", FULL]] as const) {
      it(`${label}: ${level} cards it (the script wipes the home folder the text is in)`, () => {
        const verdict = ask(bot, "Bash", text, { commandCwd: join(REVISIT_HOME, "work"), workFolder: join(REVISIT_HOME, "work"), promptFacts: { cwd: join(REVISIT_HOME, "work"), home: HOME } as AutoContext["promptFacts"] });
        expect(verdict, text).toMatchObject({ approve: null, source: "always-ask" });
        if (bot === NO_LIMITS) expect(verdict.rule, text).toBe(rule); // Full access names the wipe its own reader found
        else expect(WIPE_RULES).toContain(verdict.rule);
      });
    }
  }
  it("a routine or unattended Full access turn is not given the owner's run answer", () => {
    expect(ask(FULL, "Bash", "bash gone.sh", { ownerStarted: false })).toMatchObject({ approve: null });
  });
});
