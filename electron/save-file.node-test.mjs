import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { pathToFileURL } from "node:url";

import { copyIntoDirectory, resolveSavablePath } from "./save-file.mjs";

// Creating a symlink on Windows needs elevation or developer mode, so the
// symlink cases only run where the runner can actually make one.
const canSymlink = (() => {
  const probe = fs.mkdtempSync(path.join(os.tmpdir(), "omb-symlink-probe-"));
  try {
    fs.symlinkSync(probe, path.join(probe, "link"));
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(probe, { recursive: true, force: true });
  }
})();

let home;
let botHome;

before(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "omb-save-file-"));
  botHome = path.join(home, ".openmausbot");
  fs.mkdirSync(path.join(botHome, "workspaces", "bot"), { recursive: true });
  fs.writeFileSync(path.join(botHome, "workspaces", "bot", "report.docx"), "docx");
  fs.writeFileSync(path.join(home, "secret.txt"), "private");
});

after(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe("save-file path validation", () => {
  it("accepts a file inside the bot home, as a path or a file:// URL", async () => {
    const file = path.join(botHome, "workspaces", "bot", "report.docx");
    // must be fs.promises.realpath, the same call the module makes: on Windows
    // the callback API leaves 8.3 short names ("RUNNER~1") that the promises
    // API expands ("runneradmin"), so mixing the two compares different strings
    const expected = await fs.promises.realpath(file);
    assert.equal(await resolveSavablePath(file, { home }), expected);
    assert.equal(await resolveSavablePath(pathToFileURL(file).href, { home }), expected);
  });

  it("accepts a file under a symlinked bot home", { skip: !canSymlink }, async () => {
    const realHome = fs.mkdtempSync(path.join(os.tmpdir(), "omb-real-home-"));
    const linkedHome = fs.mkdtempSync(path.join(os.tmpdir(), "omb-linked-home-"));
    const realBotHome = path.join(realHome, "bot-data");
    fs.mkdirSync(realBotHome, { recursive: true });
    fs.writeFileSync(path.join(realBotHome, "report.docx"), "docx");
    fs.symlinkSync(realBotHome, path.join(linkedHome, ".openmausbot"));

    const viaLink = path.join(linkedHome, ".openmausbot", "report.docx");
    assert.equal(await resolveSavablePath(viaLink, { home: linkedHome }), await fs.promises.realpath(viaLink));

    fs.rmSync(realHome, { recursive: true, force: true });
    fs.rmSync(linkedHome, { recursive: true, force: true });
  });

  it("rejects paths outside the bot home, including via traversal", async () => {
    const rejected = "Only files created by your bots can be saved";
    await assert.rejects(resolveSavablePath(path.join(home, "secret.txt"), { home }), { message: rejected });
    await assert.rejects(resolveSavablePath(path.join(botHome, "..", "secret.txt"), { home }), { message: rejected });
  });

  it("rejects a symlink inside the bot home pointing outside it", { skip: !canSymlink }, async () => {
    const escape = path.join(botHome, "escape.txt");
    fs.symlinkSync(path.join(home, "secret.txt"), escape);
    await assert.rejects(resolveSavablePath(escape, { home }), {
      message: "Only files created by your bots can be saved",
    });
    fs.rmSync(escape);
  });

  it("rejects empty, relative, and non-file targets", async () => {
    await assert.rejects(resolveSavablePath("", { home }), { message: "A file path is required" });
    await assert.rejects(resolveSavablePath("workspaces/bot/report.docx", { home }), { message: "That file path is invalid" });
    await assert.rejects(resolveSavablePath(path.join(botHome, "nope.docx"), { home }), { message: "That file no longer exists" });
    await assert.rejects(resolveSavablePath(path.join(botHome, "workspaces"), { home }), { message: "That path is not a file" });
  });
});

describe("save-file copying", () => {
  it("suffixes rather than overwriting an existing download", async () => {
    const downloads = fs.mkdtempSync(path.join(os.tmpdir(), "omb-downloads-"));
    const source = path.join(botHome, "workspaces", "bot", "report.docx");

    assert.equal(await copyIntoDirectory(downloads, source), path.join(downloads, "report.docx"));
    assert.equal(await copyIntoDirectory(downloads, source), path.join(downloads, "report (2).docx"));
    assert.equal(await copyIntoDirectory(downloads, source), path.join(downloads, "report (3).docx"));
    assert.equal(fs.readFileSync(path.join(downloads, "report.docx"), "utf8"), "docx");

    fs.rmSync(downloads, { recursive: true, force: true });
  });

  it("never overwrites when saves race for the same name", async () => {
    const downloads = fs.mkdtempSync(path.join(os.tmpdir(), "omb-downloads-race-"));
    const source = path.join(botHome, "workspaces", "bot", "report.docx");

    const results = await Promise.all(Array.from({ length: 8 }, () => copyIntoDirectory(downloads, source)));
    assert.equal(new Set(results).size, 8, "each concurrent save must claim its own name");
    assert.equal(fs.readdirSync(downloads).length, 8);

    fs.rmSync(downloads, { recursive: true, force: true });
  });
});
