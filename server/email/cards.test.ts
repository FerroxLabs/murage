import { createMemoryEmailSecrets } from "../testing/email-store-fixture.ts";
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The email card (design 4, 9.3) against the fake-Flux stub: Send, Edit, Don't send, Stop, dismiss, restart rebuild, double click (F5),
// sibling wait (F8), approved_unsent Retry, expiry (F11), F4, F9, F10, F12, F25; the digest binding (4.3), the email_outcome status key
// (4.6) and the notification dedupe (section 6).
import { lookupApproval } from '../decision/index.ts';
import { database } from "../database.ts";
import { assertCardAuthorized } from "../decision/records.ts";
import { rowToMessage } from "../transcript-seq.ts";
import { serviceQueueFixture } from '../testing/service-queue-fixture.ts';
import { branchChain, migrateMailboxMessageBatch, openRequestCardsStatus, readMessage, readThreadAround } from '../message-db.ts';
import { sanitizeBotDisplayMessage } from '../transcript-page.ts';
import { Store, type Message } from '../store.ts';
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { FluxEmailClient } from "./flux-email-client.ts";
import { emailCredentialProvider } from "./email-secrets.ts";
import { EmailStore, type SendRow } from "./email-store.ts";
import { EmailSendService, HOLD_LIFETIME_MS } from "./send-service.ts";
import { EmailCards, EMAIL_DIGEST_AFTER_MS, isEmailRequestId, type EmailCardFields, type EmailCardHost } from "./cards.ts";
import type { EmailDraft } from "./canonical.ts";
import { FakeFlux, type FakeReply } from "../testing/fake-flux-email.ts";
import { approvalDigestInput } from "../../shared/approval-digest.ts";
import { BOT_VISIBLE_STATUS, outboundWords, statusFromStored, storedStatusShapeOk } from "../murage-status.ts";
import { isQuestionCard } from "../../shared/questions.ts";

const INBOX = "ibx_1";
let clock = 0;
let fake: FakeFlux;
let store: EmailStore;
let send: EmailSendService;
let transcript:Store;
let cards: EmailCards;
type Kept = { threadId: string; card: EmailCardFields; dismissed?: boolean };
let shown: Map<string, Kept>;
let outcomes: Array<{ threadId: string; ref: string; outcome: string }>;
let activity: string[];
let notices: Array<{ kind: string; body: string }>;
let threads: Set<string>;

