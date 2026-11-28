// D25-V3 (1.0.23): a bot made by create_bot starts with connected apps off in its first record, and its creator's apps reach it only
// through the owner's copy-from-creator action. Real Store on a temp data dir, real reviewBotAccess; nothing under test is mocked.
// Witness ids W1/W4-W8 follow designs/D25-V3-OWNER-APPS-COPY-1023.md section 6 (W1 store half; the handler half is create-bot-apps-off-1023-api.test.ts).
import { mkdirSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { serviceQueueFixture } from "./testing/service-queue-fixture.ts";
import { flushCoalesced } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";
import { closeDatabase } from "./database.ts";
import { Store, RosterPostCommitError } from "./store.ts";
import { accessOwnerView, assertConnectedAppCall, botAccessApprovalQueue, reviewBotAccess as reviewProduct } from "./bot-access.ts";
import { botAccessPolicy } from "./bot-access-role.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
import { installPermissionInheritance } from "./permission-inheritance.ts";

beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });
afterEach(() => vi.useRealTimers());
const A = { toolkit: "gmail", accountId: "ca_fixture_a" };
const B = { toolkit: "gmail", accountId: "ca_fixture_b" };
const READ = { ...A, tools: ["GMAIL_FETCH_EMAILS"] };
const ACCOUNTS = [A, B];
const selection = () => ({ instanceId: "fixture", model: "fixture" });
function review(store: Store, ...args: [string, unknown, typeof ACCOUNTS]) {
  serviceQueueFixture(store).queue(botAccessApprovalQueue(store));
  return reviewProduct(store, ...args);
}
function setup(opts: { creatorGrants?: typeof READ[]; writes?: boolean } = {}) {
  const store = new Store(selection);
  const creator = store.createBot({ name: "Creator", section: "Studio" });
  store.setChiefOfStaff(creator.id, undefined, "section");
  if (opts.creatorGrants) review(store, creator.id, { action: "configure", revision: botAccessPolicy(creator).revision, mode: "restricted", allowWrites: opts.writes ?? false, grants: opts.creatorGrants }, ACCOUNTS);
  const child = store.createBot({ name: "Child", section: "Studio" }, { appsOff: { sourceBotId: creator.id } });
  return { store, creator, child };
}
type F = ReturnType<typeof setup>;
const offer = (f: F) => (accessOwnerView(f.store, f.store.bot(f.child.id)!) as any).copyFrom;
const press = (f: F, digest = offer(f)?.sourceDigest, accounts = ACCOUNTS) =>
  review(f.store, f.child.id, { action: "copy-from-creator", revision: botAccessPolicy(f.store.bot(f.child.id)!).revision, sourceDigest: digest }, accounts);
const reload = (): Store => { flushCoalesced(); closeDatabase(); return new Store(selection); };
const gmail = (tool: string, account = A.accountId) => ({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "COMPOSIO_MULTI_EXECUTE_TOOL", arguments: { tools: [{ tool_slug: tool, account, arguments: { to: "fake@example.invalid" } }] } } });
const status = (fn: () => unknown) => { try { fn(); return 200; } catch (e) { return (e as { status?: number }).status ?? 500; } };
const message = (fn: () => unknown) => { try { fn(); return ""; } catch (e) { return (e as Error).message; } };

it("W1 store: the first record written for an appsOff bot has composio:false and its creator", () => {
  const store = new Store(selection);
  const creator = store.createBot({ name: "Creator" });
  const child = store.createBot({ name: "Child" }, { appsOff: { sourceBotId: creator.id } });
  const fresh = reload().bot(child.id)!;
  expect(fresh.composio).toBe(false);
  expect(fresh.appsSourceBotId).toBe(creator.id);
  expect(store.createBot({ name: "Plain" }).composio).toBeUndefined();
});

it("W4 owner copy: the child gets the creator's grants, bound, apps on, and the creator's tool passes", () => {
  const f = setup({ creatorGrants: [READ] });
  expect(f.store.bot(f.child.id)!.composio).toBe(false);
  press(f);
  const child = reload().bot(f.child.id)!;
  const policy = botAccessPolicy(child);
  expect(child.composio).toBe(true);
  expect(policy.mode).toBe("restricted");
  expect(policy.grants).toEqual([READ]);
  expect(policy.allowWrites).toBe(false);
  expect(policy.requests).toEqual([]);
  expect(() => assertConnectedAppCall(child, gmail("GMAIL_FETCH_EMAILS"))).not.toThrow();
});

