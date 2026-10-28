// A card kind the recovery validator did not know refused the whole backup of
// any installation holding one such card: the "Turn on <name>?" MCP card
// (card.kind "mcpEnable", shipped in 1.0.4) stopped every backup capture with
// INVALID_RESTORE_MESSAGE through 1.0.8. These tests walk every card kind the
// product writes or reads, prove the validator accepts each real writer's
// output, and run one such card through capture, restore and review.
import { mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { INSTALLATION_CARD_KINDS, INSTALLATION_MESSAGE_KINDS, validInstallationMessagePayload } from "./installation-message-validation.ts";
import { snapshotInstallationDatabase } from "./installation-database-snapshot.ts";
import { writeInstallationArchive } from "./installation-archive.ts";
import { restoreInstallation } from "./installation-restore.ts";
import { activateInstallation, reviewInstallation } from "./installation-activation.ts";
import { mcpEnableCard } from "./mcp-bot-cards.ts";
import { trustCardView } from "./email/cards.ts";
import type { WebhookRequestCardData } from "../shared/routine-request.ts";
import type { RoutineRunCardData } from "../shared/routine-run.ts";
import { mcpEntryRev, type StoredMcpServer, type StoredRemoteMcpServer } from "./mcp-registry.ts";
import { backupFixture } from "./testing/backup-fixture.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const repo = join(import.meta.dirname, "..");
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) removeTempDirSync(root); });

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".") || name === "testing") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sources(path, out);
    else if (/\.(ts|tsx|mts)$/.test(name) && !/\.(test|spec)\.|\.d\.ts$/.test(name)) out.push(path);
  }
  return out;
}
const union = (body: string) => [...body.matchAll(/"([^"]+)"/g)].map(match => match[1]).sort();
function declaredKinds(name: string, optional: boolean): string[] {
  const store = readFileSync(join(repo, "server", "store.ts"), "utf8");
  const start = store.indexOf(`export interface ${name} {`);
  expect(start).toBeGreaterThanOrEqual(0);
  const body = store.slice(start, store.indexOf("\n}", start));
  const line = body.match(new RegExp(`\\n  kind${optional ? "\\?" : ""}: ([^;]+);`));
  expect(line).not.toBeNull();
  return union(line![1]);
}

const stdio: StoredMcpServer = { command: "npx", args: ["-y", "@acme/mcp"], env: {}, enabled: false, pendingEnv: ["ACME_KEY"] };
const remote: StoredRemoteMcpServer = { url: "https://mcp.example.test/mcp", transport: "sse", auth: "header", headers: {}, enabled: false, pendingHeaders: ["Authorization"] };
const bot = { id: "bot", name: "Juniper" };
const row = (id: string, card: unknown) => ({ id, at: 1, role: "bot", kind: "options", card });
// Each writer's output as it is first stored and as it is later patched (server/index.ts, server/publish/publish-ops.ts).
function writtenCards(): Record<string, unknown[]> {
  const fresh = mcpEnableCard("acme", stdio, mcpEntryRev("acme", stdio), bot);
  const linked = mcpEnableCard("linked", remote, mcpEntryRev("linked", remote), bot);
  return {
    mcpEnable: [
      fresh, linked,
      { ...fresh, dismissed: true, mcpEnable: { ...fresh.mcpEnable, error: "This card is out of date." } },
      { ...fresh, mcpEnable: { ...fresh.mcpEnable, pendingKeys: ["ACME_KEY"], error: "Add the key first." } },
      JSON.parse(JSON.stringify({ ...linked, answered: "Turn on", mcpEnable: { ...linked.mcpEnable, pendingKeys: [], enabled: true, error: undefined } })),
    ],
    publish: [
      { title: "Connect Netlify", subtitle: "", options: [], kind: "publish", publish: { action: "connect", host: "netlify", url: "https://app.netlify.com", connect: { state: "connected", botId: "bot" } } },
      { title: "Publish this site?", subtitle: "", options: [], kind: "publish", answered: "failed", publish: { action: "publish", host: "netlify", url: "https://www.netlify.com", progress: { step: "failed", failure: "too-big" } } },
      { title: "Publish this site?", subtitle: "3 files", held: "turn", options: ["Allow", "Deny"], requestId: "publish-1", tool: "publish_site", kind: "publish", pushBody: "Juniper wants to publish", publish: { action: "publish", host: "netlify", url: "https://x.netlify.app", files: [{ path: "index.html", size: 10 }], totalBytes: 10, progress: { step: "live", fileCount: 1 } } },
    ],
    // bot email (1.0.9): the send card as the snapshot stages it and the trust offer card from its builder, open and settled
    "email-send": [
      { kind: "email-send", tool: "email_send", requestId: "email:snd-1", title: "Send this email?", subtitle: "To: a@x.test\nSubject: Hello", pushBody: "Juniper wants to send an email", options: ["Send"], emailSend: { sendId: "snd-1", revision: 1, payloadHash: "0".repeat(64), heldIds: [], state: "held", phase: "open", ref: "snd-1", botId: "b1", actions: ["send"], draft: { to: ["a@x.test"], cc: [], subject: "Hello", text: "" }, links: { manage: "Manage email" } } },
      { kind: "email-send", tool: "email_send", requestId: "email:snd-2", title: "Sent", subtitle: "To: a@x.test\nSubject: Hello", pushBody: "Juniper wants to send an email", options: [], answered: "allow", emailSend: { sendId: "snd-2", revision: 2, payloadHash: "1".repeat(64), heldIds: ["h1"], state: "sent", phase: "settled", ref: "snd-2", botId: "b1", actions: [], draft: { to: ["a@x.test"], cc: [], subject: "Hello", text: "" }, links: { manage: "Manage email" } } },
    ],
    "email-trust-offer": [
      trustCardView("Juniper", { botId: "b1", address: "a@x.test", offeredAt: 1, phase: "open" }),
      trustCardView("Juniper", { botId: "b1", address: "a@x.test", offeredAt: 1, phase: "added" }),
    ],
  };
}

