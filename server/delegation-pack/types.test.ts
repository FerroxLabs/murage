// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { join } from "node:path";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { SERVER_DIR, diagnosticsFor, virtualProgram } from "../testing/virtual-program.ts";

const FILE = join(SERVER_DIR, "delegation-pack", "__contract_probe.ts");
const PRELUDE = `
import type { PackAuthority, PackBinding, DelegationPack, DelegationPackRow, DelegationPackTurnOptions } from "./types.ts";
import type { DenyReason, LineageVerdict } from "../memory/lineage-types.ts";
declare const authority: PackAuthority;
declare const binding: PackBinding;
declare const pack: DelegationPack;
declare const row: DelegationPackRow;
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
export {};
`;
const diagnose = (source: string) => diagnosticsFor(virtualProgram({ [FILE]: PRELUDE + source }), FILE);

// Each rejected program changes one constraint of its accepted control.
const pairs: Array<[string, string, string]> = [
  ["T-CONTRACT-PAGE: older-context page binding is absent or true",
    `const page: PackBinding = { ...binding, page: true };`,
    `const page: PackBinding = { ...binding, page: false };`],
  ["T-CONTRACT-DENY: pack-ineligible is a withheld reason; mutant omits the reason",
    `const verdict: LineageVerdict = { state: "withheld", reason: "pack-ineligible" };`,
    `const verdict: LineageVerdict = { state: "checking", reason: "pack-ineligible" };`],
  ["T-CONTRACT-DENY-EXHAUSTIVE: all reasons are handled; mutant omits the pack case",
    `function check(reason: DenyReason): void { switch (reason) {
      case "own-flag": case "tombstone": case "thread-deny": case "deny-line": case "deny-range":
      case "watermark": case "footprint": case "deny-session": case "session-forgotten": case "deny-memory":
      case "scope-deny": case "murage-anchor": case "door-epoch": case "pack-ineligible": return;
      default: { const exhaustive: never = reason; }
    } }`,
    `function check(reason: DenyReason): void { switch (reason) {
      case "own-flag": case "tombstone": case "thread-deny": case "deny-line": case "deny-range":
      case "watermark": case "footprint": case "deny-session": case "session-forgotten": case "deny-memory":
      case "scope-deny": case "murage-anchor": case "door-epoch": return;
      default: { const exhaustive: never = reason; }
    } }`],
  ["T-CONTRACT-AUTHORITY: server authority is nominal; mutant accepts request-shaped IDs",
    `const proof: PackAuthority = authority;`,
    `const proof: PackAuthority = { fromBotId: "sable", fromThreadId: "source", generation: "generation", inputMessageId: "input" };`],
  ["T-CONTRACT-AUTHORITY-FROZEN: source identity is readonly; mutant allows reassignment",
    `const source: string = authority.fromThreadId;`,
    `authority.fromThreadId = "other";`],
  ["T-CONTRACT-BINDING: first dispatch and replay have explicit anchors; mutant makes anchor optional",
    `const first: PackBinding = { packId: "p", destinationThreadId: "d", generation: "g", sourceThreadId: "s", sourceLeafId: null, refs: [{ id: "m", mrow: 1 }], anchor: null, driverKind: "codex" };
     const replay: PackBinding = { ...first, anchor: { messageId: "delegated", mrow: 2 } };`,
    `const first: PackBinding = { packId: "p", destinationThreadId: "d", generation: "g", sourceThreadId: "s", sourceLeafId: null, refs: [{ id: "m", mrow: 1 }], driverKind: "codex" };`],
  ["T-CONTRACT-BINDING-REFS: retained refs are readonly; mutant allows adding refs",
    `const refs: readonly { readonly id: string; readonly mrow: number }[] = binding.refs;`,
    `binding.refs.push({ id: "unlent", mrow: 9 });`],
  ["T-CONTRACT-BINDING-ROW: retained row identity is readonly; mutant allows changing mrow",
    `const mrow: number = binding.refs[0].mrow;`,
    `binding.refs[0].mrow = 9;`],
  ["T-CONTRACT-BINDING-ANCHOR: replay identity is readonly; mutant allows changing anchor",
    `if (binding.anchor) { const id: string = binding.anchor.messageId; }`,
    `if (binding.anchor) binding.anchor.messageId = "other";`],
  ["T-CONTRACT-ROW: enqueue permits an unresolved destination; mutant requires a destination",
    `const destination: Pick<DelegationPack, "destination_thread_id"> = { destination_thread_id: null };`,
    `const destination: Pick<DelegationPack, "destination_thread_id"> = {};`],
  ["T-CONTRACT-ROW-IDS: decoded refs contain IDs only; mutant allows copied rows",
    `const refs: DelegationPack["refs"] = ["message"];`,
    `const refs: DelegationPack["refs"] = [{ id: "message", text: "source words" }];`],
  ["T-CONTRACT-ROW-PREPARED: prepared replaces released; mutant retains the old column",
    `const ids: readonly string[] = pack.prepared;`,
    `const ids: readonly string[] = pack.released;`],
  ["T-CONTRACT-ROW-STORAGE: stored sets are JSON text; mutant conflates stored and decoded rows",
    `const json: string = row.refs; const prepared: string = row.prepared;`,
    `const json: readonly string[] = row.refs; const prepared: string = row.prepared;`],
  ["T-CONTRACT-SUPPRESSION: suppression is absent or true; mutant widens to boolean",
    `const fresh: DelegationPackTurnOptions = {}; const rebuild: DelegationPackTurnOptions = { packSuppressed: true };
     type Exact = Assert<Equal<DelegationPackTurnOptions["packSuppressed"], true | undefined>>;`,
    `const rebuild: DelegationPackTurnOptions = { packSuppressed: false };`],
];

