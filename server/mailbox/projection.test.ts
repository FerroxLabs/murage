import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { KNOWN_FRAME_KINDS } from "../sse-visibility.ts";
import type { Message } from "../store.ts";
import { project, projectFrame } from "./projection.ts";

const sentinel = "mailbox-content-sentinel";
const message = { id: "fixture-row", at: 1, kind: "text", role: "user", parentId: null, seq: 3,
  insertedBefore: "fixture-followup", replyToId: "fixture-reply", turnId: "fixture-turn", sendId: "fixture-send",
} satisfies Message;

describe("common mailbox projection", () => {
  it("S5 retains only approved fields, even with every current field and an unknown field present", () => {
    const file = ts.createSourceFile("store.ts", readFileSync(new URL("../store.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest);
    const declaration = file.statements.find(node => ts.isInterfaceDeclaration(node) && node.name.text === "Message");
    if (!declaration || !ts.isInterfaceDeclaration(declaration)) throw new Error("Message interface is missing");
    const fields = declaration.members.flatMap(member => member.name ? [member.name.getText(file)] : []);
    const all = Object.fromEntries(fields.map(field => [field, sentinel]));
    const full = { ...all, ...message, addedField: sentinel };
    expect(project(full)).toEqual({
      ...message, sealed: true, text: "Email conversation",
    });
  });

  it.each(KNOWN_FRAME_KINDS)("S5b %s drops sender-controlled fields at every depth", kind => {
    const extra = { name: sentinel, label: sentinel, title: sentinel, detail: sentinel, other: sentinel };
    const full = { ...message, ...extra, text: sentinel };
    const projected = projectFrame({
      kind, threadId: "fixture-thread", seq: 2, ...extra, message: full, messages: [full], openCards: [full],
      event: { ...extra, threadId: "fixture-thread", delta: sentinel },
      notification: { ...extra, threadId: "fixture-thread", body: sentinel },
      bot: { id: "fixture-bot", threadId: "fixture-thread", ...extra, messages: [full] },
      group: { id: "fixture-group", threadId: "fixture-thread", ...extra, messages: [full] },
      threadDelta: { ...extra, messages: [full] },
    });
    expect(projected).toMatchObject({ kind, seq: 2, threadId: "fixture-thread" });
    expect(JSON.stringify(projected)).not.toContain(sentinel);
  });
});
