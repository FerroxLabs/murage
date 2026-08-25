import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { availableDestination, resolveSavablePath } from "./save-file.mjs";

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
    const expected = fs.realpathSync(file);
    assert.equal(await resolveSavablePath(file, { home }), expected);
    assert.equal(await resolveSavablePath(`file://${file}`, { home }), expected);
  });

  it("accepts a file under a symlinked bot home", async () => {
    const realHome = fs.mkdtempSync(path.join(os.tmpdir(), "omb-real-home-"));
    const linkedHome = fs.mkdtempSync(path.join(os.tmpdir(), "omb-linked-home-"));
    const realBotHome = path.join(realHome, "bot-data");
    fs.mkdirSync(realBotHome, { recursive: true });
    fs.writeFileSync(path.join(realBotHome, "report.docx"), "docx");
    fs.symlinkSync(realBotHome, path.join(linkedHome, ".openmausbot"));

    const viaLink = path.join(linkedHome, ".openmausbot", "report.docx");
    assert.equal(await resolveSavablePath(viaLink, { home: linkedHome }), fs.realpathSync(viaLink));

    fs.rmSync(realHome, { recursive: true, force: true });
    fs.rmSync(linkedHome, { recursive: true, force: true });
  });

  it("rejects paths outside the bot home, including via traversal and symlinks", async () => {
    const escape = path.join(botHome, "escape.txt");
    fs.symlinkSync(path.join(home, "secret.txt"), escape);
    const rejected = "Only files created by your bots can be saved";

    await assert.rejects(resolveSavablePath(path.join(home, "secret.txt"), { home }), { message: rejected });
    await assert.rejects(resolveSavablePath(path.join(botHome, "..", "secret.txt"), { home }), { message: rejected });
    await assert.rejects(resolveSavablePath(escape, { home }), { message: rejected });
    fs.rmSync(escape);
  });

  it("rejects empty, relative, and non-file targets", async () => {
    await assert.rejects(resolveSavablePath("", { home }), { message: "A file path is required" });
    await assert.rejects(resolveSavablePath("workspaces/bot/report.docx", { home }), { message: "That file path is invalid" });
    await assert.rejects(resolveSavablePath(path.join(botHome, "nope.docx"), { home }), { message: "That file no longer exists" });
    await assert.rejects(resolveSavablePath(path.join(botHome, "workspaces"), { home }), { message: "That path is not a file" });
  });
});

describe("save-file destination naming", () => {
  it("suffixes rather than overwriting an existing download", async () => {
    const downloads = fs.mkdtempSync(path.join(os.tmpdir(), "omb-downloads-"));
    const source = path.join(botHome, "workspaces", "bot", "report.docx");

    assert.equal(await availableDestination(downloads, source), path.join(downloads, "report.docx"));
    fs.writeFileSync(path.join(downloads, "report.docx"), "");
    assert.equal(await availableDestination(downloads, source), path.join(downloads, "report (2).docx"));
    fs.writeFileSync(path.join(downloads, "report (2).docx"), "");
    assert.equal(await availableDestination(downloads, source), path.join(downloads, "report (3).docx"));

    fs.rmSync(downloads, { recursive: true, force: true });
  });
});
