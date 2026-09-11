import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { pathToFileURL } from "node:url";

import { activeDesktopDataRoot, createSaveFileHandler } from "./native-file-handlers.mjs";
import { defaultSaveName, resolveSavablePath, withSavableFile } from "./save-file.mjs";
import { safeWipeSync } from "../server/testing/safe-wipe.mjs";

// Creating a symlink on Windows needs elevation or developer mode, so the
// symlink cases only run where the runner can actually make one.
const canSymlink = (() => {
  const probe = fs.mkdtempSync(path.join(os.tmpdir(), "murage-symlink-probe-"));
  try {
    fs.symlinkSync(probe, path.join(probe, "link"));
    return true;
  } catch {
    return false;
  } finally {
    safeWipeSync(probe);
  }
})();

const OUTSIDE_ROOT = "Only files created by your bots can be saved";

let home;
let botHome;

before(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "murage-save-file-"));
  botHome = path.join(home, ".murage");
  fs.mkdirSync(path.join(botHome, "workspaces", "bot"), { recursive: true });
  fs.writeFileSync(path.join(botHome, "workspaces", "bot", "report.docx"), "docx");
  fs.writeFileSync(path.join(home, "secret.txt"), "private");
});

after(() => {
  safeWipeSync(home);
});

describe("save-file path validation", () => {
  it("accepts a file inside the bot home, as a path or a file:// URL", async () => {
    const file = path.join(botHome, "workspaces", "bot", "report.docx");
    // must be fs.promises.realpath, the same call the module makes: on Windows
    // the callback API leaves 8.3 short names ("RUNNER~1") that the promises
    // API expands ("runneradmin"), so mixing the two compares different strings
    const expected = await fs.promises.realpath(file);
    assert.equal(await resolveSavablePath(file, { root: botHome }), expected);
    assert.equal(await resolveSavablePath(pathToFileURL(file).href, { root: botHome }), expected);
  });

  it("accepts a file under a symlinked bot home", { skip: !canSymlink }, async () => {
    const realHome = fs.mkdtempSync(path.join(os.tmpdir(), "murage-real-home-"));
    const linkedHome = fs.mkdtempSync(path.join(os.tmpdir(), "murage-linked-home-"));
    const realBotHome = path.join(realHome, "bot-data");
    fs.mkdirSync(realBotHome, { recursive: true });
    fs.writeFileSync(path.join(realBotHome, "report.docx"), "docx");
    fs.symlinkSync(realBotHome, path.join(linkedHome, ".murage"));

    const viaLink = path.join(linkedHome, ".murage", "report.docx");
    assert.equal(
      await resolveSavablePath(viaLink, { root: path.join(linkedHome, ".murage") }),
      await fs.promises.realpath(viaLink),
    );

    safeWipeSync(realHome);
    safeWipeSync(linkedHome);
  });

  it("rejects paths outside the bot home, including via traversal", async () => {
    await assert.rejects(resolveSavablePath(path.join(home, "secret.txt"), { root: botHome }), { message: OUTSIDE_ROOT });
    await assert.rejects(resolveSavablePath(path.join(botHome, "..", "secret.txt"), { root: botHome }), { message: OUTSIDE_ROOT });
  });

  it("rejects a symlink inside the bot home pointing outside it", { skip: !canSymlink }, async () => {
    const escape = path.join(botHome, "escape.txt");
    fs.symlinkSync(path.join(home, "secret.txt"), escape);
    await assert.rejects(resolveSavablePath(escape, { root: botHome }), {
      message: OUTSIDE_ROOT,
    });
    fs.rmSync(escape);
  });

  it("rejects empty, relative, and non-file targets", async () => {
    await assert.rejects(resolveSavablePath("", { root: botHome }), { message: "A file path is required" });
    await assert.rejects(resolveSavablePath("workspaces/bot/report.docx", { root: botHome }), { message: "That file path is invalid" });
    await assert.rejects(resolveSavablePath(path.join(botHome, "nope.docx"), { root: botHome }), { message: "That file no longer exists" });
    await assert.rejects(resolveSavablePath(path.join(botHome, "workspaces"), { root: botHome }), { message: "That path is not a file" });
  });
});

