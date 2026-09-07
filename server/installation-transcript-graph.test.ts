import { expect, it } from "vitest";
import { InstallationTranscriptGraph } from "./installation-transcript-graph.ts";
import { INSTALLATION_MESSAGE_KINDS } from "./installation-message-validation.ts";
import type { Message } from "./store.ts";
const create = () => new InstallationTranscriptGraph(code => { throw new Error(code); });
const message = (id: string, parentId?: string | null) => ({ id, at: 1, role: "user", kind: "text", ...(parentId !== undefined ? { parentId } : {}) });

it("validates a long legacy chain iteratively without recursion", () => {
  const graph = create();
  for (let i = 0; i < 40_000; i++) graph.add(message(`m${i}`));
  expect(() => graph.validate("m39999")).not.toThrow();
});
it("accepts real branch insertion with a later parent and explicit root", () => {
  const graph = create();
  graph.add(message("child", "parent")); graph.add(message("parent", null));
  expect(() => graph.validate("child")).not.toThrow();
});
it("rejects multi-node cycles and missing parent links", () => {
  const cycle = create(); cycle.add(message("a", "b")); cycle.add(message("b", "a"));
  expect(() => cycle.validate()).toThrow("CYCLIC_MESSAGE_BRANCH");
  const missing = create(); missing.add(message("a", "foreign-thread-message"));
  expect(() => missing.validate()).toThrow("INVALID_MESSAGE_PARENT");
});
it("rejects duplicate identities, invalid message values and absent active heads", () => {
  const graph = create(); graph.add(message("a"));
  expect(() => graph.add(message("a"))).toThrow("INVALID_RESTORE_MESSAGE");
  expect(() => graph.add({ ...message("b"), at: Infinity })).toThrow("INVALID_RESTORE_MESSAGE");
  expect(() => graph.validate("missing")).toThrow("INVALID_ACTIVE_BRANCH");
});

const routineRequest = { version: 1, requestId: "request", botId: "bot", threadId: "thread", createdAt: 1, operation: { action: "create", routine: { name: "Routine", instructions: "Keep evidence", schedule: { type: "once", at: 1 }, runOn: "ember", durationMinutes: 30 } } };
const skillRequest = { version: 1, requestId: "skill-request", botId: "bot", threadId: "thread", stagedId: "staged", action: "create", name: "Skill", gist: "Help", warnings: [], createdAt: 1 };
// The mapped type makes an added store kind a compile-time fixture omission.
const kinds = {
  text: { text: "Historical text", attachments: [{ kind: "image", path: "/old/attachment.png", mime: "image/png" }] },
  options: { card: { title: "Review", subtitle: "Requested action", options: ["Allow", "Deny"], requestId: "permission", approvalScope: "local-computer" } },
  activity: { tool: { name: "Read", ok: true, spoken: "reading", setup: false } },
  screen: { png: "aW1hZ2U=", mime: "image/png" },
  connector: { connector: { slug: "gmail", label: "Mail", description: "Connect", status: "required", resumeKey: "resume" } },
  secret: { secret: { target: "xaiApiKey", label: "Key", description: "Connect", placeholder: "key", helpUrl: "https://example.invalid", requestKey: "request" } },
  "routine.run": { routineRun: { runId: "run", routineId: "routine", routineName: "Routine", status: "completed", executionThreadId: "deleted-thread", summary: "Done" } },
  "goal.run": { goalRun: { runId: "goal", goal: "Done", status: "completed", coordinatorBotId: "deleted-bot", coordinatorName: "Historical name", turnCount: 1, maxTurns: 5, startedAt: 1, finishedAt: 2 } },
} satisfies Record<Message["kind"], unknown>;

