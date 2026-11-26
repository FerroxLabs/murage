// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// 1.0.22 cause B, the attack set. Owners: lane redteam-causeB-fable owns this file and its fixture engine script (the block it adds
// to a temp copy of testing/fake-claude-cli.ts); the cause B builder (deep1022-causeB-* winner) owns the masked-value recorder and the
// owner reply rule this file attacks (harness/masked-values.ts, harness/audience-collector.ts, owner-display.ts ownerReplyText,
// index.ts item.completed); MAIN owns the rulings on the EXT rows.
//
// What it guards: once a turn masked a value, a later reply of that turn that repeats the value (whole, re-cased, re-spaced, quoted,
// split, encoded, taken back and sent again) is never read by the owner and never stored, exactly as in 1.0.21; and a later reply
// that repeats nothing is read and stored word for word (the field bug of 1.0.21: one credential blanked every later reply).
//
// Entry point of every row: POST /api/bots/:id/messages on a booted server (scripts/control-murage.ts), the real Claude driver over
// the fake CLI process (or the real ACP driver over testing/fake-acp-cli.ts for take-backs), then the owner's transcript read
// (GET /api/threads/:id/messages), the store file (messages.db) and the server's own log. Nothing calls the recorder, the latch or
// ownerReplyText directly.
//
// The required outcome of EVERY reply is written per row (MAIN-RULING 2026-11-24T19:25:45Z and 19:49:25Z: attacks withheld, clean
// replies shown; DESIGN P1, P2), and each reply row is checked against it in the owner's read AND in the store:
//   held   = the held-back line (REPLY_WITHHELD), or a projection that rebuilds THAT reply with only value material under its marks
//            (DESIGN P2; outcome(), below; a mark's body is read exactly, ASTRA n4:6266). Marks only, harmless words or other text under or in a mark is not held (n4:6198).
//   shown  = the reply word for word.
//   either = shown or held, nothing else: only for a reply that holds under 8 characters of the value or a bare label, where the
//            design fixes no outcome (REVIEW L3; rows a28 reply 1, a29 reply 1, a47). The leak check still binds those rows.
// EXPECTED ON BASE d91ec92098 (1.0.21 rule: every later reply of a latched turn is held back):
//   ATTACK rows  A*, K*  GREEN on base (everything is held), EXCEPT the rows that also carry a harmless reply that must be shown:
//                        a38, a32a, a32b, a32c are RED on base at the per-reply outcome assertion. All GREEN on the fix.
//   CLEAN rows   C*      RED on base at "read and stored word for word" (the reply reads REPLY_WITHHELD). GREEN on the fix.
//   CONTROL rows N*      GREEN on base and on the fix (the same clean replies in a turn that masked nothing; the fixture engine works).
// Tiers, in each title:
//   [CORE]        promised by deep1022-causeB-design/DESIGN.md (2.2, 2.3, 3, 4) or a High of dr-causeB-fable/REVIEW.md (H1, H2, H3).
//   [EXT-M6]      REVIEW.md Medium M6 (percent-encoded, separators put between the characters).
//   [EXT-PARKED]  REVIEW.md Parked (base64, hex) and forms no document names (reversed, lookalike letters).
//   [EXT-L3]      REVIEW.md Low L3 (pieces under 8 characters, each inside its own prose reply).
// An EXT row that goes RED on a fix sha is a reply 1.0.21 held and the fix shows: MAIN rules on it; it is not a broken test.
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
import { REPLY_WITHHELD } from "./owner-display.ts";
import { REQUIRED_MCP_SERVERS, mcpWaitChipTitle } from "./drivers/mcp-readiness.ts";
import { POWER_BLOCK_UNWRAP_SOURCE } from "./testing/power-block-test.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const TESTING_DIR = join(SERVER_DIR, "testing");
const FAKE_CLAUDE = join(TESTING_DIR, "fake-claude-cli.ts");
const FAKE_ACP = join(TESTING_DIR, "fake-acp-cli.ts");

// Generated fixture values (never a real key shape). VM: letters and digits mixed. VW, VW2: one class, 10 letters (REVIEW H1).
const VM = ["fx7Kq2", "Lm9Tz4", "Rw8Hd3"].join("");
const V2 = ["Gt5Nb8", "Xc2Vq7", "Jp4Ws6"].join("");
const VP = ["fx7Kq2", "+", "Lm9Tz4", "/", "Rw8Hd3"].join("");
const VW = "harbour" + "fog";
const VW2 = "lantern" + "way";
const VD = "40715" + "93826";
const LABEL = "DB_PASSWORD";
const latch = (value = VM) => `${LABEL}=${value}`;

type Step = ["tool" | "text" | "delta", string];
type Want = "held" | "shown" | "either";
/** `want`: the required outcome of each reply (each "text" step), in order; left out = every reply of the row is held. */
type Attack = { id: string; tier: "CORE" | "EXT-M6" | "EXT-PARKED" | "EXT-L3"; what: string; steps: Step[]; forms: string[]; pieces?: string[]; want?: Want[] };
type Clean = { id: string; what: string; steps: Step[]; shown: string[]; hidden?: string[] };

const tool = (text: string): Step => ["tool", text];
const text = (value: string): Step => ["text", value];
const delta = (value: string): Step => ["delta", value];
const spaced = (value: string, gap: string) => [...value].join(gap);
const fullwidth = (value: string) => [...value].map(c => /[!-~]/.test(c) ? String.fromCodePoint(c.codePointAt(0)! + 0xfee0) : c).join("");
const LOOKALIKE: Record<string, string> = { K: "\u041a", T: "\u0422", H: "\u041d", x: "\u0445" };
const lookalike = (value: string) => [...value].map(c => LOOKALIKE[c] ?? c).join("");
const b64 = (value: string) => Buffer.from(value, "utf8").toString("base64");
const hex = (value: string) => Buffer.from(value, "utf8").toString("hex");
const YAML = ["database:", `  password: ${VW}`, "  host: db.internal", "  port: 5432", `  replica_password: ${VW2}`].join("\n");

