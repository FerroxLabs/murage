// "Folders you decided on" (S6), rendered in node like the note's own tests:
// every row state with its exact copy, the onPath grouping, the disclosure,
// the engine's own trust file rows, and the Forget request. The outcomes the
// Forget sentences promise are proved in server/folder-trust-v2-settings.test.ts.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { en } from "@/locales";
import { FolderTrustNoteView, folderTrustForgetKeyPath, type FolderTrustRecordRow, type FolderTrustResult, type FolderTrustStatus } from "./FolderTrustNote";
import { FolderTrustRecords } from "./FolderTrustRecords";

const FILE = "/home/u/.fuigo/trusted_folders.toml";
const row = (over: Partial<FolderTrustRecordRow>): FolderTrustRecordRow => ({ key: "/work/repo", folder: "/work/repo", decision: "trust", consent: 2, source: "card", decidedAt: 1, onPath: true, ...over });
const status = (over: Partial<FolderTrustStatus> = {}): FolderTrustStatus => ({ gated: true, sources: [], record: null, upstreamStore: "own", engineGates: true, upstreamTrustFile: FILE, upstreamDeclines: [], upstreamUnreadable: false, trustGeneration: 2, records: [], ...over });
const result = (over: Partial<FolderTrustStatus> = {}, id = "b1"): FolderTrustResult => ({ subject: { id, name: id }, status: status(over) });
const html = (results: FolderTrustResult[]) => renderToStaticMarkup(createElement(FolderTrustRecords, { results, busy: false, onForgetKey: () => {} }));
/** The text a person reads, in order, one entry per element. */
const text = (markup: string) => markup.replace(/<[^>]+>/g, "\n").split("\n").map((line) => line.trim().replace(/&#x27;/g, "'")).filter(Boolean);

describe("record rows (S8 test 9)", () => {
  it("a reject row reads the owner's answer and says what Forget does before the click", () => {
    expect(text(html([result({ records: [row({ decision: "reject", consent: undefined })] })]))).toEqual([
      "Folders you decided on",
      "/work/repo",
      "Not trusted (your answer)",
      "Forget",
      "Murage forgets this answer. Other trust decisions still apply, so Fuigo may continue without asking.",
    ]);
  });

  // S6's and U2's sentences promised a question the engine may never ask
  it("(13e) the reject sentence is exactly the one the design binds, and the older ones are gone", () => {
    expect(en["folderTrust.forgetReject"]).toBe("Murage forgets this answer. Other trust decisions still apply, so Fuigo may continue without asking.");
    const all = Object.values(en).join("\n");
    expect(all).not.toContain("Fuigo asks again next time");
    expect(all).not.toContain("Otherwise Fuigo asks next time");
  });

  it("a consent 2 trust on the owner's home names the line that keeps it (N10)", () => {
    expect(text(html([result({ records: [row({})] })])).slice(1)).toEqual([
      "/work/repo",
      "Trusted",
      "Forget",
      `Removes Murage's decision. Your own Fuigo keeps trusting /work/repo until you delete its line in ${FILE}.`,
    ]);
  });

  it("a routed home has no line to name, so the row says the first sentence alone and promises no card", () => {
    const out = text(html([result({ upstreamStore: "temporary", upstreamTrustFile: null, records: [row({})] })]));
    expect(out).toContain("Removes Murage's decision.");
    expect(out.join("\n")).not.toContain("Your own Fuigo");
  });

  it("an unstamped trust reads its own state under a generation 2 engine, and names no line it never wrote", () => {
    const out = text(html([result({ records: [row({ consent: undefined })] })]));
    expect(out).toContain("Trusted before Fuigo 1.0.35. Fuigo asks once more");
    expect(out).toContain("Removes Murage's decision.");
    expect(out.join("\n")).not.toContain("Your own Fuigo");
    // an older engine honours it, so it is simply trusted
    const older = text(html([result({ trustGeneration: 1, records: [row({ consent: undefined })] })]));
    expect(older).toContain("Trusted");
    expect(older.join("\n")).not.toContain("asks once more");
  });

  it("a decision made in another folder says where, and one made here does not", () => {
    expect(text(html([result({ records: [row({ key: "/work/main", folder: "/work/tree/sub" })] })]))).toContain("decided in /work/tree/sub");
    expect(html([result({ records: [row({})] })])).not.toContain("decided in");
  });
});

describe("grouping and the disclosure", () => {
  const records = [row({ key: "/near" , folder: "/near" }), row({ key: "/far/a", folder: "/far/a", onPath: false }), row({ key: "/far/b", folder: "/far/b", onPath: false })];

  it("on-path rows stay open and the rest sit behind a closed disclosure with its one line", () => {
    const markup = html([result({ records })]);
    const details = markup.slice(markup.indexOf("<details"));
    expect(markup.slice(0, markup.indexOf("<details"))).toContain('data-folder-trust-key="/near"');
    expect(details).toContain('data-folder-trust-key="/far/a"');
    expect(details).toContain('data-folder-trust-key="/far/b"');
    expect(markup).toMatch(/<details(?![^>]*\bopen\b)[^>]*>/);
    expect(text(details)).toContain("2 other folders");
    expect(text(details)).toContain("Fuigo can count a decision for this folder's repository even when it is listed under another path.");
  });

  it("reads one record as one folder, and no disclosure with nothing to hide", () => {
    expect(text(html([result({ records: records.slice(0, 2) })]))).toContain("1 other folder");
    expect(html([result({ records: records.slice(0, 1) })])).not.toContain("<details");
  });

  it("keeps no open-or-closed memory: the disclosure's state lives in the element alone", () => {
    const source = readFileSync(fileURLToPath(new URL("./FolderTrustRecords.tsx", import.meta.url)), "utf8");
    expect(source).not.toMatch(/localStorage|sessionStorage|useState/);
  });

  it("nothing decided and nothing in the engine's file renders nothing", () => {
    expect(html([result()])).toBe("");
  });
});

describe("the engine's own trust file (N11 test 19)", () => {
  it("lists every stored no verbatim, with the real path and no Forget of its own", () => {
    const keys = ["/plain", "/slash/", "relative/key"];
    const out = text(html([result({ upstreamDeclines: keys })]));
    expect(out).toEqual(keys.map((key) => `Your own Fuigo says don't trust ${key}. To change that, delete its line in ${FILE} and send the message again.`));
  });

  it("names the unreadable file and how to recover", () => {
    expect(text(html([result({ upstreamUnreadable: true })]))).toEqual([
      `Fuigo's trust file at ${FILE} could not be read, so nothing is trusted here. Make it readable and valid TOML, or remove it, then send the message again.`,
    ]);
  });

  it("a routed conversation has no block, whatever it was sent", () => {
    expect(html([result({ upstreamStore: "temporary", upstreamTrustFile: null })])).toBe("");
    expect(html([result({ upstreamStore: "temporary", upstreamDeclines: ["/x"], upstreamUnreadable: true })])).toBe("");
  });

  it("a room with two own homes lists both paths, and one file only once", () => {
    const two = html([result({ records: [row({})], upstreamDeclines: ["/x"] }, "a"), result({ upstreamTrustFile: "/other/trusted_folders.toml" }, "b")]);
    expect(text(two).join("\n")).toContain(`until you delete its line in ${FILE}, /other/trusted_folders.toml.`);
    const same = html([result({ upstreamDeclines: ["/x"] }, "a"), result({ upstreamDeclines: ["/x"] }, "b")]);
    expect(same.match(/folder-trust-stored-no/g)).toHaveLength(1);
  });
});

describe("Forget by key", () => {
  it("sends the exact stored key, encoded, whatever folder the note shows", () => {
    expect(folderTrustForgetKeyPath("thread=t1&bot=b1", "/work/a b&c")).toBe("/api/folder-trust?thread=t1&bot=b1&key=%2Fwork%2Fa%20b%26c");
  });

  it("the note renders the block in the conversation and picker views, and keeps today's record row", () => {
    const base = { error: null, busy: false, onForget: () => {}, onForgetKey: () => {} };
    const results = [result({ sources: ["AGENTS.md"], record: { decision: "reject", decidedAt: 1, source: "card" }, records: [row({ decision: "reject", consent: undefined })] })];
    for (const props of [{ folder: "/work/repo", results }, { folder: undefined, results, conversation: true, onTrust: () => {} }]) {
      const markup = renderToStaticMarkup(createElement(FolderTrustNoteView, { ...base, ...props }));
      expect(markup).toContain('data-testid="folder-trust-records"');
      expect(markup).toContain('data-folder-trust-status="reject"');
      expect(markup.match(/>Forget</g)).toHaveLength(2);
    }
  });

  it("a Forget's failure says so, and the list reads the server again either way", () => {
    const note = readFileSync(fileURLToPath(new URL("./FolderTrustNote.tsx", import.meta.url)), "utf8");
    const forget = note.slice(note.indexOf("const forgetKey = async"));
    expect(forget.slice(0, forget.indexOf("  };"))).toMatch(/method: "DELETE"[\s\S]*forgetError[\s\S]*finally[\s\S]*await read\(\)/);
  });
});

describe("what S6 removed, and copy rule 9", () => {
  it("no asked-about block and no answeredBy state survives on the screen", () => {
    const source = ["./FolderTrustNote.tsx", "./FolderTrustRecords.tsx"].map((file) => readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8")).join("\n");
    expect(source).not.toContain("answeredBy");
    expect(Object.values(en).join("\n")).not.toContain("Fuigo asked about");
  });

  it("every new line is plain: no em dash, never the banned word, and nothing says commands stop asking", () => {
    const keys = Object.keys(en).filter((key) => /^folderTrust\.(forget|row|decided|other|storedNo|unreadable)/.test(key));
    expect(keys.length).toBeGreaterThanOrEqual(14);
    for (const key of keys) {
      const line = en[key as keyof typeof en] as string;
      expect(line).not.toContain("—");
      expect(line.toLowerCase()).not.toMatch(/\bsafe\b/);
      expect(line.toLowerCase()).not.toMatch(/commands? (stop|no longer|will not|won't)/);
    }
  });
});