it("the validator knows exactly the card and message kinds the store declares", () => {
  expect([...INSTALLATION_CARD_KINDS].sort()).toEqual(declaredKinds("OptionCardData", true));
  expect([...INSTALLATION_MESSAGE_KINDS].sort()).toEqual(declaredKinds("Message", false));
});

it("every card kind any shipped code writes or reads is one the validator accepts", () => {
  const found = new Map<string, string>();
  const patterns = [
    /\.card\??\.kind\s*===?\s*"([^"]+)"/g, // readers: message.card?.kind === "x"
    /\$\.card\.kind'\)\s*=\s*'([^']+)'/g, // SQL readers
    /options:\s*\[[^\]]*\],\s*kind:\s*"([^"]+)"/g, // writers: { ..., options: [...], kind: "x" }
    /kind:\s*"([^"]+)",\s*(?:publish|mcpEnable)\b/g, // writers: { kind: "x", publish|mcpEnable: ... }
    /options: string\[\]; kind: "([^"]+)"/g, // typed writers (mcpEnableCard)
  ];
  for (const file of ["server", "shared", "src"].flatMap(dir => sources(join(repo, dir)))) {
    // comments name kinds in prose; only code counts
    const text = readFileSync(file, "utf8").split("\n").filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line)).join("\n");
    for (const pattern of patterns) for (const match of text.matchAll(pattern)) found.set(match[1], relative(repo, file));
  }
  // The scan does find the two shipped kinds, so a new one in the same shape is caught.
  expect([...found.keys()].sort()).toEqual(expect.arrayContaining(["mcpEnable", "publish"]));
  for (const [kind, file] of found) expect(INSTALLATION_CARD_KINDS as readonly string[], `${kind} (${file})`).toContain(kind);
  const cards = writtenCards();
  expect(Object.keys(cards).sort()).toEqual([...INSTALLATION_CARD_KINDS].sort());
  for (const [kind, list] of Object.entries(cards)) for (const [i, card] of list.entries()) {
    expect(validInstallationMessagePayload(row(`${kind}-${i}`, card)), `${kind} #${i}`).toBe(true);
  }
});