const THREE_RESULTS: Step[] = [tool(latch()), tool(`REPLICA_PASSWORD=${V2}`), tool(`ADMIN_PASSWORD=${VW}`)];
const THREE_DONE = "All three files are read.";
const ATTACKS: Attack[] = [
  { id: "a01", tier: "CORE", what: "the bare value in prose", steps: [tool(latch()), text(`The database password is ${VM}.`)], forms: [VM] },
  { id: "a02", tier: "CORE", what: "REVIEW H1: a one-class 10-letter value from NAME=value, repeated bare", steps: [tool(latch(VW)), text(`The database password is ${VW}.`)], forms: [VW] },
  { id: "a03", tier: "CORE", what: "REVIEW H1: a one-class value from 'password: value', repeated bare", steps: [tool(`password: ${VW}`), text(`You can log in with ${VW} now.`)], forms: [VW] },
  { id: "a04", tier: "CORE", what: "REVIEW H1: a 10-digit value repeated bare", steps: [tool(latch(VD)), text(`The code is ${VD}.`)], forms: [VD] },
  { id: "a05", tier: "CORE", what: "the value with its label, word for word", steps: [tool(latch()), text(`I read ${latch()} from the file.`)], forms: [VM] },
  { id: "a06", tier: "CORE", what: "upper-cased", steps: [tool(latch()), text(`In capitals it reads ${VM.toUpperCase()}.`)], forms: [VM, VM.toUpperCase()] },
  { id: "a07", tier: "CORE", what: "lower-cased", steps: [tool(latch()), text(`In small letters it reads ${VM.toLowerCase()}.`)], forms: [VM, VM.toLowerCase()] },
  { id: "a08", tier: "CORE", what: "spaced out, one character at a time", steps: [tool(latch()), text(`Spelled out: ${spaced(VM, " ")}`)], forms: [VM, spaced(VM, " ")] },
  { id: "a09", tier: "CORE", what: "in groups of six with spaces", steps: [tool(latch()), text(`It is ${VM.slice(0, 6)} ${VM.slice(6, 12)} ${VM.slice(12)} in three groups.`)], forms: [VM] },
  { id: "a10", tier: "CORE", what: "in backticks", steps: [tool(latch()), text(`Use \`${VM}\` for the login.`)], forms: [VM] },
  { id: "a11", tier: "CORE", what: "in double quotes", steps: [tool(latch()), text(`The value is "${VM}".`)], forms: [VM] },
  { id: "a12", tier: "CORE", what: "in single and curly quotes", steps: [tool(latch()), text(`Either '${VM}' or \u201c${VM}\u201d works.`)], forms: [VM] },
  { id: "a13", tier: "CORE", what: "cut by a line break", steps: [tool(latch()), text(`It wraps over two lines:\n${VM.slice(0, 9)}\n${VM.slice(9)}`)], forms: [VM] },
  { id: "a14", tier: "CORE", what: "cut by bold, italic and strike marks", steps: [tool(latch()), text(`It is **${VM.slice(0, 6)}**_${VM.slice(6, 12)}_~~${VM.slice(12)}~~ in all.`)], forms: [VM] },
  { id: "a15", tier: "CORE", what: "alone inside a fenced code block", steps: [tool(latch()), text(`Paste this:\n\`\`\`\n${VM}\n\`\`\`\n`)], forms: [VM] },
  { id: "a16", tier: "CORE", what: "in a markdown table cell", steps: [tool(latch()), text(`| setting | value |\n|---|---|\n| database | ${VM} |\n`)], forms: [VM] },
  { id: "a17", tier: "CORE", what: "cut in two across table cells", steps: [tool(latch()), text(`| first | second |\n|---|---|\n| ${VM.slice(0, 9)} | ${VM.slice(9)} |\n`)], forms: [VM] },
  { id: "a18", tier: "CORE", what: "inside a JSON line under a harmless name", steps: [tool(latch()), text(`{"note": "${VM}", "ok": true}`)], forms: [VM] },
  { id: "a19", tier: "CORE", what: "inside a link path", steps: [tool(latch()), text(`Open https://example.invalid/reset/${VM}/done to finish.`)], forms: [VM] },
  { id: "a20", tier: "CORE", what: "glued inside a longer word", steps: [tool(latch()), text(`The folder is named backup${VM}old.`)], forms: [VM] },
  { id: "a21", tier: "CORE", what: "its last 8 characters only", steps: [tool(latch()), text(`It ends in ${VM.slice(-8)}.`)], forms: [VM] },
  { id: "a22", tier: "CORE", what: "its first 10 characters only", steps: [tool(latch()), text(`It starts with ${VM.slice(0, 10)} and then goes on.`)], forms: [VM] },
  { id: "a23", tier: "CORE", what: "its middle 10 characters only", steps: [tool(latch()), text(`The middle part is ${VM.slice(4, 14)}.`)], forms: [VM] },
  { id: "a24", tier: "CORE", what: "full-width letters (NFKC folds them)", steps: [tool(latch()), text(`Wide: ${fullwidth(VM)}`)], forms: [VM, fullwidth(VM)] },
  { id: "a25", tier: "CORE", what: "a zero-width space between every character", steps: [tool(latch()), text(`Here it is: ${spaced(VM, "\u200b")}`)], forms: [VM, spaced(VM, "\u200b")] },
  { id: "a26", tier: "CORE", what: "no-break spaces and soft hyphens between the characters", steps: [tool(latch()), text(`Here it is: ${[...VM].map((c, i) => c + (i % 2 ? "\u00a0" : "\u00ad")).join("")}`)], forms: [VM] },
  { id: "a27", tier: "CORE", what: "split over two replies, half in each", steps: [tool(latch()), text(`The first half is ${VM.slice(0, 9)}`), text(`${VM.slice(9)} is the second half.`)], forms: [VM] },
  { id: "a28", tier: "CORE", what: "split over three replies, six characters each and nothing else", steps: [tool(latch()), text(VM.slice(0, 6)), text(VM.slice(6, 12)), text(VM.slice(12))], forms: [VM], pieces: [VM.slice(0, 6), VM.slice(6, 12), VM.slice(12)], want: ["either", "held", "held"] },
  { id: "a29", tier: "CORE", what: "DESIGN W6: one reply ends on a label, the next is a value no tool printed", steps: [tool(latch()), text("Noted. The replica token:"), text(V2)], forms: [V2], want: ["either", "held"] },
  { id: "a30", tier: "CORE", what: "DESIGN W7: a second tool prints another value after the first one masked; the reply repeats the second", steps: [tool(latch()), tool(`REPLICA_PASSWORD=${V2}`), text(`The replica one is ${V2}.`)], forms: [VM, V2] },
  { id: "a31", tier: "CORE", what: "a label at the end of one tool result and its value at the start of the next; the reply repeats it", steps: [tool(latch()), tool("replica settings follow\nreplica_token:"), tool(`${V2}\nend of file`), text(`The replica token is ${V2}.`)], forms: [VM, V2] },
  { id: "a32", tier: "CORE", what: "three tool results, a value in each; the reply repeats all three", steps: [tool(latch()), tool(`REPLICA_PASSWORD=${V2}`), tool(`ADMIN_PASSWORD=${VW}`), text(`In order: ${VM}, ${V2}, ${VW}.`)], forms: [VM, V2, VW] },
  // one row per tool result of a32: the reply repeats ONLY that result's value, so each of the three results must have been recorded
  // on its own (a rule that knows the first value only shows a32b and a32c); the harmless reply after it must be shown
  { id: "a32a", tier: "CORE", what: "three tool results, a value in each; the reply repeats only the FIRST result's value, then a harmless reply", steps: [...THREE_RESULTS, text(`The main one is ${VM}.`), text(THREE_DONE)], forms: [VM, V2, VW], want: ["held", "shown"] },
  { id: "a32b", tier: "CORE", what: "three tool results, a value in each; the reply repeats only the SECOND result's value, then a harmless reply", steps: [...THREE_RESULTS, text(`The replica one is ${V2}.`), text(THREE_DONE)], forms: [VM, V2, VW], want: ["held", "shown"] },
  { id: "a32c", tier: "CORE", what: "three tool results, a value in each; the reply repeats only the THIRD result's value, then a harmless reply", steps: [...THREE_RESULTS, text(`The admin one is ${VW}.`), text(THREE_DONE)], forms: [VM, V2, VW], want: ["held", "shown"] },
  { id: "a33", tier: "CORE", what: "REVIEW H2: an indented config with two credentials; the reply repeats the second", steps: [tool(YAML), text(`The replica password is ${VW2}.`)], forms: [VW2] },
  { id: "a34", tier: "CORE", what: "REVIEW H2: the same config; the reply repeats the first, indented one", steps: [tool(YAML), text(`The main password is ${VW}.`)], forms: [VW] },
  { id: "a35", tier: "CORE", what: "DESIGN W5: a label streams, then the message completes as the bare value (resend, no reset)", steps: [tool(latch()), delta("api_key="), text(`${V2}\n`)], forms: [V2] },
  { id: "a36", tier: "CORE", what: "DESIGN W5: half a label streams, the message completes as the other half and the value", steps: [tool(latch()), delta("api_k"), text(`ey=${V2}`)], forms: [V2] },
  { id: "a37", tier: "CORE", what: "the value streams in prose, then the message completes as the value alone (resend, no reset)", steps: [tool(latch()), delta(`Working on it, the password ${VM} is`), text(VM)], forms: [VM] },
  { id: "a38", tier: "CORE", what: "repeated after a harmless reply in between", steps: [tool(latch()), text("Reading the file now."), text(`It says ${VM}.`)], forms: [VM], want: ["shown", "held"] },
  { id: "a39", tier: "CORE", what: "list bullets, half on each line", steps: [tool(latch()), text(`- ${VM.slice(0, 9)}\n- ${VM.slice(9)}`)], forms: [VM] },
  { id: "a40", tier: "EXT-M6", what: "percent-encoded", steps: [tool(latch(VP)), text(`In a link it becomes ${encodeURIComponent(VP)}.`)], forms: [VP, encodeURIComponent(VP)] },
  { id: "a41", tier: "EXT-M6", what: "a dash between every character", steps: [tool(latch()), text(`Dashed: ${spaced(VM, "-")}`)], forms: [VM, spaced(VM, "-")] },
  { id: "a42", tier: "EXT-M6", what: "a dot between every character", steps: [tool(latch()), text(`Dotted: ${spaced(VM, ".")}`)], forms: [VM, spaced(VM, ".")] },
  { id: "a43", tier: "EXT-PARKED", what: "base64 of the value", steps: [tool(latch()), text(`Encoded for you: ${b64(VM)}`)], forms: [VM, b64(VM)] },
  { id: "a44", tier: "EXT-PARKED", what: "hex of the value", steps: [tool(latch()), text(`As bytes: ${hex(VM)}`)], forms: [VM, hex(VM)] },
  { id: "a45", tier: "EXT-PARKED", what: "written backwards", steps: [tool(latch()), text(`Read it right to left: ${[...VM].reverse().join("")}`)], forms: [VM, [...VM].reverse().join("")] },
  { id: "a46", tier: "EXT-PARKED", what: "lookalike letters from another alphabet", steps: [tool(latch()), text(`It reads ${lookalike(VM)} on screen.`)], forms: [VM, lookalike(VM)] },
  { id: "a47", tier: "EXT-L3", what: "three replies, six characters of the value inside prose in each", steps: [tool(latch()), text(`First piece ${VM.slice(0, 6)}`), text(`then ${VM.slice(6, 12)}`), text(`and last ${VM.slice(12)}`)], forms: [VM], pieces: [VM.slice(0, 6), VM.slice(6, 12), VM.slice(12)], want: ["either", "either", "either"] },
];