describe("save-file active root (B3)", () => {
  it("accepts the active custom root and refuses the default ~/.murage installation", async () => {
    const active = fs.mkdtempSync(path.join(os.tmpdir(), "murage-active-root-"));
    try {
      const task = path.join(active, "workspaces", "bot", "task.md");
      fs.mkdirSync(path.dirname(task), { recursive: true });
      fs.writeFileSync(task, "active");
      assert.equal(await resolveSavablePath(task, { root: active }), await fs.promises.realpath(task));
      await assert.rejects(
        resolveSavablePath(path.join(botHome, "workspaces", "bot", "report.docx"), { root: active }),
        { message: OUTSIDE_ROOT },
      );
    } finally {
      safeWipeSync(active);
    }
  });

  it("refuses without an explicit absolute root instead of falling back to ~/.murage", async () => {
    const file = path.join(botHome, "workspaces", "bot", "report.docx");
    await assert.rejects(resolveSavablePath(file, {}), { message: OUTSIDE_ROOT });
    await assert.rejects(resolveSavablePath(file, { home }), { message: OUTSIDE_ROOT }, "the legacy home option is not a root");
    await assert.rejects(resolveSavablePath(file, { root: ".murage" }), { message: OUTSIDE_ROOT });
  });
});

describe("save-file dialog default name", () => {
  it("suggests a name that does not overwrite an existing file", async () => {
    const downloads = fs.mkdtempSync(path.join(os.tmpdir(), "murage-downloads-"));
    const source = path.join(botHome, "workspaces", "bot", "report.docx");

    assert.equal(await defaultSaveName(downloads, source), path.join(downloads, "report.docx"));
    fs.writeFileSync(path.join(downloads, "report.docx"), "");
    assert.equal(await defaultSaveName(downloads, source), path.join(downloads, "report (2).docx"));
    fs.writeFileSync(path.join(downloads, "report (2).docx"), "");
    assert.equal(await defaultSaveName(downloads, source), path.join(downloads, "report (3).docx"));

    safeWipeSync(downloads);
  });

  it("keeps the extension on the suggestion", async () => {
    const downloads = fs.mkdtempSync(path.join(os.tmpdir(), "murage-downloads-ext-"));
    const source = path.join(botHome, "workspaces", "bot", "report.docx");
    fs.writeFileSync(path.join(downloads, "report.docx"), "");

    assert.equal(path.extname(await defaultSaveName(downloads, source)), ".docx");

    safeWipeSync(downloads);
  });
});

describe("save-file source handles", () => {
  it("copies from the validated open handle", async () => {
    const source = path.join(botHome, "workspaces", "bot", "report.docx");
    const destination = path.join(home, "copied-report.docx");
    await withSavableFile(source, { root: botHome }, ({ copyTo }) => copyTo(destination));
    assert.equal(fs.readFileSync(destination, "utf8"), "docx");
    fs.rmSync(destination);
  });

  it("does not follow a symlink swap after the source is opened", { skip: !canSymlink || process.platform === "win32" }, async () => {
    const source = path.join(botHome, "workspaces", "bot", "report.docx");
    const moved = `${source}.moved`;
    const destination = path.join(home, "swapped-report.docx");
    await withSavableFile(source, { root: botHome }, async ({ copyTo }) => {
      fs.renameSync(source, moved);
      fs.symlinkSync(path.join(home, "secret.txt"), source);
      await copyTo(destination);
      assert.equal(fs.readFileSync(destination, "utf8"), "docx");
    }).finally(() => {
      if (fs.existsSync(source)) fs.rmSync(source);
      if (fs.existsSync(moved)) fs.renameSync(moved, source);
      if (fs.existsSync(destination)) fs.rmSync(destination);
    });
  });

  it("rejects a validation-to-open identity swap on Windows", async () => {
    const source = path.join(botHome, "workspaces", "bot", "report.docx");
    // These IDs are distinct BigInts but collapse to the same Number. The
    // options assertions below make the precision guarantee executable.
    const expected = { dev: 1n, ino: 9007199254740992n, isFile: () => true };
    const opened = { dev: 1n, ino: 9007199254740993n, isFile: () => true };
    let closed = false;
    let statOptions;
    let handleStatOptions;
    const fsp = {
      realpath: async (target) => target,
      stat: async (_target, options) => {
        statOptions = options;
        return expected;
      },
      open: async () => ({
        stat: async (options) => {
          handleStatOptions = options;
          return opened;
        },
        close: async () => {
          closed = true;
        },
      }),
    };

    await assert.rejects(
      withSavableFile(source, { root: botHome, fsp, platform: "win32" }, async () => {}),
      { message: "That file changed while it was being opened" },
    );
    assert.equal(closed, true);
    assert.deepEqual(statOptions, { bigint: true });
    assert.deepEqual(handleStatOptions, { bigint: true });
  });
});