it("keeps the recovery kind inventory aligned with all declared store kinds", () => {
  expect([...INSTALLATION_MESSAGE_KINDS].sort()).toEqual(Object.keys(kinds).sort());
});
it.each(Object.entries(kinds))("accepts %s records and preserves optional historical and unknown metadata", (kind, payload) => {
  const record = { ...message("m"), role: "bot", kind, ...payload, from: { botId: "deleted", name: "Old name", color: "historic-color" }, futureMetadata: { opaque: [1, "keep"] } };
  const before = JSON.stringify(record);
  const graph = create(); graph.add(record); graph.validate("m");
  expect(JSON.stringify(record)).toBe(before);
});
it.each([
  { kind: "options", card: { title: "Legacy approval", options: ["Allow"] } },
  { kind: "goal.run", goalRun: { status: "completed", detail: "Historical receipt" } },
  { kind: "routine.run", routineRun: { status: "completed" } },
  { kind: "options", card: { title: "Routine", options: ["Allow"], routineRequest } },
  { kind: "options", card: { title: "Skill", options: ["Allow"], skillRequest } },
  { kind: "options", card: { title: "Setup", options: ["Yes", "No"], intake: { step: "confirm", outcome: "profile", asked: 2, candidate: { slug: "writer", name: "Writer", skillNames: ["Edit"] } } } },
])("accepts supported sparse receipts and proposal payloads: %j", payload => {
  const value = { ...message("m"), ...payload };
  const before = JSON.stringify(value);
  expect(() => create().add(value)).not.toThrow();
  expect(JSON.stringify(value)).toBe(before);
});
it.each([
  ["future kind", { kind: "future.execute" }],
  ["primitive card", { kind: "options", card: "execute" }],
  ["non-string option", { kind: "options", card: { title: "Approval", options: [true] } }],
  ["non-boolean dismissal", { kind: "options", card: { title: "Approval", options: [], dismissed: "false" } }],
  ["malformed approval scope", { kind: "options", card: { title: "Approval", options: [], approvalScope: "host-shell" } }],
  ["unknown routine version", { kind: "options", card: { title: "Routine", options: [], routineRequest: { ...routineRequest, version: 2 } } }],
  ["unknown routine action", { kind: "options", card: { title: "Routine", options: [], routineRequest: { ...routineRequest, operation: { action: "execute" } } } }],
  ["malformed routine definition", { kind: "options", card: { title: "Routine", options: [], routineRequest: { ...routineRequest, operation: { action: "create", routine: [] } } } }],
  ["malformed skill request", { kind: "options", card: { title: "Skill", options: [], skillRequest: { ...skillRequest, action: "execute", warnings: "none" } } }],
  ["malformed intake", { kind: "options", card: { title: "Setup", options: [], intake: { step: "confirm", asked: 99 } } }],
  ["unknown connector status", { kind: "connector", connector: { ...kinds.connector.connector, status: "execute" } }],
  ["arbitrary credential target", { kind: "secret", secret: { ...kinds.secret.secret, target: "arbitraryConfigPath" } }],
  ["primitive receipt", { kind: "goal.run", goalRun: false }],
  ["missing receipt status", { kind: "goal.run", goalRun: { detail: "unknown" } }],
  ["unknown routine outcome", { kind: "routine.run", routineRun: { status: "execute" } }],
  ["unknown goal outcome", { kind: "goal.run", goalRun: { status: "execute" } }],
  ["non-numeric turn provenance", { kind: "goal.run", goalRun: { status: "completed", turnCount: "one" } }],
  ["malformed tool", { kind: "activity", tool: { name: [], ok: "true" } }],
  ["malformed screen", { kind: "screen", png: 1 }],
  ["malformed attachment", { kind: "text", attachments: [{ kind: "image", path: {}, mime: "image/png" }] }],
] as const)("refuses %s without repairing the record", (_name, payload) => {
  const value = { ...message("m"), ...payload };
  const before = JSON.stringify(value);
  expect(() => create().add(value)).toThrow("INVALID_RESTORE_MESSAGE");
  expect(JSON.stringify(value)).toBe(before);
});
