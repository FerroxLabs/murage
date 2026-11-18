// SPDX-License-Identifier: AGPL-3.0-or-later
// Fold producer and consumer owner: r2-owner-limit-projects-z.
import { readFileSync } from "node:fs";
import ts from "typescript";
import { expect, it } from "vitest";
import { createReplySpeakerTurns } from "./reply-speaker-guard.ts";

const source = ts.createSourceFile("index.ts", readFileSync(new URL("./index.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
const binding = source.statements.flatMap(statement => ts.isVariableStatement(statement) ? [...statement.declarationList.declarations] : [])
  .find(declaration => declaration.name.getText(source) === "foldRuntimeEvent");
if (!binding?.initializer) throw new Error("Missing runtime fold");
const code = ts.transpileModule(`const fold = ${binding.initializer.getText(source)};`, { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.None } }).outputText;
const names = { self: "Nova", owner: "Owner", teammates: ["Reed"] };

for (const emptyLocal of [false, true]) it(`the real fold filters audience speech and keeps buffered emissions when local delta is empty (${emptyLocal})`, () => {
  const replySpeakerTurns = createReplySpeakerTurns(), displaySpeakerTurns = createReplySpeakerTurns();
  if (emptyLocal) replySpeakerTurns.delta("room", "turn", "Please supply the input.\nUser: I supplied it.\nMore", names);
  const text = emptyLocal ? "Second reply." : "Please supply the input.\nUser: I supplied it.\nMore";
  const event = Object.freeze({ type: "content.delta", threadId: "room", turnId: "turn", itemId: "current", streamKind: "assistant_text", delta: text });
  const emission = { envelope: { generation: 1 }, emissionId: "safe-emission", event: { ...event, itemId: "buffered", regionId: "buffered-region", speechDisposition: "append" } };
  const seen: any[] = [], spoken: string[] = [];
  const end = new Error("fold observed through speech");
  const scope = {
    bus: { audienceFor: () => [emission], audienceMaskedFor: () => false },
    admittedLedgerLeases: new Map(), terminalDispatchFor: () => undefined, terminalPreparations: new WeakMap(), shellPrepared: new WeakMap(), shellPreparedRecord: new WeakMap(), fluxFirstTokenProbe: { observe() {} }, accountProjectEvent() {}, shouldIgnoreProviderEvent: () => false,
    directRuns: new Map(), callSpeech: { provider: () => ({ botId: "speaker", generationId: "generation" }), append: (...args: unknown[]) => spoken.push(String(args[4])) },
    replyGuardContext: () => ({ names }), replySpeakerTurns, displaySpeakerTurns,
    roomLiveTurns: new Map(), fluxMemoryCapture: { observe() {} }, localVmThreadTargets: new Map(), groupGoalCoordinatorTurns: new Map(),
    groupGoalCoordinatorTurnForEvent: () => undefined, liveSubtasks: new Map(),
    broadcast: (frame: unknown) => seen.push(frame), routines: { handleRuntimeEvent: () => { throw end; } },
  };
  // Execute the actual production binding; stop after both public sinks, before unrelated durable folding.
  const fold = new Function("scope", `with(scope) { ${code}; return fold; }`)(scope);
  expect(() => fold(event)).toThrow(end);
  const expected = emptyLocal ? "Second reply." : "Please supply the input.";
  expect(seen).toEqual([{ kind: "runtime", event: { ...emission.event, delta: expected } }]);
  expect(spoken).toEqual([expected]);
  expect(event.delta).toBe(text);
  expect(emission.event.delta).toBe(text);
});
