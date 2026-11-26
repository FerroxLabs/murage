// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { constants, linkSync, renameSync, symlinkSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { MAX_SKILL_FOLDER_BYTES, READ_TIMEOUT_MS } from "../claude-code-import.ts";
import { AnchoredWinFake } from "../testing/anchored-win-fake.ts";
import { GUIDE, MARKER, readerFixture } from "./fixture.ts";

describe.skipIf(process.platform === "win32")("anchored source", () => {
  const f = readerFixture();
  const path = (...parts: string[]) => join(f.home, ".codex", ...parts);
  const config = '[mcp_servers.valid]\ncommand = "sample"';

  it("K5c does not follow a config symlink or read a hard-linked config", async () => {
    const outside = f.put("outside/settings.toml", config);
    f.put("home/.codex/keep", "");
    symlinkSync(outside, path("config.toml"));
    const result = await f.read("codex", { scope: "mcp" });
    expect(result).toMatchObject({ status: "unreadable", servers: [] });
    const call = f.calls.find(call => call.path === path("config.toml"));
    expect(call).toBeDefined();
    const noFollow = process.platform === "darwin" ? 0x20000000 : constants.O_NOFOLLOW;
    expect(call!.flags & noFollow).toBe(noFollow);
    expect(f.bytes).toEqual([]);
    linkSync(outside, path("config2.toml"));
    renameSync(path("config2.toml"), path("config.toml"));
    expect(await f.read("codex", { scope: "mcp" })).toMatchObject({ status: "unreadable", servers: [] });
    expect(f.bytes).toEqual([]);
  });

  it("K5c refuses a skill-root swap", async () => {
    f.put("home/.codex/skills/guide/SKILL.md", GUIDE);
    f.put("outside/guide/SKILL.md", MARKER);
    const root = path("skills");
    let swapped = false;
    const result = await f.read("codex", { scope: "skills" }, {
      ...f.fs,
      readdirSync(p) {
        const entries = f.fs.readdirSync(p);
        if (!swapped) {
          swapped = true;
          renameSync(root, path("saved"));
          symlinkSync(join(f.root, "outside"), root);
        }
        return entries;
      },
    });
    expect(swapped).toBe(true);
    expect(result.skills).toEqual([]);
    expect(f.bytes).toEqual([]);
    // Control: the same tree unswapped is read, so the refusal above is the swap and not a reader that refuses everything.
    unlinkSync(root);
    renameSync(path("saved"), root);
    expect((await f.read("codex", { scope: "skills" })).skills.map(skill => skill.name)).toEqual(["guide"]);
  });

  it("K5c refuses a symlinked override", async () => {
    f.put("outside/skills/guide/SKILL.md", MARKER);
    f.put("home/real/skills/guide/SKILL.md", GUIDE);
    symlinkSync(join(f.root, "outside"), join(f.home, "linked"));
    expect(await f.read("codex", { engineHome: join(f.home, "linked") })).toMatchObject({ status: "unreadable", servers: [], skills: [] });
    expect(f.bytes).toEqual([]);
    // Control: a real directory override is read.
    expect((await f.read("codex", { scope: "skills", engineHome: join(f.home, "real") })).skills.map(skill => skill.name)).toEqual(["guide"]);
  });

  it("K5c revalidates the real opened file after reading", async () => {
    const cfg = f.put("home/.codex/config.toml", config);
    let linked = false;
    const result = await f.read("codex", { scope: "mcp" }, {
      ...f.fs,
      readSync(...args) {
        const n = f.fs.readSync(...args);
        if (!linked) {
          linked = true;
          linkSync(cfg, join(f.root, "new-link"));
        }
        return n;
      },
    });
    expect(linked).toBe(true);
    expect(result).toMatchObject({ status: "unreadable", servers: [] });
  });

  it("K5c refuses a skill with a symlinked companion", async () => {
    const outside = f.put("outside/notes.md", MARKER);
    f.put("home/.codex/skills/guide/SKILL.md", GUIDE);
    symlinkSync(outside, path("skills", "guide", "notes.md"));
    const result = await f.read("codex", { scope: "skills" });
    expect(result).toMatchObject({ status: "ready", skills: [] });
    expect(result.skipped).toEqual([{ name: "guide", ...(process.platform === "darwin" ? {} : { file: "notes.md" }) }]);
    expect(f.bytes).not.toContain(path("skills", "guide", "notes.md"));
  });

  it.each(["file cap", "server cap", "deadline"])("K5d fails the engine whole when the %s is exceeded", async variant => {
    const cfg = f.put("home/.codex/config.toml", variant === "server cap"
      ? Array.from({ length: 201 }, (_, i) => `[mcp_servers.unit${i}]\ncommand = "sample"\n`).join("")
      : config);
    f.put("home/.codex/skills/guide/SKILL.md", GUIDE);
    if (variant === "file cap") f.put("home/.codex/skills/guide/notes.md", Buffer.alloc(MAX_SKILL_FOLDER_BYTES + 1, 32));
    let time = 0;
    const result = await f.read("codex", {}, {
      ...f.fs,
      readSync(...args) {
        const n = f.fs.readSync(...args);
        if (variant === "deadline" && f.bytes.includes(cfg)) time = READ_TIMEOUT_MS + 1;
        return n;
      },
    }, () => time);
    expect(result).toMatchObject({ status: "too-much", servers: [], skills: [] });
  });

  it("carries every eligible file and refuses incomplete or secret-bearing skills", async () => {
    for (const name of ["guide", "binary", "collision", "credential", "invalid", "unsupported"]) {
      f.put(`home/.codex/skills/${name}/SKILL.md`, GUIDE);
    }
    f.put("home/.codex/skills/guide/scripts/helper.py", "print('fixture')\n");
    f.put("home/.codex/skills/guide/notes.md", "details\n");
    f.put("home/.codex/skills/binary/notes.md", Buffer.from([0]));
    f.put("home/.codex/skills/collision/notes.md", "one");
    f.put("home/.codex/skills/collision/Notes.md", "two");
    f.put("home/.codex/skills/credential/notes.md", 'Authorization: Bearer fixture-only-value');
    f.put("home/.codex/skills/invalid/notes.md", Buffer.from([0xc3, 0x28]));
    f.put("home/.codex/skills/unsupported/notes.bin", "unsupported");
    const result = await f.read("codex", { scope: "skills" }, {
      ...f.fs,
      readdirSync(directory, maxNames) {
        const entries = f.fs.readdirSync(directory, maxNames);
        // A source can come from a case-sensitive volume even where the runner's temp volume is case-insensitive.
        return f.expand(directory) === path("skills", "collision") ? [...new Set([...entries, "Notes.md", "notes.md"])] : entries;
      },
    });
    expect(result.skills.map(skill => skill.name)).toEqual(["guide"]);
    expect(result.skills[0]?.files).toEqual([
      { path: "SKILL.md", content: GUIDE }, { path: "notes.md", content: "details\n" },
      { path: "scripts/helper.py", content: "print('fixture')\n" },
    ]);
    expect(result.skipped.map(skill => skill.name)).toEqual(["binary", "collision", "credential", "invalid", "unsupported"]);
    expect(JSON.stringify(result)).not.toContain(MARKER);
  });
});

describe("Windows anchored reader handoff", () => {
  const f = readerFixture();

  it.each(["ETIMEDOUT", "EMFILE"])("K5d discards an earlier snapshot if the native helper reports %s", async code => {
    const native = new AnchoredWinFake({
      ".codex/config.toml": '[mcp_servers.valid]\ncommand = "sample"',
      ".codex/skills/alpha/SKILL.md": GUIDE,
      ".codex/skills/second/SKILL.md": GUIDE,
    });
    if (code === "ETIMEDOUT") native.failOn("anchorRead", 3, code);
    else native.failName("second", code);
    const result = await f.read("codex", {}, { ...f.fs, platform: () => "win32", winAnchor: () => native.anchor });
    expect(native.callsOf("anchorRead").length).toBeGreaterThanOrEqual(2);
    expect(result).toMatchObject({ status: "too-much", servers: [], skills: [] });
    expect(native.openCount()).toBe(0);
    expect(f.opened).toEqual([]);
  });
});