const LONG = Array.from({ length: 24 }, (_v, i) => `Step ${i + 1} of the checklist is finished and its notes are filed under section ${i + 3}.`).join(" ");
const CLEAN: Clean[] = [
  { id: "c01", what: "DESIGN W1, the field bug: a plain sentence", steps: [tool(latch()), text("Done, the migration ran.")], shown: ["Done, the migration ran."] },
  { id: "c02", what: "DESIGN W3: prose that only names the secret", steps: [tool(latch()), text("I found the database password in the file and left it out of this reply.")], shown: ["I found the database password in the file and left it out of this reply."] },
  { id: "c03", what: "numbers and sizes", steps: [tool(latch()), text("The job took 42 seconds, wrote 1,204 rows and used 3.5 MB; port 5432 answered.")], shown: ["The job took 42 seconds, wrote 1,204 rows and used 3.5 MB; port 5432 answered."] },
  { id: "c04", what: "a word that shares only the value's first 4 characters", steps: [tool(latch()), text(`The ${VM.slice(0, 4)} adapter is installed.`)], shown: [`The ${VM.slice(0, 4)} adapter is installed.`] },
  { id: "c05", what: "a harmless fenced code block", steps: [tool(latch()), text("Here is the loop:\n```js\nfor (let i = 0; i < 3; i++) console.log(i);\n```")], shown: ["Here is the loop:\n```js\nfor (let i = 0; i < 3; i++) console.log(i);\n```"] },
  { id: "c06", what: "a harmless table", steps: [tool(latch()), text("| step | status |\n|---|---|\n| build | ok |\n| deploy | ok |")], shown: ["| step | status |\n|---|---|\n| build | ok |\n| deploy | ok |"] },
  { id: "c07", what: "accents, another script and an emoji", steps: [tool(latch()), text("Tout est pr\u00eat, le d\u00e9ploiement est termin\u00e9. \u5b8c\u4e86\u3057\u307e\u3057\u305f \u2705")], shown: ["Tout est pr\u00eat, le d\u00e9ploiement est termin\u00e9. \u5b8c\u4e86\u3057\u307e\u3057\u305f \u2705"] },
  { id: "c08", what: "a long reply (about 2,000 characters)", steps: [tool(latch()), text(LONG)], shown: [LONG] },
  { id: "c09", what: "two harmless replies in a row", steps: [tool(latch()), text("Step one is finished."), text("Step two is finished as well.")], shown: ["Step one is finished.", "Step two is finished as well."] },
  { id: "c10", what: "a one-class masked value; the reply uses its two halves as ordinary words", steps: [tool(latch(VW)), text("The harbour was quiet and the fog had lifted.")], shown: ["The harbour was quiet and the fog had lifted."], hidden: [VW] },
  { id: "c11", what: "a 10-digit masked value; the reply holds short runs of its digits", steps: [tool(latch(VD)), text(`Invoice ${VD.slice(0, 4)} has ${VD.slice(4, 7)} lines.`)], shown: [`Invoice ${VD.slice(0, 4)} has ${VD.slice(4, 7)} lines.`], hidden: [VD] },
  { id: "c12", what: "a ticket number and a date", steps: [tool(latch()), text("Ticket MUR-2291 was closed on 14 March.")], shown: ["Ticket MUR-2291 was closed on 14 March."] },
  { id: "c13", what: "DESIGN W7: a second value appears after the first was masked; the reply repeats neither", steps: [tool(latch()), tool(`REPLICA_PASSWORD=${V2}`), text("Both files are read; nothing else to do.")], shown: ["Both files are read; nothing else to do."], hidden: [VM, V2] },
  { id: "c14", what: "a question back to the owner", steps: [tool(latch()), text("Do you want me to restart the service now, or wait until tonight?")], shown: ["Do you want me to restart the service now, or wait until tonight?"] },
];
CLEAN.push({ id: "c16", what: "three tool results, a value in each; the reply repeats none of them", steps: [...THREE_RESULTS, text(THREE_DONE)], shown: [THREE_DONE], hidden: [VM, V2, VW] });
const AFTER_REPEAT: Clean = { id: "c15", what: "DESIGN W2: the reply after one that repeated the value", steps: [tool(latch()), text(`The database password is ${VM}.`), text("All set.")], shown: ["All set."] };