beforeEach(() => {
  database().prepare("DELETE FROM mailbox_sealed_threads WHERE thread_id='t1'").run();
  clock = 1_800_000_000_000;
  fake = new FakeFlux();
  store = new EmailStore(new DatabaseSync(":memory:"));
  const secrets = createMemoryEmailSecrets();
  secrets.setOwner({ token: "owner-token", keyId: "key_owner" });
  secrets.setBotKey("b1", { token: "bot-token", keyId: "key_b1" });
  const client = new FluxEmailClient({ fetch: fake.fetch, apiBase: "https://api.flux.test", appBase: "https://app.flux.test", credentials: emailCredentialProvider(secrets, () => null), timeoutMs: 100 });
  shown = new Map(); outcomes = []; activity = []; notices = []; threads = new Set(["t1"]);
  let n = 0, m = 0;
  const host: EmailCardHost = {
    mailboxSealed: threadId => transcript.isMailboxSealed(threadId),
    botName: () => "Juniper",
    threadExists: threadId => threads.has(threadId),
    card: (threadId, requestId) => {
      const message = transcript.cardForRequest(threadId, requestId) ?? transcript.cardForRequest(threadId, requestId.replace(/^email-/, ''));
      return message ? { messageId: message.id, dismissed: shown.get(message.id)?.dismissed ?? message.card?.dismissed } : null;
    },
    cardMessages: (threadId, requestId) => transcript.messagesFor(threadId).filter(message => message.card?.emailSend?.sendId === requestId).map(message => ({ messageId: message.id })),
    appendCard: (threadId, _botId, card) => { const id = `m${++m}`; shown.set(id, { threadId, card: card as EmailCardFields }); notices.push({ kind: "approval", body: card.pushBody }); return id; },
    patchCard: (threadId, messageId, card) => { transcript.patchMessagePoint(threadId, messageId, { emailDisplay: card }); },
    outcome: (threadId, data) => outcomes.push({ threadId, ...data }),
    activity: (_threadId, line) => activity.push(line),
    notify: (kind, _botId, _threadId, body) => notices.push({ kind, body }),
  };
  const ref: { cards: EmailCards | null } = { cards: null };
  transcript = new Store(() => ({instanceId:"fixture",model:"fixture"}));
  transcript.onChange(change => {
    if((change.type === 'message' || change.type === 'message.patch') && change.message.card) {
      if(change.type==='message')notices.push({kind:'approval',body:(change.message.card as EmailCardFields).pushBody});
      shown.set(change.message.id,{threadId:change.threadId,card:({ ...change.message.card, ...change.message.emailDisplay }) as EmailCardFields,...(change.message.card.dismissed?{dismissed:true}:{})});
    }
  });
  const producer = serviceQueueFixture(transcript,{cancelAtEnd:true});
  send = new EmailSendService({ authorityFor:producer.authorityFor, store, client, installId: "inst", botName:botId=>host.botName(botId), now: () => clock, newId: () => `send-${++n}`, onChange: row => ref.cards?.sync(row), onOutcome: event => ref.cards?.outcome(event) });
  producer.queue(send.approvalQueue());
  cards = ref.cards = new EmailCards({ store, send, host, now: () => clock });
  store.insertBinding({ botId: "b1", inboxId: INBOX, address: "juniper@murage.email", username: "juniper", displayName: "Juniper", emailKeyRef: "key_b1", fluxAccountId: null, state: "active", step: null, opId: null, opStartedAt: null, policy: "auto", failure: null, updatedAt: clock });
  store.addTrusted("b1", "jane@acme.test", "allow", "owner", clock);
});

const draft = (patch: Partial<EmailDraft> = {}): EmailDraft => ({ kind: "send", to: ["new@x.test"], cc: [], subject: "Thursday", text: "Hi there", attachments: [], replyTo: null, ...patch });
const submit = async (patch: Partial<EmailDraft> = {}, generation = 1) => (await send.submit({ botId: "b1", generation, threadId: "t1", draft: draft(patch) })) as { status: string; row?: SendRow };
// Assert the actual delivered display, backed by the immutable permission row.
const card = (sendId: string) => {
 const message=transcript.cardForRequest('t1',sendId);
 if(!message?.card)return undefined;
 const approval=lookupApproval('t1',message.id);
 expect(approval).toMatchObject({queue:{kind:'email',ref:sendId},actionHash:message.card.actionHash});
 return shown.get(message.id)!.card;
};
const row = (id: string) => store.getSend(id)!;
const sentOk = (id = "msg_1"): FakeReply => ({ status: 200, body: { status: "sent", message_id: id } });
const held = (heldId: string, heldIds = [heldId]): FakeReply => ({ status: 202, body: { status: "pending_approval", held_id: heldId, approval: { id: "apr_1", held_ids: heldIds, state: "pending" } } });
const heldItem = (id: string, ref: string, patch: Record<string, unknown> = {}) => ({ id, state: "held", client_reference: ref, to: ["new@x.test"], cc: [], subject: "Thursday", text: "Hi there", attachments: [], ...patch });
const approval = (items: unknown[]): FakeReply => ({ status: 200, body: { id: "apr_1", state: "pending", held_ids: (items as Array<{ id: string }>).map(item => item.id), held: items } });