describe("L5b-0 contracts", () => {
  it("T-CONTRACT-START-TURN-SUPPRESSION: startTurn accepts only absent or true; mutant omits or widens the field", () => {
    const source = ts.createSourceFile("index.ts", readFileSync(join(SERVER_DIR, "index.ts"), "utf8"), ts.ScriptTarget.Latest, true);
    // startTurn derives its arguments from the admission function's options.
    const wrapper = source.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === "startTurn");
    expect(wrapper?.parameters[0].type?.getText(source)).toBe("DropFirst<Parameters<typeof startTurnAdmitting>>");
    const start = source.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === "startTurnAdmitting");
    const opts = start?.parameters.find(node => node.name.getText(source) === "opts");
    const field = opts?.type && ts.isTypeLiteralNode(opts.type) ? opts.type.members.find(node => node.name?.getText(source) === "packSuppressed") : undefined;
    expect(field, "startTurn opts declares packSuppressed").toBeDefined();
    expect(field!.getFullText(source)).toContain("Server-owned; never taken from a request body");
    const declaration = `type ActualOptions = { ${field!.getText(source)} };`;
    expect(diagnose(declaration + `const fresh: ActualOptions = {}; const rebuild: ActualOptions = { packSuppressed: true }; type Exact = Assert<Equal<ActualOptions["packSuppressed"], true | undefined>>;`)).toEqual([]);
    expect(diagnose(declaration + `const rebuild: ActualOptions = { packSuppressed: false };`).length).toBeGreaterThan(0);
  });

  it.each(pairs)("%s", (_name, accepted, rejected) => {
    expect(diagnose(accepted)).toEqual([]);
    const errors = diagnose(rejected);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join("\n")).not.toMatch(/Cannot find module|has no exported member/);
  });

  it("T-CONTRACT-SHAPES: every authority, binding and row field stays in the contract", () => {
    expect(diagnose(`
      type AuthorityFields = Assert<Equal<Pick<PackAuthority, "fromBotId" | "fromThreadId" | "generation" | "inputMessageId">,
        { readonly fromBotId: string; readonly fromThreadId: string; readonly generation: string; readonly inputMessageId: string }>>;
      type BindingFields = Assert<Equal<keyof PackBinding, "packId" | "destinationThreadId" | "generation" | "sourceThreadId" | "sourceLeafId" | "refs" | "anchor" | "driverKind" | "page">>;
      type RowFields = Assert<Equal<keyof DelegationPack, "id" | "delegation_id" | "source_thread_id" | "source_bot_id" | "target_bot_id" | "destination_thread_id" | "refs" | "prepared" | "cut_at" | "created_at">>;
      type StorageFields = Assert<Equal<keyof DelegationPackRow, keyof DelegationPack>>;
    `)).toEqual([]);
  });
});