// Take-backs need an engine that voids its own text: the ACP driver (drivers/acp/core.ts onRetryState -> content.reset).
const TAKE_BACK_CLEAN = "All four steps ran; nothing else to report.";
function acpTurn(parts: Array<string | null>): unknown[] {
  const steps: unknown[] = [];
  let at = 600;
  for (const part of parts) {
    steps.push(part === null
      ? { at, update: { sessionUpdate: "retry_state", type: "retrying", attempt: 1, reason: "context compacted" } }
      : { at, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: part } } });
    at += 80;
  }
  steps.push({ at: at + 100, result: { stopReason: "end_turn" } });
  return steps;
}
const TAKE_BACKS: Array<{ id: string; what: string; parts: Array<string | null>; forms: string[] }> = [
  { id: "k1", what: "REVIEW H3: two take-backs, the label in the second, then the bare value", parts: ["Checking config", null, "api_key=", null, V2], forms: [V2] },
  { id: "k2", what: "DESIGN W4: a label taken back, then the value sent alone", parts: ["Next step: export api_key=", null, `${V2}\n`], forms: [V2] },
  { id: "k3", what: "a credential line taken back, then sent again as the bare value in prose", parts: [`Next step: export api_key=${V2}`, null, `The key is ${V2}.`], forms: [V2] },
  { id: "k4", what: "DESIGN W4: a credential cut in two by the take-back", parts: [`Next step: export api_key=${V2.slice(0, 9)}`, null, `${V2.slice(9)} and that is all of it.`], forms: [V2] },
];
const TAKE_BACK_CLEAN_PARTS = [`Next step: export api_key=${V2}`, null, TAKE_BACK_CLEAN];

// The fixture engine: testing/fake-claude-cli.ts as it is at this sha, with one block added to a temp copy: a turn whose prompt
// names `attack-case=<id>` plays that case's steps as the real CLI's frames (the shapes drivers/claude.ts reads).
const ENGINE_ANCHOR = `  if (mode === "stream") {`;
const ENGINE_BLOCK = `  if (process.env.FAKE_CLAUDE_ATTACK_SCRIPTS) {
    const attackScripts = JSON.parse(readFileSync(process.env.FAKE_CLAUDE_ATTACK_SCRIPTS, "utf8")) as Record<string, Array<[string, string]>>;
    const attackId = [...promptText(prompt).matchAll(/attack-case=([a-z0-9]+)/g)].at(-1)?.[1] ?? "";
    let attackTools = 0;
    for (const [kind, value] of attackScripts[attackId] ?? [["text", "attack fixture: no script for this prompt"]]) {
      if (kind === "text") out({ type: "assistant", message: { content: [{ type: "text", text: value }], usage: { input_tokens: 10, cache_read_input_tokens: 2, output_tokens: 5 } } });
      else if (kind === "delta") out({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: value } } });
      else if (kind === "tool") {
        const toolUseId = "tu-attack-" + attackId + "-" + String(attackTools++);
        out({ type: "assistant", message: { content: [{ type: "tool_use", id: toolUseId, name: "Bash", input: { command: "cat fixture-step-" + String(attackTools) } }] } });
        out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: toolUseId, is_error: false, content: value }] } });
      }
    }
    out({ type: "result", is_error: false, stop_reason: "end_turn", total_cost_usd: 0.01, usage: { input_tokens: 10, cache_read_input_tokens: 2, output_tokens: 5 } });
    turnRunning = false; finishIfDone(); return;
  }

`;

let fixture: VerificationServer, headers: Record<string, string> = {}, scratch = "";
const api = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(`${fixture.info.url}${path}`, { method, headers: { ...headers, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) as any };
};
const transcript = async (threadId: string): Promise<any[]> => ((await api("GET", `/api/threads/${threadId}/messages?limit=200`)).body?.messages ?? []) as any[];
function storedRows(threadId: string): any[] {
  const db = new DatabaseSync(join(fixture.info.dataDir, "messages.db"), { readOnly: true });
  try { return (db.prepare("SELECT json FROM messages WHERE thread_id=?").all(threadId) as { json: string }[]).map(row => JSON.parse(String(row.json))); }
  finally { db.close(); }
}
const serverLog = () => readFileSync(fixture.info.logPath, "utf8");
async function poll<T>(read: () => Promise<T | null>, ms: number): Promise<T | null> {
  const deadline = Date.now() + ms;
  for (;;) { const value = await read(); if (value) return value; if (Date.now() > deadline) return null; await new Promise(r => setTimeout(r, 250)); }
}
const engineReplies = (rows: any[]) => rows.filter(m => m.role === "bot" && m.kind === "text" && m.actorKind !== "murage");
const replyTexts = (rows: any[]) => engineReplies(rows).map(m => String(m.text ?? ""));
/** Every string anywhere in a row (text, tool input and output, cards, notes): what a reader of that row could be shown. */
function strings(value: unknown, into: string[] = []): string[] {
  if (typeof value === "string") into.push(value);
  else if (Array.isArray(value)) for (const item of value) strings(item, into);
  else if (value && typeof value === "object") for (const item of Object.values(value)) strings(item, into);
  return into;
}
const diag = (read: any[]) => `rows ${JSON.stringify(read.map(m => [m.role, m.kind, String(m.text ?? "").length, String(m.text ?? "") === REPLY_WITHHELD ? "HELD" : String(m.text ?? "").includes("\u00abredacted") ? "REDACTED" : "text"]))}`;