describe("save-file destination safety (B2)", () => {
  // Larger than one stream chunk (64 KiB), so a same-inode truncation would
  // lose real data before the copy could finish.
  const SIZE = 1024 * 1024;
  let workspace;
  let source;
  let digest;
  const sha256 = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  const staging = (directory) => fs.readdirSync(directory).filter((name) => name.includes(".murage-save-"));

  beforeEach(() => {
    workspace = path.join(botHome, "workspaces", "bot");
    source = path.join(workspace, "large.bin");
    const bytes = randomBytes(SIZE);
    fs.writeFileSync(source, bytes);
    digest = createHash("sha256").update(bytes).digest("hex");
  });

  afterEach(() => {
    fs.rmSync(source, { force: true });
  });

  it("saving a large file onto itself is a no-op that keeps every byte", async () => {
    const result = await withSavableFile(source, { root: botHome }, ({ copyTo }) => copyTo(source));
    assert.deepEqual(result, { written: false, reason: "same-file" });
    assert.equal(fs.statSync(source).size, SIZE);
    assert.equal(sha256(source), digest);
    assert.deepEqual(staging(workspace), []);
  });

  it("treats a hard-link alias of the source as the same file", async () => {
    const alias = path.join(home, "large-hardlink.bin");
    fs.linkSync(source, alias);
    try {
      const result = await withSavableFile(source, { root: botHome }, ({ copyTo }) => copyTo(alias));
      assert.deepEqual(result, { written: false, reason: "same-file" });
      assert.equal(sha256(source), digest);
      assert.equal(sha256(alias), digest);
      assert.deepEqual(staging(home), []);
    } finally {
      fs.rmSync(alias, { force: true });
    }
  });

  it("treats a symlink alias of the source as the same file", { skip: !canSymlink }, async () => {
    const alias = path.join(home, "large-symlink.bin");
    fs.symlinkSync(source, alias);
    try {
      const result = await withSavableFile(source, { root: botHome }, ({ copyTo }) => copyTo(alias));
      assert.deepEqual(result, { written: false, reason: "same-file" });
      assert.equal(sha256(source), digest);
      assert.deepEqual(staging(home), []);
    } finally {
      fs.rmSync(alias, { force: true });
    }
  });

  it("replaces a different existing destination with the source bytes and leaves no staging file", async () => {
    const destination = path.join(home, "large-copy.bin");
    fs.writeFileSync(destination, "older download");
    try {
      const result = await withSavableFile(source, { root: botHome }, ({ copyTo }) => copyTo(destination));
      assert.deepEqual(result, { written: true });
      assert.equal(sha256(destination), digest);
      assert.equal(sha256(source), digest);
      assert.deepEqual(staging(home), []);
    } finally {
      fs.rmSync(destination, { force: true });
    }
  });

  it("keeps an existing destination intact when the copy fails part-way", async () => {
    const destination = path.join(home, "large-keep.bin");
    fs.writeFileSync(destination, "keep me");
    let failedAfter = 0;
    // Real filesystem, except the staging writer reports a disk error after
    // its first chunk, the way a full volume would.
    const fsp = {
      ...fs.promises,
      open: async (target, flags, mode) => {
        const handle = await fs.promises.open(target, flags, mode);
        if (flags !== "wx") return handle;
        const create = handle.createWriteStream.bind(handle);
        handle.createWriteStream = (options) => {
          const stream = create(options);
          const write = stream._write.bind(stream);
          stream._writev = null;
          stream._write = (chunk, encoding, callback) => {
            if (failedAfter > 0) {
              callback(Object.assign(new Error("disk full"), { code: "ENOSPC" }));
              return;
            }
            failedAfter += chunk.length;
            write(chunk, encoding, callback);
          };
          return stream;
        };
        return handle;
      },
    };
    try {
      await assert.rejects(
        withSavableFile(source, { root: botHome, fsp }, ({ copyTo }) => copyTo(destination)),
        { message: "disk full" },
      );
      assert.ok(failedAfter > 0 && failedAfter < SIZE, "the failure happened part-way through the copy");
      assert.equal(fs.readFileSync(destination, "utf8"), "keep me");
      assert.equal(sha256(source), digest);
      assert.deepEqual(staging(home), []);
    } finally {
      fs.rmSync(destination, { force: true });
    }
  });

  it("refuses a directory or relative destination without writing anything", async () => {
    const directory = path.join(home, "large-dir");
    fs.mkdirSync(directory);
    try {
      await assert.rejects(
        withSavableFile(source, { root: botHome }, ({ copyTo }) => copyTo(directory)),
        { message: "That destination is not a file" },
      );
      await assert.rejects(
        withSavableFile(source, { root: botHome }, ({ copyTo }) => copyTo("large.bin")),
        { message: "Choose where to save the file" },
      );
      assert.deepEqual(fs.readdirSync(directory), []);
      assert.deepEqual(staging(home), []);
      assert.equal(sha256(source), digest);
    } finally {
      safeWipeSync(directory);
    }
  });
});

