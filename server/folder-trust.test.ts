// Murage's per-folder trust record (0.1.52 FUIGOTRUST1): the scan that names
// what a folder would contribute to a Fuigo turn, the trust key that mirrors
// upstream `workspace_key` (git root, else the folder; home and filesystem
// roots never), and the durable store the driver decides from.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, parse } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  FolderTrustStore,
  canonicalFolder,
  folderTrustKey,
  folderTrustKindNames,
  gitRootOf,
  isUnrecordableTrustRoot,
  scanFolderTrustSources,
} from "./folder-trust.ts";
import { removeTempDir } from "./testing/cleanup.ts";
import { PersistedStateRecoveryError } from "./persisted-state.ts";
import {
  FOLDER_TRUST_OPTIONS,
  folderTrustDecision,
  folderTrustDisplayName,
  folderTrustNotice,
  folderTrustQuestion,
  folderTrustWithheldName,
} from "../shared/folder-trust.ts";

let root: string;
beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "murage-folder-trust-")));
});
afterEach(async () => {
  await removeTempDir(root);
});

const repo = (name: string) => {
  const dir = join(root, name);
  mkdirSync(join(dir, ".git"), { recursive: true });
  return dir;
};

describe("scanFolderTrustSources", () => {
  it("names nothing for a plain folder, so no card is ever raised for it", () => {
    const dir = join(root, "plain");
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "README.md"), "hi");
    expect(scanFolderTrustSources(dir)).toEqual({ key: dir, folder: dir, sources: [] });
  });

  it("names the upstream markers by file: instructions first, then rules, skills, config and hooks", () => {
    const dir = repo("full");
    writeFileSync(join(dir, "AGENTS.md"), "# a");
    writeFileSync(join(dir, "CLAUDE.md"), "# c");
    writeFileSync(join(dir, ".mcp.json"), "{}");
    writeFileSync(join(dir, ".envrc"), "export X=1");
    mkdirSync(join(dir, ".fuigo", "skills"), { recursive: true });
    mkdirSync(join(dir, ".claude", "rules"), { recursive: true });
    mkdirSync(join(dir, ".fuigo", "hooks"), { recursive: true });
    writeFileSync(join(dir, ".claude", "settings.json"), "{}");
    expect(scanFolderTrustSources(dir).sources).toEqual([
      "AGENTS.md",
      "CLAUDE.md",
      ".claude/rules",
      ".fuigo/skills",
      ".mcp.json",
      ".claude/settings.json",
      ".envrc",
      ".fuigo/hooks",
    ]);
  });

  it("walks from a subfolder up to the git root, like the engine's loaders, and keys on the root", () => {
    const dir = repo("walk");
    writeFileSync(join(dir, "AGENTS.md"), "# root instructions");
    const sub = join(dir, "crates", "inner");
    mkdirSync(sub, { recursive: true });
    mkdirSync(join(sub, ".agents", "commands"), { recursive: true });
    expect(scanFolderTrustSources(sub)).toEqual({ key: dir, folder: sub, sources: ["AGENTS.md", ".agents/commands"] });
  });

  it("does not walk past a git root into a parent's markers", () => {
    writeFileSync(join(root, "AGENTS.md"), "# outside");
    const dir = repo("bounded");
    expect(scanFolderTrustSources(dir).sources).toEqual([]);
    // and a folder outside any repository only looks at itself
    const loose = join(root, "loose", "deeper");
    mkdirSync(loose, { recursive: true });
    expect(scanFolderTrustSources(loose)).toEqual({ key: loose, folder: loose, sources: [] });
  });

  it("a clone with its own .git inside a trusted folder is its own workspace", () => {
    const dir = repo("outer");
    writeFileSync(join(dir, "AGENTS.md"), "# outer");
    const clone = join(dir, "vendor", "evil");
    mkdirSync(join(clone, ".git"), { recursive: true });
    writeFileSync(join(clone, "CLAUDE.md"), "# evil");
    expect(folderTrustKey(clone)).toBe(clone);
    expect(scanFolderTrustSources(clone).sources).toEqual(["CLAUDE.md"]);
    expect(gitRootOf(join(clone, "src"))).toBe(clone);
  });
});

describe("trust keys", () => {
  it("never records the home folder or a filesystem root, and reads a home-rooted repo as its folder", () => {
    expect(isUnrecordableTrustRoot(homedir())).toBe(true);
    expect(isUnrecordableTrustRoot(parse(root).root)).toBe(true);
    expect(isUnrecordableTrustRoot("relative/path")).toBe(true);
    expect(isUnrecordableTrustRoot(root)).toBe(false);
    expect(canonicalFolder(join(root, "missing"))).toBe(join(root, "missing"));
  });

  it("maps the engine's configKinds to names a person recognises", () => {
    expect(folderTrustKindNames(["instructions", "mcp", "skills", 7, "banana"])).toEqual([
      "AGENTS.md / CLAUDE.md",
      "MCP servers (.mcp.json)",
      "project skills",
      "banana",
    ]);
  });
});