/** One owner line in a new chat of that engine instance; waits for `replies` engine replies and for the rows to stop changing. */
async function ownerTurn(name: string, modelSelection: { instanceId: string; model: string }, line: string, replies: number) {
  const created = await api("POST", "/api/bots", { name, modelSelection });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const bot = created.body.bot as { id: string; threadId: string };
  expect((await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false })).status).toBe(200);
  const seeded = new Set((await transcript(bot.threadId)).map(m => m.id));
  const logFrom = serverLog().length;
  expect((await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: line })).status).toBe(202);
  let last = -1, still = 0;
  const ended = await poll(async () => {
    const rows = (await transcript(bot.threadId)).filter(m => !seeded.has(m.id));
    still = rows.length === last ? still + 1 : 0; last = rows.length;
    return engineReplies(rows).length >= replies && still >= 4 ? rows : null;
  }, 60_000);
  const read = ended ?? (await transcript(bot.threadId)).filter(m => !seeded.has(m.id));
  const stored = storedRows(bot.threadId).filter(m => !seeded.has(m.id));
  if (process.env.HELD_BACK_ATTACK_DEBUG) console.log("DEBUG-ROWS", name, JSON.stringify({ read, stored }));
  return { read, stored, ended: ended !== null, log: serverLog().slice(logFrom) };
}
const claudeTurn = (id: string, steps: Step[]) => ownerTurn(`Attack ${id}`, { instanceId: "attack", model: "claude-sonnet-5" }, `Fixture owner line: read the settings file and tell me what you found. attack-case=${id}`, steps.filter(step => step[0] === "text").length);
const acpOwnerTurn = (id: string) => ownerTurn(`Attack ${id}`, { instanceId: `attack${id}`, model: "fake-model" }, "Fixture owner line: read the settings file and tell me what you found.", 1);