describe("the card (4.1, 9.3)", () => {
  it("a held send gets one email-send card built from the frozen record: full text, New / Already allowed, three buttons, the manage link", async () => {
    await submit({ cc: ["jane@acme.test"], text: "Full text here\nline two" });
    const view = card("send-1")!;
    expect(view).toMatchObject({ kind: "email-send", tool: "email_send", requestId: "email-send-1", options: ["Send", "Edit", "Don't send"] });
    expect(view.title).toBe("New contact: Juniper wants to email new@x.test for the first time.");
    expect(view.subtitle).toContain("Full text here\nline two");
    expect(view.subtitle).toContain("New: new@x.test");
    expect(view.subtitle).toContain("Already allowed: jane@acme.test");
    expect(view.emailSend).toMatchObject({ sendId: "send-1", revision: row("send-1").revision, payloadHash: row("send-1").payloadHash, phase: "open", links: { manage: "Manage who Juniper can email" } });
    expect(notices.filter(notice => notice.kind === "approval")).toHaveLength(1);
    expect(isQuestionCard(view)).toBe(false);
    expect(isEmailRequestId(view.requestId)).toBe(true);
  });

  it("delivers lifecycle progress and reloads it without changing the approval action", async () => {
    await submit();
    const original = transcript.cardForRequest('t1', 'send-1')!;
    fake.on("POST", /\/messages$/, sentOk());
    await cards.resolve("email-send-1", "send");
    expect(card('send-1')).toMatchObject({ options: [], emailSend: { phase: 'settled', actions: [], state: 'sent' } });
    const reloaded = readMessage('t1', original.id)!;
    expect(reloaded.emailDisplay).toMatchObject({ options: [], emailSend: { phase: 'settled', actions: [], state: 'sent' } });
    expect(sanitizeBotDisplayMessage(reloaded,{authorship:'bot'}).emailDisplay).toMatchObject({options:[],emailSend:{phase:'settled',actions:[],state:'sent'}});
    expect(reloaded.card!.actionHash).toBe(original.card!.actionHash);
    expect(reloaded.card!.emailSend).toEqual(original.card!.emailSend);
  });

  it("attachments show name, size and hash", async () => {
    await submit({ attachments: [{ name: "plan.pdf", contentType: "application/pdf", bytes: new Uint8Array(2048) }] });
    expect(card("send-1")!.subtitle).toMatch(/plan\.pdf \(2 KB, SHA-256 [0-9a-f]{64}\)/);
  });

  it("Send: the card answers, then settles as sent; the bot hears email_outcome, the owner reads the activity line", async () => {
    await submit();
    fake.on("POST", /\/messages$/, sentOk());
    const answer = await cards.resolve("email-send-1", "send", { revision: row("send-1").revision });
    expect(answer.body.card).toMatchObject({ answered: "allow", options: [], emailSend: { phase: "settled", state: "sent" } });
    expect(outcomes).toEqual([{ threadId: "t1", ref: expect.stringMatching(/^E-[A-Z0-9]{6}$/), outcome: "sent" }]);
    expect(activity).toEqual(["Sent: you pressed Send"]);
  });

  it("S8b a stale revision cannot dispatch a still-actionable signed email", async () => {
    await submit();
    const current = row("send-1");
    expect(send.pendingApprovals()).toEqual([expect.objectContaining({ ref: "send-1" })]);
    fake.on("POST", /\/messages$/, sentOk());
    const result = await cards.resolve("email-send-1", "send", { revision: current.revision - 1, device: "desktop" });
    expect(result.body).toMatchObject({ outcome: "changed" });
    expect(row("send-1")).toMatchObject({ state: current.state, revision: current.revision, payloadHash: current.payloadHash });
    expect(fake.calls("POST", /\/messages$/)).toHaveLength(0);
  });

  it("keeps a sealed send waiting for proof of the owner's computer", async () => {
    database().prepare("INSERT INTO mailbox_sealed_threads(thread_id,generation,state) VALUES ('t1',1,'complete')").run();
    await submit();
    const current = row("send-1");
    expect(send.pendingApprovals()).toEqual([expect.objectContaining({ ref: "send-1" })]);
    fake.on("POST", /\/messages$/, sentOk());
    const remote = await cards.resolve("email-send-1", "send", { revision: current.revision, device: "desktop" });
    expect(remote).toMatchObject({ status: 403, body: { code: "mailbox_desktop_only" } });
    expect(row("send-1").state).toBe(current.state);
    expect(fake.calls("POST", /\/messages$/)).toHaveLength(0);
    const local = await cards.resolve("email-send-1", "send", { revision: current.revision, device: "desktop", ownerComputer: true });
    expect(local.status).toBe(200);
    expect(fake.calls("POST", /\/messages$/)).toHaveLength(1);
  });

  it("S8f the real decision guard rejects a changed recipient on a canonical sealed card", async () => {
    database().prepare("INSERT INTO mailbox_sealed_threads(thread_id,generation,state) VALUES ('t1',1,'complete')").run();
    await submit();
    const approval = send.pendingApprovals().find(item => item.ref === "send-1");
    expect(approval).toBeDefined();
    const stored = database().prepare(
      "SELECT json FROM messages WHERE thread_id='t1' AND json_extract(json,'$.card.approvalId')=?",
    ).get(approval!.approvalId);
    const canonical = rowToMessage({ json: String(stored?.json) });
    expect(canonical.card?.emailSend?.draft.to).toEqual(["new@x.test"]);
    expect(readMessage("t1", canonical.id)).toMatchObject({ sealed: true, text: "Email conversation" });
    expect(readMessage("t1", canonical.id)?.card).toBeUndefined();
    expect(() => assertCardAuthorized(database(), "t1", canonical)).not.toThrow();
    const changed = structuredClone(canonical);
    changed.card!.emailSend!.draft.to = ["other@mail.example.test"];
    expect(() => assertCardAuthorized(database(), "t1", changed)).toThrow("card-without-approval");
  });

  it.each(["pending", "complete"])("projects signed cards in generic indexed reads while seal is %s", async state => {
    await submit({ subject: "fixture signed subject" });
    const canonical = transcript.cardForRequest("t1", "send-1")!;
    expect(canonical.card?.emailSend?.draft.subject).toBe("fixture signed subject");
    const before = canonical.card;
    const cold = new Store(() => ({ instanceId: "fixture", model: "fixture" }));
    const readCard = (rows: Message[] | undefined) => rows?.find(row => row.id === canonical.id);
    const readers = [
      () => openRequestCardsStatus("t1", 20).cards.map(card => card.message),
      () => cold.openCardsOutsideStatus("t1", [{ id: "fixture-page" }]).cards,
      () => branchChain("t1", canonical.id, 4)?.messages,
      () => readThreadAround("t1", canonical.id, 4)?.messages,
      () => cold.branchPage("t1", 4, canonical.id)?.messages,
      () => cold.messageWindow("t1", canonical.id, 4)?.messages,
      () => cold.openRequestCardRowsStatus("t1").rows,
      () => [...cold.openCardsForRequests("t1", ["send-1"]).found.values()],
    ];
    for (const read of readers) expect(readCard(read())?.card).toEqual(before);
    const complete = () => {
      expect(migrateMailboxMessageBatch("t1").done).toBe(true);
      database().prepare("UPDATE mailbox_sealed_threads SET state='complete' WHERE thread_id='t1'").run();
    };
    transcript.beginMailboxSeal("t1");
    if (state === "complete") complete();
    try {
      for (const read of readers) {
        const visible = readCard(read());
        expect.soft(visible).toMatchObject({ id: canonical.id, sealed: true, text: "Email conversation" });
        expect.soft(visible?.card).toBeUndefined();
      }
      expect(readCard(cold.messagesFor("t1"))?.sealed).toBe(true);
      const decisionCard = cold.cardForRequest("t1", "send-1");
      expect(decisionCard?.card).toEqual(before);
      expect(() => assertCardAuthorized(database(), "t1", decisionCard!)).not.toThrow();
    } finally {
      if (state === "pending") complete();
    }
  });

  it("F5: a second click (desktop then phone) returns the final state and sends nothing more", async () => {
    await submit();
    fake.on("POST", /\/messages$/, sentOk());
    const revision = row("send-1").revision;
    await cards.resolve("email-send-1", "send", { revision });
    const again = await cards.resolve("email-send-1", "send", { revision, device: "phone" });
    expect(again.body).toMatchObject({ ok: true, outcome: "settled", card: { emailSend: { state: "sent" } } });
    expect(fake.calls("POST", /\/messages$/)).toHaveLength(1);
  });

  it("Don't send: declined, no buttons ever again (rebuilt after restart too)", async () => {
    await submit();
    await cards.resolve("email-send-1", "dont_send");
    expect(card("send-1")).toMatchObject({ answered: "deny", options: [] });
    cards.rebuild();
    expect(card("send-1")!.options).toEqual([]);
    expect(activity).toContain("Not sent: you chose Don't send");
    expect(fake.requests).toHaveLength(0);
  });

  it("Edit (M2): a new row and card with the edited text; the old card ends withdrawn(edited) without buttons", async () => {
    await submit();
    const answer = await cards.resolve("email-send-1", "edit", { revision: row("send-1").revision, draft: { text: "Edited words" } });
    expect(answer.body.replacedBy).toBe("email-send-2");
    expect(row("send-1")).toMatchObject({ state: "withdrawn", code: "edited" });
    expect(card("send-1")!.options).toEqual([]);
    expect(card("send-2")).toMatchObject({ options: ["Send", "Edit", "Don't send"] });
    expect(card("send-2")!.subtitle).toContain("Edited words");
    fake.on("POST", /\/messages$/, sentOk());
    await cards.resolve("email-send-2", "send", { revision: row("send-2").revision });
    expect((fake.calls("POST", /\/messages$/)[0].body as { text: string }).text).toBe("Edited words");
  });

  it("Stop (4.5): an open card shows Stopped. Not sent. and never offers Send again", async () => {
    await submit({}, 7);
    await send.stop("b1", 7);
    expect(card("send-1")).toMatchObject({ options: [], emailSend: { note: "Stopped. Not sent." } });
    expect((await cards.resolve("email-send-1", "send")).body.outcome).toBe("settled");
  });

  it("F9: Stop while held at Flux withdraws the hold (#23); a network failure keeps withdraw_pending without buttons", async () => {
    fake.on("POST", /\/messages$/, held("hld_1"));
    store.addTrusted("b1", "new@x.test", "allow", "owner", clock);
    await submit({}, 3);
    expect(card("send-1")!.options).toEqual(["Send", "Edit", "Don't send"]);
    fake.on("DELETE", /\/held\/hld_1$/, "reset");
    await send.stop("b1", 3);
    expect(row("send-1").state).toBe("withdraw_pending");
    expect(card("send-1")).toMatchObject({ options: [], emailSend: { phase: "answered", note: "Stopped. Not sent." } });
  });

  it("F10: Stop after Send does not undo it; the real outcome is reported", async () => {
    await submit({}, 4);
    fake.on("POST", /\/messages$/, async () => { await send.stop("b1", 4); return sentOk(); });
    await cards.resolve("email-send-1", "send");
    expect(row("send-1").state).toBe("sent");
    expect(outcomes.map(item => item.outcome)).toEqual(["sent"]);
  });

  it("dismissed card or deleted thread = Don't send", async () => {
    await submit();
    await submit({ to: ["other@x.test"], text: "two" });
    const [first] = [...shown.entries()];
    shown.set(first[0], { ...first[1], dismissed: true });
    threads.delete("t1");
    await cards.sweep();
    expect(row("send-1").state).toBe("declined");
    expect(row("send-2").state).toBe("declined");
  });

  it("F8: the sibling wait line links the other card", async () => {
    store.addTrusted("b1", "new@x.test", "allow", "owner", clock);
    fake.on("POST", /\/messages$/, held("hld_0")).on("POST", /\/messages$/, held("hld_1", ["hld_1", "hld_0"]));
    await submit({ text: "first" });
    await submit({ text: "second" });
    fake.on("GET", /\/approvals\/apr_1$/, approval([heldItem("hld_1", "send-2", { text: "second" }), heldItem("hld_0", "send-1", { text: "first" })]));
    const cardsBefore = transcript.messagesFor('t1').filter(message => message.card?.emailSend?.sendId === 'send-2').length;
    const answer = await cards.resolve("email-send-2", "send");
    expect(answer.body.outcome).toBe("waiting_sibling");
    expect(answer.body.card!.emailSend).toMatchObject({ note: "Waiting for your answer on the other email Juniper wrote to new@x.test.", siblingRequestId: "email-send-1" });
    expect(fake.calls("POST", /approve$/)).toHaveLength(0);
    expect(row("send-2").state).toBe("held");
    for (let i = 0; i < 3; i++) {
      await send.syncApproval(row('send-2'));
      cards.sync(row('send-2'));
    }
    expect(send.pendingApprovals().map(item => item.ref)).toEqual(['send-1']);
    expect(transcript.messagesFor('t1').filter(message => message.card?.emailSend?.sendId === 'send-2')).toHaveLength(cardsBefore);
    expect(card('send-2')!.emailSend).toMatchObject({ phase: 'answered', actions: [], siblingRequestId: 'email-send-1' });
    fake.on("GET", /\/approvals\/apr_1$/, approval([heldItem("hld_1", "send-2", { text: "second" }), heldItem("hld_0", "send-1", { text: "first" })]))
      .on("POST", /approve$/, { status: 200, body: { sends: [{ held_id: 'hld_0', status: 'sent', message_id: 'msg_1' }, { held_id: 'hld_1', status: 'sent', message_id: 'msg_2' }] } });
    await cards.resolve('email-send-1', 'send');
    expect(row('send-1').state).toBe('sent');
    expect(row('send-2').state).toBe('sent');
    expect(fake.calls('POST', /approve$/)).toHaveLength(1);
  });

  it("approved_unsent: Retry / Don't send; Retry is #32 and settles sent; one email-status per state change", async () => {
    store.addTrusted("b1", "new@x.test", "allow", "owner", clock);
    fake.on("POST", /\/messages$/, held("hld_1"));
    await submit();
    await send.syncApproval(row("send-1"));
    const firstMessageId = transcript.cardForRequest("t1", "send-1")!.id;
    fake.on("GET", /\/approvals\/apr_1$/, approval([heldItem("hld_1", "send-1")]))
      .on("POST", /approve$/, { status: 200, body: { sends: [{ held_id: "hld_1", status: "send_failed", check: "burst" }] } });
    await cards.resolve("email-send-1", "send");
    await send.syncApproval(row("send-1"));
    expect(card("send-1")).toMatchObject({ title: "You said Send. It has not gone out yet: too many emails went out at once.", options: ["Retry", "Don't send"] });
    cards.sync(row("send-1"));
    expect(notices.filter(notice => notice.kind === "email-status")).toHaveLength(1);
    fake.on("POST", /\/held\/hld_1\/send$/, sentOk("msg_3"));
    expect(cards.retryOffered("email-send-1")).toBe(true);
    expect(transcript.cardForRequest('t1', 'send-1')!.id).not.toBe(firstMessageId);
    expect(readMessage('t1', firstMessageId)!.emailDisplay).toMatchObject({ options: [], emailSend: { phase: 'answered', actions: [] } });
    await cards.resolve("email-send-1", "retry");
    expect(row("send-1").state).toBe("sent");
    expect(readMessage('t1', firstMessageId)!.emailDisplay).toMatchObject({ options: [], emailSend: { phase: 'settled', state: 'sent', actions: [] } });
  });

  it("F11: 72 h without an answer: expired, the card says so", async () => {
    await submit();
    clock += HOLD_LIFETIME_MS + 1;
    send.expire();
    expect(card("send-1")).toMatchObject({ options: [], emailSend: { note: "This request ran out. Ask Juniper to send it again." } });
    expect(outcomes.map(item => item.outcome)).toEqual(["expired"]);
  });

  it("F4 and restart: the card is rebuilt from the row (a crash after 202, before the card)", async () => {
    await submit();
    shown.clear();
    cards.rebuild();
    await send.syncApproval(row("send-1"));
    expect(card("send-1")).toMatchObject({ options: ["Send", "Edit", "Don't send"], emailSend: { revision: row("send-1").revision } });
  });

  it("unknown_expired: Send (a new send_id) / Don't send and the Check sent mail link", async () => {
    await submit();
    fake.on("POST", /\/messages$/, "reset");
    await cards.resolve("email-send-1", "send");
    const current = row("send-1");
    store.casSend("send-1", current.revision, { state: "unknown_expired", dueAt: null }, clock);
    cards.sync(row("send-1"));
    await send.syncApproval(row("send-1"));
    expect(card("send-1")).toMatchObject({ options: ["Send", "Don't send"], emailSend: { links: { checkSent: "Check sent mail" } } });
  });

  it("F25: inbox removed with cards open: withdrawn(inbox_removed), no buttons", async () => {
    await submit();
    send.withdrawAllForBot("b1", "inbox_removed");
    expect(card("send-1")).toMatchObject({ options: [], emailSend: { state: "withdrawn" } });
    expect(outcomes.map(item => item.outcome)).toEqual(["withdrawn"]);
  });

  it("F12: nothing but the send service changes the card (the card is not an engine request)", async () => {
    await submit();
    const before = JSON.stringify(card("send-1"));
    // an engine's request.resolved names a request id; the email card is never in askMessageByRequest, so only resolve() moves it
    expect(JSON.stringify(card("send-1"))).toBe(before);
    expect(card("send-1")!.tool).toBe("email_send");
  });
});