describe("FolderTrustStore", () => {
  it("remembers a decision for the folder's whole workspace and persists it with the data", () => {
    const dir = repo("kept");
    const sub = join(dir, "pkg");
    mkdirSync(sub, { recursive: true });
    const file = join(root, "folder-trust.json");
    const store = new FolderTrustStore(file);
    expect(store.decision(dir)).toBeUndefined();
    expect(store.remember(sub, "trust", "picker")).toBe(dir);
    expect(store.decision(dir)).toBe("trust");
    expect(store.decision(sub)).toBe("trust");
    expect(store.record(sub)).toMatchObject({ decision: "trust", source: "picker", folder: sub });
    const reopened = new FolderTrustStore(file);
    expect(reopened.decision(join(dir, "another", "deeper"))).toBe("trust");
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ version: 1, folders: { [dir]: { decision: "trust" } } });
    // a later answer replaces the earlier one; forget asks again next time
    reopened.remember(dir, "reject", "card");
    expect(new FolderTrustStore(file).decision(sub)).toBe("reject");
    expect(reopened.forget(sub)).toBe(true);
    expect(new FolderTrustStore(file).decision(dir)).toBeUndefined();
    expect(reopened.forget(sub)).toBe(false);
  });

  it("refuses to record the home folder, and treats a damaged file as state to recover, never as empty", () => {
    const file = join(root, "folder-trust.json");
    const store = new FolderTrustStore(file);
    expect(store.remember(homedir(), "trust", "picker")).toBeNull();
    expect(store.decision(homedir())).toBeUndefined();
    writeFileSync(file, "{not json");
    expect(() => new FolderTrustStore(file)).toThrow(PersistedStateRecoveryError);
  });

  it("ignores records that do not carry a decision", () => {
    const file = join(root, "folder-trust.json");
    writeFileSync(file, JSON.stringify({ version: 1, folders: { [root]: { decision: "maybe", decidedAt: 1, folder: root }, [join(root, "ok")]: { decision: "reject", decidedAt: 1, source: "card", folder: join(root, "ok") } } }));
    const store = new FolderTrustStore(file);
    expect(store.list().map((r) => r.key)).toEqual([join(root, "ok")]);
  });
});

describe("the card and the chip (shared)", () => {
  it("asks one question about the folder with the two answers and no free text", () => {
    const question = folderTrustQuestion({ key: "/repo", folder: "/repo/app", sources: ["AGENTS.md", ".mcp.json"] });
    expect(question).toMatchObject({ id: "folderTrust", header: "Folder trust", multiSelect: false, allowOther: false });
    expect(question.question).toContain("/repo/app");
    expect(question.question).toContain("AGENTS.md, .mcp.json");
    expect(question.options.map((o) => o.label)).toEqual([FOLDER_TRUST_OPTIONS.trust, FOLDER_TRUST_OPTIONS.reject]);
    expect(folderTrustDecision([{ id: "folderTrust", selected: [FOLDER_TRUST_OPTIONS.trust] }])).toBe("trust");
    expect(folderTrustDecision([{ id: "folderTrust", selected: [FOLDER_TRUST_OPTIONS.reject] }])).toBe("reject");
    expect(folderTrustDecision([{ id: "folderTrust", selected: ["Yes"] }])).toBeNull();
    expect(folderTrustDecision([])).toBeNull();
  });

  it("names what was withheld, bounded, and reads it back for the transcripts", () => {
    const name = folderTrustWithheldName(["AGENTS.md", "CLAUDE.md", ".mcp.json", ".fuigo/skills", ".claude/rules", ".envrc", ".fuigo/hooks", ".fuigo/agents"]);
    expect(name).toBe("untrusted folder: AGENTS.md, CLAUDE.md, .mcp.json, .fuigo/skills, .claude/rules, .envrc and 2 more");
    expect(folderTrustNotice(name)).toEqual({ kind: "withheld", sources: "AGENTS.md, CLAUDE.md, .mcp.json, .fuigo/skills, .claude/rules, .envrc and 2 more" });
    expect(folderTrustDisplayName("trusted folder: AGENTS.md")).toBe("Folder trusted — AGENTS.md apply from the next turn");
    expect(folderTrustNotice("stopped: the model connection was turned off")).toBeUndefined();
    expect(folderTrustNotice("error: boom")).toBeUndefined();
    expect(folderTrustNotice(undefined)).toBeUndefined();
  });
});