it("W4b a post-commit throw leaves the disk COPIED and a fresh view shows the bound policy", () => {
  const f = setup({ creatorGrants: [READ] });
  const real = f.store.patchBot.bind(f.store);
  vi.spyOn(f.store, "patchBot").mockImplementation((id, patch, options) => { const out = real(id, patch, options); if (id === f.child.id) throw new RosterPostCommitError(new Error("fixture"), []); return out; });
  expect(() => press(f)).toThrow();
  vi.restoreAllMocks();
  const view = accessOwnerView(f.store, reload().bot(f.child.id)!);
  expect(view.enabled).toBe(true);
  expect(view.policy.grants).toEqual([READ]);
});

it("W5 stale digest: a change to the creator's grants after the view gives 409, no write; the new digest then works", () => {
  const f = setup({ creatorGrants: [READ] });
  const first = offer(f).sourceDigest;
  review(f.store, f.creator.id, { action: "configure", revision: botAccessPolicy(f.store.bot(f.creator.id)!).revision, mode: "restricted", allowWrites: false, grants: [{ ...A, tools: ["GMAIL_FETCH_EMAILS", "GMAIL_GET_PROFILE"] }] }, ACCOUNTS);
  expect(status(() => press(f, first))).toBe(409);
  expect(reload().bot(f.child.id)!.composio).toBe(false);
  const second = offer(f).sourceDigest;
  expect(second).not.toBe(first);
  press(f, second);
  expect(botAccessPolicy(f.store.bot(f.child.id)!).grants).toEqual([{ ...A, tools: ["GMAIL_FETCH_EMAILS", "GMAIL_GET_PROFILE"] }]);
});

it("W5 stale digest, title case on an unrestricted creator (no record): digest changes, the new press succeeds", () => {
  const f = setup();
  const first = offer(f).sourceDigest;
  f.store.patchBot(f.creator.id, { title: "Different role" });
  expect(status(() => press(f, first))).toBe(409);
  press(f);
  expect(botAccessPolicy(f.store.bot(f.child.id)!).mode).toBe("unrestricted");
});

it("W5 a plain rename of the creator changes no reach and no digest", () => {
  const f = setup({ creatorGrants: [READ] });
  const first = offer(f).sourceDigest;
  f.store.patchBot(f.creator.id, { name: "Renamed" });
  expect(offer(f).sourceDigest).toBe(first);
});

it("W6 never more: Gmail read passes after the copy; send, other apps and another account are refused; an over-wide copy would flip these", () => {
  const f = setup({ creatorGrants: [READ] });
  press(f);
  const child = f.store.bot(f.child.id)!;
  expect(() => assertConnectedAppCall(child, gmail("GMAIL_FETCH_EMAILS"))).not.toThrow();
  expect(() => assertConnectedAppCall(child, gmail("GMAIL_SEND_EMAIL"))).toThrow();
  expect(() => assertConnectedAppCall(child, gmail("SLACK_SEND_MESSAGE"))).toThrow();
  expect(() => assertConnectedAppCall(child, gmail("GMAIL_FETCH_EMAILS", B.accountId))).toThrow();
  const policy = botAccessPolicy(child);
  expect(policy.mode).toBe("restricted");
  expect(policy.allowWrites).toBe(false);
});

it("W6 the creator account disconnected between view and press gives 409", () => {
  const f = setup({ creatorGrants: [READ] });
  expect(status(() => press(f, offer(f).sourceDigest, [B]))).toBe(409);
  expect(reload().bot(f.child.id)!.composio).toBe(false);
});

it("W6b a corrupt or role-stale creator record gives 409 nothing to give, child unchanged", () => {
  const f = setup({ creatorGrants: [READ] });
  f.store.patchBot(f.creator.id, { title: "Moved role" });
  const view = offer(f);
  expect(view.available).toBe(false);
  expect(view.reason).toBe("nothing");
  expect(status(() => press(f, "0".repeat(64)))).toBe(409);
  expect(reload().bot(f.child.id)!.composio).toBe(false);
});

