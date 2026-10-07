import { describe, expect, it } from "vitest";
import { approvalDetail, formatsToolInput, visibleText, type ApprovalDetail } from "./approval-detail";

/** Everything an owner can read on the card, expanded lines included. */
function visible(d: ApprovalDetail): string {
  return [d.primary, d.secondary, ...d.extra.map(l => l.full ?? l.text)].filter(Boolean).join("\n");
}

describe("approvalDetail: file tools", () => {
  it("shows the path for known file tools", () => {
    for (const tool of ["Write", "Read", "NotebookEdit", "MultiEdit", "Edit"]) {
      const d = approvalDetail(tool, { file_path: "Newsletter/Spring offers.md", notebook_path: undefined });
      expect(d.primary).toBe("Newsletter/Spring offers.md");
      expect(d.mono).toBe(false);
    }
  });

  it("accepts a JSON string and keeps the ORIGINAL text as raw", () => {
    const src = '{"file_path":"a.md","file_path":"/etc/x"}';
    const d = approvalDetail("Write", src);
    expect(d.raw).toBe(src);
  });

  it("Write shows content size and the start of the content", () => {
    const d = approvalDetail("Write", { file_path: "a.md", content: "Line one\nLine two\n" + "x".repeat(500) });
    expect(visible(d)).toContain("Line one");
    expect(d.extra[0]!.text).toMatch(/\d+ characters/);
    expect(d.extra.some(l => l.full?.includes("x".repeat(500)))).toBe(true);
  });

  it("Edit shows replace_all, the real extent and both strings", () => {
    const d = approvalDetail("Edit", { file_path: "a.md", old_string: "cat", new_string: "dog", replace_all: true });
    expect(d.secondary).toBe("changes 1 line, every match");
    const v = visible(d);
    expect(v).toContain("old_string: cat");
    expect(v).toContain("new_string: dog");
    expect(approvalDetail("Edit", { file_path: "a.md", old_string: "x\ny", new_string: "x\ny\nz" }).secondary).toBe("changes 3 lines");
  });

  it("MultiEdit lists every edit", () => {
    const d = approvalDetail("MultiEdit", { file_path: "a.md", edits: [{ old_string: "a", new_string: "b" }, { old_string: "c", new_string: "d", replace_all: true }] });
    expect(d.secondary).toBe("changes 2 lines");
    expect(visible(d)).toContain("edit 2");
    expect(visible(d)).toContain("replace_all");
  });

  it("NotebookEdit shows the mode, including delete, and the source", () => {
    const d = approvalDetail("NotebookEdit", { notebook_path: "n.ipynb", cell_id: "c1", edit_mode: "delete", new_source: "print(1)" });
    expect(d.primary).toBe("n.ipynb");
    expect(d.secondary).toBe("deletes a cell");
    expect(visible(d)).toContain("edit_mode: delete");
    expect(visible(d)).toContain("new_source: print(1)");
    expect(visible(d)).toContain("cell_id: c1");
  });
});

describe("approvalDetail: matching is by tool name", () => {
  it("an unknown tool with a path shows every key", () => {
    const d = approvalDetail("mcp__github__create_or_update_file", { path: "x.md", content: "hello", repo: "r", branch: "main" });
    const v = visible(d);
    for (const s of ["path: x.md", "content: hello", "repo: r", "branch: main"]) expect(v).toContain(s);
  });

  it("an mcp tool named like a built-in gets no built-in treatment", () => {
    const d = approvalDetail("mcp__x__read", { path: "a", delete: true });
    expect(visible(d)).toContain("delete: true");
    const sh = approvalDetail("mcp__x__bash", { command: "ls", sudo: true });
    expect(visible(sh)).toContain("sudo: true");
    expect(sh.mono).toBe(false);
  });

  it("a url with a method keeps the method visible", () => {
    const d = approvalDetail("mcp__http__request", { url: "https://x.test/a", method: "DELETE" });
    expect(visible(d)).toContain("https://x.test/a");
    expect(visible(d)).toContain("method: DELETE");
    const d2 = approvalDetail("WebFetch", { url: "https://x.test/a", method: "DELETE" });
    expect(visible(d2)).toContain("method: DELETE");
  });

  it("web tools show the url or query as the headline", () => {
    expect(approvalDetail("WebSearch", { query: "spring offers" })).toMatchObject({ primary: "spring offers", mono: false });
  });

  it("a five-key input shows all five keys", () => {
    const d = approvalDetail("mystery", { a: 1, b: 2, c: 3, d: 4, e: 5 });
    const v = visible(d);
    for (const k of "abcde") expect(v).toContain(`${k}: `);
  });

  it("long values are cut visibly and expand to the full text", () => {
    const d = approvalDetail("mystery", { a: "1", dest: "Documents/" + "x".repeat(150) + "/../../Library/LaunchAgents/x.plist" });
    const long = d.extra.find(l => l.text.startsWith("dest"))!;
    expect(long.full).toContain("LaunchAgents/x.plist");
    expect(long.text.length).toBeLessThan(long.full!.length);
    expect(long.hidden).toBe(long.full!.length - long.text.length + 1);
  });

  it("nested arguments are expanded key by key", () => {
    const d = approvalDetail("mcp__composio__THING", { arguments: { to: "a", amount: 10000, memo: "m", note: "n" } });
    const v = visible(d);
    for (const s of ["to: a", "amount: 10000", "memo: m", "note: n"]) expect(v).toContain(s);
    expect(v).not.toContain("arguments: …");
  });
});