// Two more shapes shipped code writes that the 1.0.8 validator refused, each stopping every backup:
// a routine run waiting on the owner past its limit (index.ts routineRunCard) and a webhook proposed from chat (routine-requests.ts proposeWebhook).
it("a routine run that needs the owner and every webhook proposal card are accepted", () => {
  const run: RoutineRunCardData = { status: "needs-you", runId: "r", routineId: "rt", routineName: "Daily", summary: "Waiting on you" } as RoutineRunCardData;
  expect(validInstallationMessagePayload({ id: "run", at: 1, role: "bot", kind: "routine.run", routineRun: run })).toBe(true);
  const base = { version: 1 as const, kind: "webhook" as const, requestId: "req", botId: "bot", threadId: "thread", createdAt: 1 };
  const manage = { webhookId: "wh-1", expectedUpdatedAt: 2 };
  const webhooks: WebhookRequestCardData[] = [
    { ...base, operation: { action: "create", webhook: { id: "wh-1", name: "Orders", prompt: "Summarise the order", eventTypes: ["order.created"] } } },
    { ...base, operation: { action: "update", ...manage, changes: { name: "Orders 2", eventTypes: [] } } },
    { ...base, operation: { action: "pause", ...manage } },
    { ...base, operation: { action: "resume", ...manage } },
    { ...base, operation: { action: "delete", ...manage }, appliedAt: 3, resultId: "wh-1" },
  ];
  for (const routineRequest of webhooks) {
    const card = { title: "Add this webhook?", subtitle: "Orders", options: ["Confirm", "Cancel"], requestId: "req", tool: "webhook", routineRequest, routineProposalDigest: "d" };
    expect(validInstallationMessagePayload(row(`webhook-${routineRequest.operation.action}`, card)), routineRequest.operation.action).toBe(true);
  }
  expect(validInstallationMessagePayload(row("bad", { title: "t", options: [], routineRequest: { ...base, operation: { action: "pause" } } }))).toBe(false);
  expect(validInstallationMessagePayload({ id: "run", at: 1, role: "bot", kind: "routine.run", routineRun: { status: "lost" } })).toBe(false);
});

it("an unknown card kind or an unknown mcpEnable field is still refused", () => {
  const card = mcpEnableCard("acme", stdio, "rev", bot);
  expect(validInstallationMessagePayload(row("x", { ...card, kind: "something-new" }))).toBe(false);
  expect(validInstallationMessagePayload(row("x", { ...card, mcpEnable: { ...card.mcpEnable, env: { TOKEN: "x" } } }))).toBe(false);
  expect(validInstallationMessagePayload(row("x", { ...card, mcpEnable: { ...card.mcpEnable, kind: "shell" } }))).toBe(false);
  expect(validInstallationMessagePayload(row("x", { ...card, mcpEnable: { ...card.mcpEnable, pendingKeys: undefined } }))).toBe(false);
});

it("an installation holding a Turn on card backs up, restores and opens for review with the card intact", async () => {
  const f = backupFixture(); roots.push(f.parent);
  const card = mcpEnableCard("acme", stdio, mcpEntryRev("acme", stdio), bot);
  const message = { ...row("turn-on", card), at: 2, parentId: "message" };
  f.db.prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES(?,?,?,?,?,?,?)").run("thread", "turn-on", 2, "bot", "options", null, JSON.stringify(message));
  f.db.exec("UPDATE thread_state SET active_leaf_id='turn-on'");
  f.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  expect(await snapshotInstallationDatabase(f.data, join(f.parent, "staged.db"))).toMatchObject({ status: "copied", messages: 2 });
  f.db.close();
  const archive = join(f.parent, "backup.zip"), saved = await writeInstallationArchive(f.data, archive);
  const target = join(f.parent, "target"); mkdirSync(target);
  await restoreInstallation(target, archive, saved.sha256);
  const restored = new DatabaseSync(join(target, "messages.db"), { readOnly: true });
  try {
    const kept = JSON.parse((restored.prepare("SELECT json FROM messages WHERE id='turn-on'").get() as { json: string }).json);
    expect(kept.card.kind).toBe("mcpEnable");
    expect(kept.card.mcpEnable).toEqual(card.mcpEnable);
  } finally { restored.close(); }
  const review = reviewInstallation(target);
  expect(review.status).toBe("ready-for-review");
  expect(activateInstallation(target, review.reviewHash).status).toBe("reviewed-engines-disabled");
});