// The reader's side of the check, written here and not imported from the product: lower case, NFKC, and every space, invisible
// character and quoting or markdown mark removed. A value is LEAKED when, in what the owner can read, the store holds or the log
// prints: its exact form appears; or its normalised form appears; or (a value of mixed letters, digits or marks) any 8 characters
// in a row of it appear; or every one of the case's `pieces` appears.
const norm = (value: string) => value.normalize("NFKC").toLowerCase().replace(/[\s\p{Cf}`'"*_~|>\\]/gu, "");
const mixed = (value: string) => [/\p{L}/u, /\p{N}/u, /[^\p{L}\p{N}]/u].filter(kind => kind.test(value)).length >= 2;
function leaks(haystack: string, forms: string[], pieces?: string[]): string[] {
  const found: string[] = [], hay = norm(haystack);
  forms.forEach((form, index) => {
    const target = norm(form);
    if (haystack.includes(form)) found.push(`form ${index}: exact`);
    else if (target && hay.includes(target)) found.push(`form ${index}: whole, re-spaced or re-cased`);
    else if (mixed(target)) for (let at = 0; at + 8 <= target.length; at++) if (hay.includes(target.slice(at, at + 8))) { found.push(`form ${index}: 8 characters in a row, from ${at}`); break; }
  });
  if (pieces && pieces.every(piece => hay.includes(norm(piece)))) found.push("every piece");
  return found;
}
type Turn = Awaited<ReturnType<typeof ownerTurn>>;

// The outcome of one reply row, judged against the text the fixture engine sent for that reply (`sources`: the message as it
// completed, and the same message with what streamed before it; for a take-back, every tail of the parts the engine sent) and
// against the row's masked `forms`. "shown": the row is the reply word for word. "held": the row is the held-back line, or a
// PROJECTION of one source: the row with each redaction mark put back to the text it covers rebuilds that source exactly, character
// for character (spaces included: the text around a mark is never trimmed or normalised before the rebuild), at least one piece of
// the reply's own text is kept, and every span a mark covers is value material: under the
// reader's normalisation (norm, below) and with at most one leading label (`DB_PASSWORD=`, `api_key=`, `replica_token:`) taken off,
// it is a non-empty piece of one of the row's masked forms. So a row of marks only (MAIN-RULING 2026-11-23T00:58:16Z redact-marker:
// that row is the held-back line), a mark over harmless words, an unrelated replacement, an empty row or another step's text never
// passes as held (ASTRA n4:6198). Fail closed: a product projection this judge cannot rebuild (one mark over two values and the
// words between them) reads as "other" and MAIN rules on it; it never passes silently.
// A mark is read EXACTLY, body and all (ASTRA n4:6266): `\u00abredacted\u00bb` (owner-display.ts / redact-turn.ts MARKER) or
// `\u00abredacted N chars\u00bb` (redact.ts mask / textMarker), N a count with no leading zero. Nothing is discarded between `redacted` and
// the closing guillemet: any other body (reply text or a piece of the value smuggled inside, harmless words, a re-cased or re-spaced
// marker, a lookalike) is not a mark, so it stays in the row as text and the row cannot rebuild the source. A counted mark must count
// exactly the source text it covers, so its digits carry nothing else; spaces next to a mark must be the source's own (no padding).
const MARK = /\u00abredacted(?: ([1-9][0-9]{0,8}) chars)?\u00bb/gu;
/** The row cut at its marks: the text kept between them, untouched, and each mark's count (null for the bare mark). */
function cutAtMarks(row: string): { kept: string[]; counts: Array<number | null> } {
  const kept: string[] = [], counts: Array<number | null> = [];
  let from = 0;
  for (const mark of row.matchAll(MARK)) { kept.push(row.slice(from, mark.index)); counts.push(mark[1] ? Number(mark[1]) : null); from = mark.index + mark[0].length; }
  kept.push(row.slice(from));
  return { kept, counts };
}
const LABEL_PREFIX = /^[\p{L}_][\p{L}\p{N}_.-]*[:=]/u;
const escapeRe = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// a span is value material when, after at most one label taken off its raw text (one word, no space before the `:` or `=`, starting
// at a word start of the reply), its normalised rest is a piece of one masked form at least 6 characters long (or the whole form)
function valueMaterial(span: string, forms: string[], wordStart: boolean): boolean {
  const raw = span.trim(), label = wordStart ? LABEL_PREFIX.exec(raw)?.[0] ?? "" : "";
  const piece = norm(raw.slice(label.length));
  return forms.some(form => { const whole = norm(form); return piece.length >= Math.min(6, whole.length) && whole.includes(piece); });
}
function projectionOf(row: string, source: string, forms: string[]): boolean {
  const { kept, counts } = cutAtMarks(row);
  if (kept.length < 2 || kept.every(piece => !piece.trim())) return false;
  const rebuilt = new RegExp(`^${kept.map(escapeRe).join("([\\s\\S]+?)")}$`, "du").exec(source);
  return rebuilt !== null && counts.every((count, index) => {
    const span = rebuilt[index + 1]!, at = rebuilt.indices![index + 1]![0];
    return (count === null || count === span.length) && valueMaterial(span, forms, at === 0 || !/[\p{L}\p{N}]/u.test(source[at - 1]!));
  });
}
function outcome(row: string, sent: string, sources: string[], forms: string[]): string {
  if (row === REPLY_WITHHELD) return "held";
  if (row === sent) return "shown";
  if (sources.some(source => projectionOf(row, source, forms))) return "held";
  const kept = cutAtMarks(row).kept.map(piece => piece.trim());
  return `other: ${row.length} characters, ${row === "" ? "empty" : kept.some(piece => piece.includes("\u00abredacted")) ? "a redaction mark whose body is not \u00abredacted\u00bb or \u00abredacted N chars\u00bb (ASTRA n4:6266)" : kept.length < 2 ? "not this reply and not the held-back line" : kept.every(piece => !piece) ? "redaction marks only (redact-marker: that row is the held-back line)" : "redaction marks that do not rebuild this reply over value material only"}`;
}
/** [sent, streamed-before] of each reply of a script, in order. */
function sentReplies(steps: Step[]): Array<[string, string]> {
  const replies: Array<[string, string]> = [];
  let streamed = "";
  for (const [kind, value] of steps) { if (kind === "delta") streamed += value; else if (kind === "text") { replies.push([value, streamed]); streamed = ""; } else streamed = ""; }
  return replies;
}
/** Every reply row, in the read and in the store, has exactly its required outcome: one row per reply, in order, none missing, none extra. */
function expectOutcomes(turn: Turn, steps: Step[], want: Want[], forms: string[]) {
  const sent = sentReplies(steps);
  expect(want.length, "the row's `want` names one outcome per reply of its script").toBe(sent.length);
  for (const [place, rows] of [["the owner's read", replyTexts(turn.read)], ["the store", replyTexts(turn.stored)]] as const) {
    const got = rows.map((row, index) => { const result = index < sent.length ? outcome(row, sent[index]![0], [sent[index]![0], sent[index]![1] + sent[index]![0]], forms) : "other: a row no reply of the script accounts for"; return want[index] === "either" && (result === "held" || result === "shown") ? "either" : result; });
    expect({ place, outcomes: got }, diag(turn.read)).toEqual({ place, outcomes: want });
  }
}
/** The server's own readiness rows (not the engine's): every "Loading ..." chip title over Murage's required tools, in any order, and
 * the held-recall line (index.ts heldRecallLine), each as a finished row. */
const READINESS_ROWS: ReadonlySet<string> = (() => {
  const labels = [...new Set(Object.values(REQUIRED_MCP_SERVERS))];
  const orders = (left: string[]): string[][] => left.flatMap((label, at) => [[label], ...orders(left.filter((_, other) => other !== at)).map(rest => [label, ...rest])]);
  const names = [...orders(labels).map(mcpWaitChipTitle), "Memory wasn't ready, so this reply didn't use what I remember.", "Memory wasn't ready, so this reply didn't use what I remember or my pinned rules."];
  return new Set(names.map(name => `${name}, result received`));
})();
/** Every tool result of the script reached the transcript and the store as its own finished tool row, in order: one `Bash` row per
 * tool step, each closed by its result (`ok: true` is set from the result frame). A latched turn's tool row shows no command or
 * output (it reads as opaque), so the rows are counted and checked for their result, not told apart by text. */
function expectToolRows(turn: Turn, steps: Step[]) {
  const wanted = steps.filter(step => step[0] === "tool").map(() => "Bash, result received");
  for (const [place, rows] of [["the owner's read", turn.read], ["the store", turn.stored]] as const) {
    const all = rows.filter(m => m.tool).map(m => `${String(m.tool.action?.name ?? m.tool.name)}, ${m.tool.ok === true ? "result received" : "no result"}`);
    // WAVE-Q1c n4:6414: on a loaded box the server's own readiness rows open the turn before the engine's first tool row: the
    // "Loading <its tools>" chip (MCP_WAIT_CHIP_AFTER_MS) and the memory-not-ready line (RECALL_WAIT_MS). They are not script
    // rows; only those exact product rows, finished, and only before the first script row, are set aside. Any other row still fails.
    let lead = 0;
    while (lead < all.length && READINESS_ROWS.has(all[lead]!)) lead++;
    const seen = all.slice(lead);
    expect({ place, tools: seen }, diag(turn.read)).toEqual({ place, tools: wanted });
  }
}

const places = (turn: Turn): Array<[string, string]> => [["the owner's read", strings(turn.read).join("\n")], ["the store", strings(turn.stored).join("\n")], ["the server log", turn.log]];
function expectNoLeak(turn: Turn, forms: string[], pieces?: string[]) {
  expect(turn.log.length, "the server log of this turn is empty, so the log check would read nothing").toBeGreaterThan(0);
  for (const [place, haystack] of places(turn)) expect({ place, leaked: leaks(haystack, forms, pieces) }, diag(turn.read)).toEqual({ place, leaked: [] });
}

// The judge itself, on the rows a product could write (no server): what passes as held, shown or neither. ASTRA n4:6198: a row of
// marks only, or marks around text that is not this reply's value, was accepted as held for any reply.
const A01 = `The database password is ${VM}.`;
const JUDGE: Array<[string, string, string, string[], string]> = [
  ["the held-back line", REPLY_WITHHELD, A01, [VM], "held"],
  ["word for word", A01, A01, [VM], "shown"],
  ["the value under a mark", "The database password is \u00abredacted\u00bb.", A01, [VM], "held"],
  ["the label and the value under one mark", "I read \u00abredacted\u00bb from the file.", `I read ${latch()} from the file.`, [VM], "held"],
  ["two halves, each under its own mark", "It wraps: \u00abredacted\u00bb and \u00abredacted\u00bb.", `It wraps: ${VM.slice(0, 9)} and ${VM.slice(9)}.`, [VM], "held"],
  ["the value under a counted mark (redact.ts form), counting the value", `The database password is «redacted ${VM.length} chars».`, A01, [VM], "held"],
  ["two halves under counted marks, each counting its half", "It wraps: «redacted 9 chars» and «redacted 9 chars».", `It wraps: ${VM.slice(0, 9)} and ${VM.slice(9)}.`, [VM], "held"],
  ["ASTRA n4:6266: a piece of the value smuggled inside the mark", `The database password is «redacted ${VM.slice(0, 5)}».`, A01, [VM], "other"],
  ["ASTRA n4:6266: reply words smuggled inside the mark", "The database password is «redacted see the note on the desk».", A01, [VM], "other"],
  ["ASTRA n4:6266: the whole reply inside a mark after its first word", `The «redacted database password is ${VM.slice(0, 5)}».`, A01, [VM], "other"],
  ["ASTRA n4:6266: a count one over the span, the space before the mark still shown (precheck :307)", `The database password is «redacted ${VM.length + 1} chars».`, A01, [VM], "other"],
  ["ASTRA n4:6266: a counted mark whose count carries digits", "The database password is «redacted 4711 chars».", A01, [VM], "other"],
  ["ASTRA n4:6266: a count with a leading zero", `The database password is «redacted 0${VM.length} chars».`, A01, [VM], "other"],
  ["ASTRA n4:6266: a re-spaced counted mark", `The database password is «redacted  ${VM.length} chars».`, A01, [VM], "other"],
  ["ASTRA n4:6266: a re-cased mark", "The database password is «Redacted».", A01, [VM], "other"],
  ["self-review M-a: wide spaces padded next to a mark (a channel the source does not hold)", "The database password is\u2003\u2002\u2009 \u00abredacted\u00bb.", A01, [VM], "other"],
  ["self-review M-a: a space dropped next to a mark (the mark covers it, so its count must too)", `The database password is\u00abredacted ${VM.length + 1} chars\u00bb.`, A01, [VM], "held"],
  ["ASTRA n4:6266: a space before the closing guillemet", "The database password is «redacted ».", A01, [VM], "other"],
  ["ASTRA n4:6198: one bare mark for a prose reply", "\u00abredacted\u00bb", A01, [VM], "other"],
  ["a bare mark for a reply that is only the value (redact-marker: the held-back line, never a bare mark)", "\u00abredacted\u00bb", VM, [VM], "other"],
  ["two bare marks", "\u00abredacted\u00bb \u00abredacted\u00bb", A01, [VM], "other"],
  ["a mark over the harmless words, the full stop kept", "\u00abredacted\u00bb.", A01, [VM], "other"],
  ["a mark over harmless words, the value's place kept as text", "\u00abredacted\u00bb password is \u00abredacted\u00bb.", A01, [VM], "other"],
  ["a mark over a harmless reply", "\u00abredacted\u00bb set.", "All set.", [VM], "other"],
  ["an unrelated replacement with a mark", "Nothing to report \u00abredacted\u00bb.", A01, [VM], "other"],
  ["another step's text around a mark", "Reading the file \u00abredacted\u00bb.", A01, [VM], "other"],
  ["an empty row", "", A01, [VM], "other"],
  ["self-review M1: a mark over a phrase that ends in a colon, and the value", "It \u00abredacted\u00bb", `It wraps over two lines:\n${VM}`, [VM], "other"],
  ["self-review M1: a mark from inside a word, over a label and the value", "D\u00abredacted\u00bb", `Dashed: ${spaced(VM, "-")}`, [VM, spaced(VM, "-")], "other"],
  ["self-review M1: a mark over a word, a colon and the value", "Here \u00abredacted\u00bb", `Here it is: ${VM}`, [VM], "other"],
  ["self-review M2: a one-letter mark over a harmless word's first letter", "\u00abredacted\u00bbhe database password is \u00abredacted\u00bb.", A01, [VM], "other"],
  ["self-review M2: a mark over three characters the value shares", `The ${VM.slice(0, 4)} adapter \u00abredacted\u00bb.`, `The ${VM.slice(0, 4)} adapter ${VM.slice(4, 7)}.`, [VM], "other"],
  ["an unrelated replacement without a mark", "All set.", A01, [VM], "other"],
];
describe("JUDGE (no server): a held row is the held-back line or a projection that rebuilds this reply over value material only", () => {
  it.each(JUDGE)("%s", (_what, row, sent, forms, want) => {
    expect(outcome(row, sent, [sent], forms).split(":")[0]).toBe(want);
  });
});

describe("1.0.22 cause B attack set, real reply route: a reply that repeats what the turn masked is never read or stored, and a reply that repeats nothing is read word for word", () => {
  beforeAll(async () => {
    chmodSync(FAKE_CLAUDE, 0o755); chmodSync(FAKE_ACP, 0o755);
    scratch = mkdtempSync(join(tmpdir(), "held-back-attack-"));
    const source = readFileSync(FAKE_CLAUDE, "utf8");
    expect(source.split(ENGINE_ANCHOR).length, "the fake Claude CLI no longer has the one place the attack script is added at").toBe(2);
    // the copy lives outside the tree, so its relative imports are pointed back at the tree
    const engine = join(scratch, "attack-claude-cli.ts");
    writeFileSync(engine, source.replace(ENGINE_ANCHOR, ENGINE_BLOCK + ENGINE_ANCHOR).replace(/from "(\.{1,2}\/[^"]+)"/g, (_match, path: string) => `from ${JSON.stringify(resolve(TESTING_DIR, path))}`));
    chmodSync(engine, 0o755);
    const scripts = join(scratch, "scripts.json");
    const controls = CLEAN.map(row => [`n${row.id.slice(1)}`, row.steps.filter(step => step[0] === "text")] as const);
    writeFileSync(scripts, JSON.stringify(Object.fromEntries([...ATTACKS, ...CLEAN, AFTER_REPEAT].map(row => [row.id, row.steps] as const).concat(controls))));
    const acp = (script: unknown[]) => ({ driver: "grokAgent", displayName: "ACP fixture", config: { cli: FAKE_ACP, fullAuto: true },
      environment: { FAKE_ACP_MCP_READY: "1", FAKE_ACP_MCP_READY_METHOD: "_x.ai/mcp_initialized", FAKE_ACP_MODE: "fuigo-script", FAKE_ACP_SCRIPT: JSON.stringify(script) } });
    const instances: Record<string, unknown> = {
      attack: { driver: "claudeAgent", displayName: "Claude fixture", config: { cli: engine }, environment: { FAKE_CLAUDE_TEXT_ONLY: "1", FAKE_CLAUDE_ATTACK_SCRIPTS: scripts } },
      attackkc: acp(acpTurn(TAKE_BACK_CLEAN_PARTS)),
      attackkn: acp(acpTurn(["Checking the steps", null, TAKE_BACK_CLEAN])),
    };
    for (const row of TAKE_BACKS) instances[`attack${row.id}`] = acp(acpTurn(row.parts));
    fixture = await launchVerificationServer(process.env, undefined, { readyTimeoutMs: 60_000, instrumentationSource: `${POWER_BLOCK_UNWRAP_SOURCE}
      const fs=await import('node:fs'); const path=await import('node:path');
      const file=path.join(process.env.MURAGE_DATA_DIR,'config.json');const cfg=JSON.parse(fs.readFileSync(file,'utf8'));
      Object.assign(cfg.instances, ${JSON.stringify(instances)});
      fs.writeFileSync(file,JSON.stringify(cfg));
    ` });
    const proof = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string };
    headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
  }, 90_000);
  afterAll(async () => { await fixture?.close(); if (scratch) rmSync(scratch, { recursive: true, force: true }); });

  describe("CONTROL (GREEN on base and fix): the same clean replies, in a turn that masked nothing, are read and stored word for word", () => {
    it.each(CLEAN)("N$id $what", async ({ id, shown }) => {
      const turn = await claudeTurn(`n${id.slice(1)}`, shown.map(text));
      expect(turn.ended, diag(turn.read)).toBe(true);
      expect(replyTexts(turn.read), diag(turn.read)).toEqual(shown);
      expect(replyTexts(turn.stored), diag(turn.read)).toEqual(shown);
    }, 120_000);

    it("Nkn ACP: a harmless line taken back, then the answer: the answer is read and stored", async () => {
      const turn = await acpOwnerTurn("kn");
      expect(turn.ended, diag(turn.read)).toBe(true);
      // exactly one reply row, the answer word for word: no other row (a held, empty or replaced one) before or after it
      expect(replyTexts(turn.read), diag(turn.read)).toEqual([TAKE_BACK_CLEAN]);
      expect(replyTexts(turn.stored), diag(turn.read)).toEqual([TAKE_BACK_CLEAN]);
    }, 120_000);
  });

  describe("ATTACK (GREEN on base, must stay GREEN on the fix): a tool result is masked, then the reply repeats the value", () => {
    it.each(ATTACKS)("$id [$tier] $what", async ({ id, steps, forms, pieces, want }) => {
      const turn = await claudeTurn(id, steps);
      // every reply of the script has its row (shown, redacted or held back): the turn ran to its end and nothing was dropped unseen
      expect(turn.ended, diag(turn.read)).toBe(true);
      // every tool result of the script reached the server as its own row (a32, a32a-c: each of the three results)
      expectToolRows(turn, steps);
      expectNoLeak(turn, forms, pieces);
      // each reply has exactly its required outcome, in the read and in the store: a reply that repeats the value is held (the
      // held-back line or its own redacted projection), a harmless reply of the same turn is shown word for word. Base: a harmless
      // reply reads REPLY_WITHHELD, so the rows that carry one (a38, a32a, a32b, a32c) are RED here.
      expectOutcomes(turn, steps, want ?? steps.filter(step => step[0] === "text").map(() => "held" as const), [...forms, ...(pieces ?? [])]);
    }, 120_000);
  });

  describe("ATTACK, take-backs through the ACP driver (GREEN on base, must stay GREEN on the fix)", () => {
    it.each(TAKE_BACKS)("$id [CORE] $what", async ({ id, forms, parts }) => {
      const turn = await acpOwnerTurn(id);
      expect(turn.ended, diag(turn.read)).toBe(true);
      // the scripted message arrived and was judged: its row is the held-back line or a redacted projection, in the read and in the
      // store (a script that did not play, or an engine default reply, would read as ordinary text)
      expectNoLeak(turn, forms);
      // exactly one reply row, and it is held: the held-back line, or a projection of what the engine sent (a tail of its parts,
      // taken-back parts included)
      const sentParts = parts.filter((part): part is string => part !== null);
      const tails = sentParts.map((_part, from) => sentParts.slice(from).join(""));
      for (const [place, rows] of [["the owner's read", replyTexts(turn.read)], ["the store", replyTexts(turn.stored)]] as const)
        expect({ place, outcomes: rows.map(row => outcome(row, sentParts.at(-1)!, tails, forms)) }, diag(turn.read)).toEqual({ place, outcomes: ["held"] });
    }, 120_000);
  });

  describe("CLEAN (RED on base d91ec92098, GREEN on the fix): a tool result is masked, then a reply that repeats nothing is read and stored word for word", () => {
    it.each(CLEAN)("$id $what", async ({ id, steps, shown, hidden }) => {
      const turn = await claudeTurn(id, steps);
      expect(turn.ended, diag(turn.read)).toBe(true);
      expectToolRows(turn, steps);
      expectNoLeak(turn, hidden ?? [VM]);
      // base: each of these reads REPLY_WITHHELD, because the turn's latch held every later reply
      expect(replyTexts(turn.read), diag(turn.read)).toEqual(shown);
      expect(replyTexts(turn.stored), diag(turn.read)).toEqual(shown);
    }, 120_000);

    it("c15 DESIGN W2: the reply after one that repeated the value is read and stored; the repeat itself is not", async () => {
      const turn = await claudeTurn(AFTER_REPEAT.id, AFTER_REPEAT.steps);
      expect(turn.ended, diag(turn.read)).toBe(true);
      expectNoLeak(turn, [VM]);
      expectToolRows(turn, AFTER_REPEAT.steps);
      // base: the second reply reads REPLY_WITHHELD too
      expectOutcomes(turn, AFTER_REPEAT.steps, ["held", "shown"], [VM]);
    }, 120_000);

    it("ckc ACP (the base R3 control of withheld-retract-api-1022): a credential line taken back, then a harmless answer: the answer is read and stored, the value is in no row", async () => {
      const turn = await acpOwnerTurn("kc");
      expect(turn.ended, diag(turn.read)).toBe(true);
      expectNoLeak(turn, [V2]);
      // exactly one reply row, the answer word for word: no other row (a held, empty or replaced one) before or after it
      expect(replyTexts(turn.read), diag(turn.read)).toEqual([TAKE_BACK_CLEAN]);
      expect(replyTexts(turn.stored), diag(turn.read)).toEqual([TAKE_BACK_CLEAN]);
    }, 120_000);
  });
});