describe("approvalDetail: shell", () => {
  it("the command is the full mono headline", () => {
    const cmd = "rm -rf build && " + "echo ".repeat(100);
    expect(approvalDetail("Bash", { command: cmd })).toMatchObject({ primary: cmd, mono: true });
  });

  it("a description goes below, labelled, never above", () => {
    const d = approvalDetail("Bash", { command: "rm -rf build", description: "Say hi to Ann" });
    expect(d.primary).toBe("rm -rf build");
    expect(d.mono).toBe(true);
    expect(d.secondary).toBe("Bot's note: Say hi to Ann");
  });

  it("other arguments stay visible", () => {
    expect(visible(approvalDetail("Bash", { command: "ls", timeout: 5000 }))).toContain("timeout: 5000");
  });
});

describe("approvalDetail: email", () => {
  it("shows to, subject, cc, bcc and attachments", () => {
    const d = approvalDetail("mcp__composio__GMAIL_SEND_EMAIL", { recipient_email: "ann@x.com", subject: "Hello", cc: ["c@x.com"], bcc: ["spy@evil.com"], attachment: { name: "a.pdf" }, body: "hi" });
    expect(d.primary).toBe("To: ann@x.com");
    expect(d.secondary).toBe("Subject: Hello");
    const v = visible(d);
    for (const s of ["cc: c@x.com", "bcc: spy@evil.com", "attachment:", "body: hi"]) expect(v).toContain(s);
  });

  it("works through nested arguments and does not treat post as email", () => {
    const d = approvalDetail("mcp__composio__GMAIL_SEND_EMAIL", { arguments: { to: ["a@x.com", "b@x.com"], bcc: "z@x.com" } });
    expect(d.primary).toBe("To: a@x.com, b@x.com");
    expect(visible(d)).toContain("bcc: z@x.com");
    expect(approvalDetail("post_update", { to: "a", x: 1 }).primary).not.toBe("To: a");
  });
});

describe("formatsToolInput and verbatim text", () => {
  it("never formats peer-bot, browser-extension or empty tools", () => {
    for (const t of ["ask_bot", "delegate", "browser_extension_action", "", undefined]) expect(formatsToolInput(t)).toBe(false);
    expect(formatsToolInput("Write")).toBe(true);
  });

  it("passes non-JSON text through", () => {
    expect(approvalDetail("Bash", "ls -la")).toMatchObject({ primary: "ls -la", mono: true });
    expect(approvalDetail("mystery", "").primary).toBe("");
  });
});