it("W6c the creator's refusals follow the copy once, with fresh ids, and a second press adds none", () => {
  const f = setup();
  const policy = botAccessPolicy(f.store.bot(f.creator.id)!);
  f.store.patchBot(f.creator.id, { connectedAppAccess: { ...policy, revision: 1, denials: [{ id: "creator-rule", toolkit: "gmail", accountId: A.accountId, tools: ["GMAIL_SEND_EMAIL"], ops: ["write"], source: "request-denied", at: 1, revision: 1 }] } as never });
  press(f);
  const once = botAccessPolicy(f.store.bot(f.child.id)!).denials!;
  expect(once).toHaveLength(1);
  expect(once[0].tools).toEqual(["GMAIL_SEND_EMAIL"]);
  expect(once[0].id).not.toBe("creator-rule");
  press(f);
  press(f);
  expect(botAccessPolicy(f.store.bot(f.child.id)!).denials).toHaveLength(1);
});

it("W6d a No limits child previews the unrestricted reach, and a level change after the view gives 409", () => {
  const f = setup({ creatorGrants: [READ] });
  const first = offer(f);
  expect(first.noLimits).toBe(false);
  f.store.patchBot(f.child.id, { noLimits: true });
  expect(offer(f).noLimits).toBe(true);
  expect(status(() => press(f, first.sourceDigest))).toBe(409);
});

it("W6d the same when only one chat of the child is on No limits (the bot level stays Auto)", () => {
  const f = setup({ creatorGrants: [READ] });
  const first = offer(f);
  const task = f.store.bot(f.child.id)!.tasks![0];
  f.store.patchTask(f.child.id, task.threadId, { noLimits: true } as never);
  expect(f.store.bot(f.child.id)!.noLimits).not.toBe(true);
  expect(offer(f).noLimits, "chat level").toBe(true);
  expect(status(() => press(f, first.sourceDigest))).toBe(409);
});

it("W6f the owner's No limits default is inherited by a child with no recorded level: preview, digest and reach agree", () => {
  const f = setup({ creatorGrants: [READ] });
  expect(f.store.bot(f.child.id)!.noLimits).not.toBe(true);
  const first = offer(f);
  expect(first.noLimits).toBe(false);
  const restore = installPermissionInheritance(() => true);
  try {
    expect(offer(f).noLimits, "inherited bot level").toBe(true);
    expect(offer(f).sourceDigest, "digest follows the inherited level").not.toBe(first.sourceDigest);
    expect(status(() => press(f, first.sourceDigest)), "stale view").toBe(409);
  } finally { restore(); }
});

it("W6f a bot with an explicit lower level (and so its chats) does not inherit the default", () => {
  const f = setup({ creatorGrants: [READ] });
  const restore = installPermissionInheritance(() => true);
  try {
    expect(offer(f).noLimits, "inherited").toBe(true);
    f.store.patchBot(f.child.id, { permissionExplicit: true, autoApprove: true, fullAccess: false, noLimits: false } as never);
    expect(offer(f).noLimits, "explicit lower bot level").toBe(false);
  } finally { restore(); }
});

it("W6f a copy pressed on the inherited-No-limits preview applies the narrow list and the next preview still says No limits", () => {
  const f = setup({ creatorGrants: [READ] });
  const restore = installPermissionInheritance(() => true);
  try {
    const view = offer(f);
    expect(view.noLimits, "preview names No limits").toBe(true);
    expect(status(() => press(f, view.sourceDigest)), "the fresh digest is accepted").toBe(200);
    const policy = botAccessPolicy(f.store.bot(f.child.id)!);
    expect(policy.mode).toBe("restricted");
    expect(policy.grants).toEqual([READ]);
    expect(offer(f).noLimits, "still on No limits after the copy").toBe(true);
  } finally { restore(); }
});

it("W6e a child made drafts-only after the view gives 409 (the preview line names it)", () => {
  const f = setup({ creatorGrants: [READ] });
  const first = offer(f);
  expect(first.draftOnly).toBe(false);
  f.store.patchBot(f.child.id, { draftOnly: true });
  expect(offer(f).draftOnly).toBe(true);
  expect(status(() => press(f, first.sourceDigest)), "drafts only").toBe(409);
});