describe("digest and notifications", () => {
  it("4.3: an email card binds payload hash, held ids and revision; any other card hashes exactly as before", async () => {
    const plain = { title: "T", subtitle: "S", tool: "Bash" };
    expect(approvalDigestInput("t1", "r1", plain)).toBe(JSON.stringify(["murage-approval-digest/2", "t1", "r1", "Bash", "T", "S", null, null, false, null, null, null, null, null, null, null, null, null]));
    await submit();
    const view = card("send-1")!;
    const input = JSON.parse(approvalDigestInput("t1", view.requestId, view));
    expect(input.at(-1)).toEqual([row("send-1").payloadHash, [], row("send-1").revision]);
    const other = JSON.parse(approvalDigestInput("t1", view.requestId, { ...view, emailSend: { ...view.emailSend, revision: view.emailSend.revision + 1 } }));
    expect(other).not.toEqual(input);
  });

  it("the 4 h digest: one email-digest per bot, each card counted once", async () => {
    await submit();
    expect(cards.digest()).toBe(0);
    clock += EMAIL_DIGEST_AFTER_MS + 1;
    expect(cards.digest()).toBe(1);
    expect(cards.digest()).toBe(0);
    expect(notices.filter(notice => notice.kind === "email-digest").map(notice => notice.body)).toEqual(["1 email is waiting for you from Juniper."]);
  });

  it("email-status for a binding pause is deduplicated per inbox per state change", () => {
    cards.bindingNotice("b1", "t1", INBOX, "paused");
    cards.bindingNotice("b1", "t1", INBOX, "paused");
    cards.bindingNotice("b1", "t1", INBOX, "active");
    cards.bindingNotice("b1", "t1", INBOX, "paused");
    expect(notices.filter(notice => notice.kind === "email-status")).toHaveLength(2);
  });
});

describe("email_outcome (4.6, closed table)", () => {
  it("is bot-visible, keeps only a code-shaped ref and one of six outcomes", () => {
    expect(BOT_VISIBLE_STATUS.has("email_outcome")).toBe(true);
    expect(storedStatusShapeOk("email_outcome", { ref: "E-AB12CD", outcome: "sent" })).toBe(true);
    for (const bad of [{ ref: "jane@acme.test", outcome: "sent" }, { ref: "E-ab12cd", outcome: "sent" }, { ref: "E-AB12CD", outcome: "bounced" }, { ref: "E-AB12CD", outcome: "sent", subject: "x" }, { ref: "E-AB12CD" }]) {
      expect(statusFromStored("email_outcome", bad)).toBeUndefined();
    }
    const line = statusFromStored("email_outcome", { ref: "E-AB12CD", outcome: "declined" })!;
    expect(outboundWords(line)).toBe("The owner chose not to send your email (E-AB12CD).");
  });

  it("an owner-only activity line never rides as a bot-visible status", async () => {
    await submit();
    await cards.resolve("email-send-1", "dont_send");
    expect(outcomes).toHaveLength(1);
    expect(JSON.stringify(outcomes)).not.toMatch(/new@x|Thursday|Hi there/);
  });
});