describe("round 2", () => {
  it("Write with indented early lines never hides the tail without a count", () => {
    for (const pad of [30, 300]) {
      const d = approvalDetail("Write", { file_path: "a.py", content: `a\n${" ".repeat(pad)}b\n${" ".repeat(pad)}c\nevil()` });
      const preview = d.extra[1]!;
      if (preview.text.includes("evil()")) continue;
      expect(preview.hidden).toBeGreaterThan(0);
      expect(preview.full).toContain("evil()");
    }
    const long = approvalDetail("Write", { file_path: "a.py", content: `a\n${"b".repeat(200)}\nevil()` }).extra[1]!;
    expect(long.hidden).toBeGreaterThan(0);
    expect(long.full).toContain("evil()");
  });

  it("a recipient array with a non-string entry is listed as a normal key", () => {
    const d = approvalDetail("mcp__gmail__send_email", { to: ["a@x.com", { email: "evil@y.com" }], subject: "hi" });
    expect(visible(d)).toContain("evil@y.com");
    expect(d.primary).not.toBe("To: a@x.com");
  });

  it("formats only mcp tools and exact-case Claude built-ins", () => {
    for (const tool of ["edit", "shell", "read", "write", "bash", "execute", "other", "Shell", "WRITE"]) expect(formatsToolInput(tool)).toBe(false);
    for (const tool of ["Bash", "Write", "Edit", "MultiEdit", "NotebookEdit", "Read", "WebFetch", "WebSearch", "mcp__x__y"]) expect(formatsToolInput(tool)).toBe(true);
  });

  it("counts characters as graphemes and never splits one", () => {
    const d = approvalDetail("mystery", { a: "1", b: "🇮🇪".repeat(100) });
    const l = d.extra[0]!;
    expect(l.text.endsWith("…")).toBe(true);
    expect(l.text).not.toMatch(/[\ud800-\udbff]…$/);
    expect(l.hidden).toBe(100 + 3 - 80);
    expect(l.text.replace("…", "").replace(/^b: /, "").length % "🇮🇪".length).toBe(0);
  });

  it("a non-text Bash description is shown as a key: value line", () => {
    const d = approvalDetail("Bash", { command: "ls", description: { run: "evil" } });
    expect(visible(d)).toContain("description:");
    expect(visible(d)).toContain("evil");
  });

  it("A1: only the path key that supplied the headline is consumed", () => {
    const d = approvalDetail("Read", { file_path: "notes.md", path: "/etc/shadow" });
    expect(d.primary).toBe("notes.md");
    expect(visible(d)).toContain("path: /etc/shadow");
  });

  it("A2: bidi controls, zero-width characters and stacked marks are shown as escapes", () => {
    const d = approvalDetail("Write", { file_path: "safe.txt‮⁦gpj.exe", content: "a​b" });
    expect(d.primary).toBe("safe.txt⟨U+202E⟩⟨U+2066⟩gpj.exe");
    expect(visible(d)).toContain("a⟨U+200B⟩b");
    expect(d.raw).not.toMatch(/[‪-‮⁦-⁩​-‏﻿⁠]/);
    expect(d.raw).toContain("⟨U+202E⟩");
    const z = approvalDetail("mcp__x__y", { name: "a﻿b‏c⁠d" });
    expect(visible(z)).toContain("a⟨U+FEFF⟩b⟨U+200F⟩c⟨U+2060⟩d");
    expect(visibleText("a" + "́".repeat(60))).toBe("á́́…");
    expect(approvalDetail("Write", { file_path: "a" + "́".repeat(60) }).primary.length).toBeLessThan(10);
  });

  it("A3: MultiEdit lists non-object edits verbatim", () => {
    const d = approvalDetail("MultiEdit", { file_path: "a.md", edits: [{ old_string: "a", new_string: "b" }, "rm", null, 7] });
    const v = visible(d);
    expect(v).toContain("edit 2: rm");
    expect(v).toContain("edit 3: null");
    expect(v).toContain("edit 4: 7");
  });

  it("A4: replace_all is only consumed when boolean", () => {
    const d = approvalDetail("Edit", { file_path: "a.md", old_string: "a", new_string: "b", replace_all: "yes" });
    expect(visible(d)).toContain("replace_all: yes");
    const ok = approvalDetail("Edit", { file_path: "a.md", old_string: "a", new_string: "b", replace_all: false });
    expect(visible(ok)).not.toContain("replace_all");
  });

  it("A5: strings that look like literals are quoted", () => {
    const d = approvalDetail("mcp__x__share", { public: "false", n: "7", z: "null", ok: false, list: ["a, b", "c"] });
    const v = visible(d);
    expect(v).toContain('public: "false"');
    expect(v).toContain('n: "7"');
    expect(v).toContain('z: "null"');
    expect(v).toContain("ok: false");
    expect(v).toContain('list: ["a, b","c"]');
  });
});