it("W7 eligibility: each of these gives 409 and writes nothing, for a creator with a policy record and for an unrestricted one", () => {
  const cases: Array<[string, (f: F) => void]> = [
    ["creator apps off", f => { f.store.patchBot(f.creator.id, { composio: false }); }],
    ["creator hidden", f => { f.store.patchBot(f.creator.id, { hidden: true }); }],
    ["creator draft only", f => { f.store.patchBot(f.creator.id, { draftOnly: true }); }],
    ["creator staged", f => { f.store.bot(f.creator.id)!.staged = { reason: "owner-review", intended: {} } as never; }],
    ["creator deleted", f => { f.store.deleteBot(f.creator.id); }],
  ];
  for (const creatorGrants of [[READ], undefined]) for (const [label, change] of cases) {
    removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); closeDatabase();
    const f = setup({ creatorGrants });
    const digest = offer(f).sourceDigest;
    change(f);
    const name = `${label} (${creatorGrants ? "restricted" : "unrestricted"} creator)`;
    expect(status(() => press(f, digest)), name).toBe(409);
    // the eligibility check answers first, with its own words (not the "apps changed" of the digest fence)
    expect(message(() => press(f, digest)), name).toMatch(/can't share apps right now/);
    expect(reload().bot(f.child.id)!.composio, name).toBe(false);
  }
});

it("W7 the child hidden or staged is refused (no write); a staged child keeps its creator mark and shows no offer until it settles", () => {
  const f = setup({ creatorGrants: [READ] });
  const digest = offer(f).sourceDigest;
  f.store.patchBot(f.child.id, { hidden: true });
  expect(status(() => press(f, digest))).toBe(409);
  f.store.patchBot(f.child.id, { hidden: false });
  const staged = f.store.createBot({ name: "Staged" }, { appsOff: { sourceBotId: f.creator.id }, staged: { reason: "owner-review", intended: {} } as never });
  expect(staged.composio).toBe(false);
  expect(staged.appsSourceBotId).toBe(f.creator.id);
  expect((accessOwnerView(f.store, staged) as any).copyFrom).toBeUndefined();
  const stagedPress = () => review(f.store, staged.id, { action: "copy-from-creator", revision: botAccessPolicy(staged).revision, sourceDigest: digest }, ACCOUNTS);
  expect(status(stagedPress)).toBe(409);
  expect(message(stagedPress)).toMatch(/can't take connected apps/);
  expect(f.store.bot(staged.id)!.composio).toBe(false);
});

it("W8 one-off copy: narrowing the creator's grant later leaves the child's, and the next offer has a new digest", () => {
  const two = { ...A, tools: ["GMAIL_FETCH_EMAILS", "GMAIL_GET_PROFILE"] };
  const f = setup({ creatorGrants: [two] });
  const before = offer(f).sourceDigest;
  press(f);
  review(f.store, f.creator.id, { action: "configure", revision: botAccessPolicy(f.store.bot(f.creator.id)!).revision, mode: "restricted", allowWrites: false, grants: [READ] }, ACCOUNTS);
  expect(botAccessPolicy(f.store.bot(f.child.id)!).grants).toEqual([two]);
  expect(() => assertConnectedAppCall(f.store.bot(f.child.id)!, gmail("GMAIL_GET_PROFILE"))).not.toThrow();
  const next = offer(f);
  expect(next.available).toBe(true);
  expect(next.grants).toEqual([READ]);
  expect(next.sourceDigest).not.toBe(before);
});

it("an unrestricted creator copies as the creator's exact reach", () => {
  const f = setup();
  expect(offer(f)).toMatchObject({ available: true, unrestricted: true, allowWrites: true });
  press(f);
  expect(botAccessPolicy(f.store.bot(f.child.id)!)).toMatchObject({ mode: "unrestricted", allowWrites: true, grants: [] });
});

it("the body carries nothing but action, revision and sourceDigest", () => {
  const f = setup({ creatorGrants: [READ] });
  const revision = botAccessPolicy(f.store.bot(f.child.id)!).revision;
  expect(status(() => review(f.store, f.child.id, { action: "copy-from-creator", revision, sourceDigest: offer(f).sourceDigest, grants: [{ ...B, tools: ["GMAIL_SEND_EMAIL"] }], allowWrites: true }, ACCOUNTS))).toBe(400);
  expect(f.store.bot(f.child.id)!.composio).toBe(false);
});