describe("desktop:save-file handler root resolution (B3)", () => {
  const ORIGIN = "http://127.0.0.1:8799";
  function ownedMainWindow(url = `${ORIGIN}/`) {
    const mainFrame = { url, detached: false };
    const webContents = { mainFrame, isDestroyed: () => false };
    return { window: { webContents, isDestroyed: () => false }, event: { sender: webContents, senderFrame: mainFrame } };
  }

  let selected;
  let downloads;
  beforeEach(() => {
    // The selected (recovered or custom) installation this process owns, while
    // MURAGE_DATA_DIR and ~/.murage still name the retained original.
    selected = fs.mkdtempSync(path.join(os.tmpdir(), "murage-selected-root-"));
    fs.mkdirSync(path.join(selected, "workspaces", "bot"), { recursive: true });
    fs.writeFileSync(path.join(selected, "workspaces", "bot", "report.md"), "selected");
    downloads = fs.mkdtempSync(path.join(os.tmpdir(), "murage-save-downloads-"));
  });
  afterEach(() => {
    safeWipeSync(selected);
    safeWipeSync(downloads);
  });

  function handlerFor(state, { window, url } = {}) {
    const owned = ownedMainWindow(url);
    const dialogs = [];
    const revealed = [];
    const handler = createSaveFileHandler({
      window: () => window ?? owned.window,
      origin: () => ORIGIN,
      activeRoot: () => activeDesktopDataRoot(state),
      chooseDestination: async ({ defaultName }) => {
        dialogs.push(defaultName);
        return path.join(downloads, defaultName);
      },
      reveal: (file) => revealed.push(file),
    });
    return { handler, event: owned.event, dialogs, revealed };
  }

  const packagedOwner = () => ({
    packaged: true,
    recovery: false,
    closing: false,
    owner: { release() {} },
    dataDirectory: selected,
    env: { MURAGE_DATA_DIR: botHome },
    home,
  });

  it("saves from the selected installation and refuses the retained default before any dialog", async () => {
    const { handler, event, dialogs, revealed } = handlerFor(packagedOwner());
    const saved = await handler(event, path.join(selected, "workspaces", "bot", "report.md"));
    assert.equal(saved, path.join(downloads, "report.md"));
    assert.equal(fs.readFileSync(saved, "utf8"), "selected");
    assert.deepEqual(revealed, [saved]);

    await assert.rejects(handler(event, path.join(botHome, "workspaces", "bot", "report.docx")), { message: OUTSIDE_ROOT });
    assert.deepEqual(dialogs, ["report.md"], "the refused default-root file never opened a dialog");
  });

  it("refuses during recovery, while closing, without ownership and from an untrusted sender before any dialog", async () => {
    const file = path.join(selected, "workspaces", "bot", "report.md");
    const cases = [
      [{ ...packagedOwner(), recovery: true }, {}, "NATIVE_ROOT_RECOVERY"],
      [{ ...packagedOwner(), closing: true }, {}, "NATIVE_ROOT_CLOSING"],
      [{ ...packagedOwner(), owner: null }, {}, "NATIVE_ROOT_UNOWNED"],
      [packagedOwner(), { url: "https://example.com/" }, "NATIVE_SENDER_UNTRUSTED"],
      [packagedOwner(), { window: ownedMainWindow().window }, "NATIVE_SENDER_UNTRUSTED"],
    ];
    for (const [state, sender, code] of cases) {
      const { handler, event, dialogs } = handlerFor(state, sender);
      await assert.rejects(handler(event, file), { code }, code);
      assert.deepEqual(dialogs, [], `${code} refused before the dialog`);
    }
    assert.deepEqual(fs.readdirSync(downloads), []);
  });

  it("uses the explicit development fixture root, or ~/.murage when none is set", () => {
    const fixture = path.join(os.tmpdir(), "murage-dev-fixture");
    assert.equal(activeDesktopDataRoot({ packaged: false, env: { MURAGE_DATA_DIR: fixture }, home }), fixture);
    assert.equal(activeDesktopDataRoot({ packaged: false, env: {}, home }), path.join(home, ".murage"));
    assert.throws(() => activeDesktopDataRoot({ packaged: false, env: { MURAGE_DATA_DIR: "" }, home }), { code: "NATIVE_ROOT_UNOWNED" });
    assert.throws(() => activeDesktopDataRoot({ packaged: false, recovery: true, env: {}, home }), { code: "NATIVE_ROOT_RECOVERY" });
  });
});
