// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The page of a transcript a frame or a listing carries, in the shape the
// asking client takes (lane E, 1.0.2).
import type { IncomingHttpHeaders } from "node:http";

import { redactSecretsInText } from "./redact.ts";
import type { Message, Store } from "./store.ts";
import { CARDS_BESIDE_HEADER, CARDS_BESIDE_QUERY, CARDS_BESIDE_VALUE } from "./task-delta.ts";

/** PROVISIONAL INTERFACE: F6 freezes the function name but no metadata type.
 * This minimal authorship tag is supplied by the transcript reader, never by an HTTP body.
 * Only a stored, proved owner origin exempts text; a user role alone is not
 * owner authority. Bot senders and automation always use the display boundary. */
export type TrustedRowMetadata = Readonly<{ authorship: "owner" | "bot" | "unknown"; hostRequestId?: string; ownerOnly?: boolean }>;
const DISPLAY_MARKER = "«redacted»";
const DISPLAY_SCALARS = 256 * 1024;
const DISPLAY_NODES = 20_000;
const DISPLAY_WORK = 1_048_576;

/** One bounded standalone display unit. Call BEFORE shortening, flattening,
 * quoting or encoding. The input must be a host-built list of text fields,
 * not a provider's object. A hit/failure masks siblings atomically.
 * `ownerOnly` (boolean, or the option): the route proved the only reader is
 * the owner on his own surface (index.ts ownerOnlyTranscript). A stored
 * marker stays in its own field and masks nothing else. `markerStays`
 * (the store's write of a bot row): a fresh hit still masks siblings, a marker
 * already in a field does not. */
export function sanitizeDisplayTextUnit(texts: readonly string[], redact: (text: string) => string = redactSecretsInText, audience: boolean | { ownerOnly?: boolean; markerStays?: boolean } = false): string[] {
  const ownerOnly = audience === true || (typeof audience === "object" && audience.ownerOnly === true);
  const markerStays = typeof audience === "object" && audience.markerStays === true;
  let size = 0;
  for (const text of texts) {
    size += text.length;
    if (size > DISPLAY_SCALARS || texts.length > DISPLAY_NODES) return texts.map(text => text ? DISPLAY_MARKER : "");
  }
  try {
    const safe = texts.map(text => redact(text));
    // A fresh hit masks siblings for every audience, the owner included (the
    // tip's rule, transcript-page.test.ts "an old marker keeps its field...").
    // A persisted marker is only evidence about its own field on a private
    // owner read, and at the store's write (`markerStays`); every shared read
    // keeps siblings hidden.
    const masked = safe.some((text, i) => text !== texts[i] || (!ownerOnly && !markerStays && text.includes("«redacted")));
    return masked ? safe.map((text, i) => text !== texts[i] || text.length === 0 ? text : DISPLAY_MARKER) : safe;
  } catch { return texts.map(text => text ? DISPLAY_MARKER : ""); }
}

// Fixed schema keys only. Unknown subtrees are never enumerated, stringified
// or copied, even on exhaustion. This includes previews' arbitrary keys.
const ROOT_DISPLAY_KEYS = ("text removedText removedSpeaker tool card emailDisplay connector mcpSignIn secret routineRun goalRun from reactions comm routineRunPrompt engine servedModel turnHelpers attachments widget actionCheck murage botCall automation handoffOf postedFrom sharedFrom copyOf routineRunAgain delegationWait delegationHeld folderPrompt intake resendOf").split(" ");
const ROOT_CONTROL_KEYS = ("id at seq parentId insertedBefore replyToId role kind externalContent inboundKind turnId turnTerminal sendId channelMode responderBotId queued queueId origin postTo quoteMessageId roomShareId via steered steerUnconfirmed steerId setupEcho imagesNotSent artifactIds withheldFromBots actorKind requestId to workItemId murageLine handoffFrom memoryNote resendUsed dispatchedIn speechGenerationId provenance").split(" ");
const DISPLAY_KEYS = ("name title subtitle summary detail spoken text removedText label description question header options questions answers selected other tool wants held pushBody error errorDetails errorKind providerError providerSaid providerTeam engine connection preset kind httpStatus localFailure localFailureEngine diagnostic imageRecord prompt doneWhen steps action ok notice setup authRequired claudeUpdate unrecorded stepCount busy reason resetsAt id handle requestHandle questionHandle optionHandles requestId status scope slug alias resumeKey failure authorizedAt dismissed resumed target placeholder helpUrl requestKey provided host bot botId origin phone body routineId runId routineName executionThreadId nextStep moreFiles goal goalStatus coordinatorBotId coordinatorName turnCount maxTurns startedAt finishedAt turnId sendId answered expired sentAsMessage answerAsSend fenceOf messageId index orphaned unattended multiSelect allowOther secret approvalScope cardClass lowRisk toolInputTruncated browserCardKind folderTrust folder sources v2 late grantRequest rows arguments subject operation operations changes routine webhook create update remove limitOffer outsideEngine why key params routineRequest undone routineProposalDigest skillRequest gist source warnings sha256 writer holdId stateRevision bodyHash ref restored publish emailSend emailTrustOffer mcpEnable browserSetup intake setup content preview caption alt mime path png color emoji by groupId withBotId withName withColor routed requested instanceId model capabilityHash toolCount durationMs at started ended state outcome tier minutes intentId version rev root children props type value values confirm cancel actionType settled fallback sourceId threadId messageIds trigger channel connectionId webhookId memberIds taskId projectId url href urlLabel enabled checked disabled required choices mode style size weight align icon data columns series x y progress total completed count severity digestDay desk result deliveryId met").split(" ");
// Scope facts and keys are host-built card display data. They are scanned with
// every sibling field; execution always resolves the original stored card.
DISPLAY_KEYS.push(..."allowKey allowKeys exactAllowKey taskAllowKey routineAllowKey routineOffer cardClass keys stop public placed places unattended automated n2 initiator".split(" "));
// Additional declared fields of the durable setup, intake, widget, publish,
// email and routine cards. Unknown extension keys still have no exit.
DISPLAY_KEYS.push(..."Badge Box Button Caption Card Chart Checkbox Col DatePicker DayPicker Divider Form Icon Image Input Label ListView ListViewItem Markdown Progress RadioGroup Row Select Spacer Table TableRow Text Textarea TimePicker Title Transition accept account accountOff accountOffAction accountOffConfirm accountOffLine accountOn accountOnLine accountRef accountSends accountSentToday accountState actionFailed actionKeys actionPayloadBytes actions activity activityEmpty activityTitle add addCredit added address always anchorAt antecedent app appliedAt approvedUnsent args ask asked auto autoApprove billingUrl blocked botName browser bytes candidate cause cc change chartRows chartSeries checkSent checking checkingNote chip claims class client closingLine code command computerOnly connect consentOffline continueRequested createdAt dataKey deadKey decision declined default delegate delete deployId depth destinations diagnosticId displayName displayNameLabel domainAllowNotAvailable draft driver driverKind durationMinutes edited eligible email_off end entry envHeld eventTypes everyMinutes expectedUpdatedAt failed fieldValue fields fileCount files filtered findings first firstMark flex fluxBudget fluxKeyRefused fluxOff fluxSignIn forBot frame from full fullAccess gap give graceLine heldIds hint holdLine http_status images importOffer inboxId instance instructions invalidAddress invalidEntry invalidUsername justify keepAddress keyLine keyRejected level limits line links listItems manage markdown message method min minSize mon neverEmail neverEmailHint noLimits node nodes none notAvailable notNow notRemembered notYet not_eligible note observedKind offeredAt otherSetupRemoveConfirm otherSetups otherSetupsTitle outage owner ownerKeyLine ownerMessageId ownerOnly ownerSignIn ownerSignedIn panelLine participle past pauseConfirm pauseReason pauseSending paused pausedLine pay payloadHash pendingEnv pendingHeaders pendingKeys perDay phase pieceId plan policy policyPending position priceNote processGeneration profileId profileReviewHash prose provider provisioning readAt reasonLine reasons recipient reconnect ref refreshed refused rejected remembered removeConfirm removing removingLine resent resolution resource restoredWaiting resultId resume resumeNote resumeNoteNeeded retry revision row rowId rpcCode rpcId rule run runOn save schedule sectionTitle send sending sent sentToday server sibling siblingRequestId signIn signInAction siteId siteName skillNames skipped sourceLabel spacing spam span src stagedId stale staleNote start step stopHit stopKeys stopped supportPausedLine surface tableCols tableRows terminalKind termsVersion thread_id time timeoutMinutes to today tone totalBytes transport trusted trustedTitle turnOn unknownExpired usernameHint usernameLabel variant verdictSource waiting watch weekdays what width withdrawn wrap".split(" "));
// Only these exact paths carry identities created by the host. Familiar
// provider field names (id, handle, turnId) are ordinary scanned text.
const HOST_CONTROL_PATHS = new Set("routineRun.runId routineRun.routineId routineRun.executionThreadId goalRun.runId goalRun.coordinatorBotId from.botId from.groupId connector.slug connector.resumeKey mcpSignIn.resumeKey mcpSignIn.botId secret.target secret.requestKey".split(" "));
const HOST_ENGINE_PATHS = new Set(["engine.instanceId", "engine.driverKind", "engine.connectionId", "engine.capabilityHash"]);
const HOST_ROOT_IDS = new Set("id parentId insertedBefore replyToId sendId responderBotId queueId quoteMessageId roomShareId steerId artifactIds withheldFromBots workItemId handoffFrom dispatchedIn speechGenerationId".split(" "));

const CONTROL_VALUES = new Set(("text options activity screen connector mcpSignIn secret routine.run goal.run image user bot owner person murage routine desktop companion unproven queued running waiting needs-you completed failed cancelled missed working needs-input blocked limit-reached paused stopped required authorizing connected signed-in timed-out denied ready pending in_progress done started local-computer finished timeout read write exec shell network search file folder browser tool-reported tool owner-statement assistant hypothesis allow deny answer skip Allow Deny Allow once Not now").split(" "));
const PERMISSION_LABELS = new Set(["Allow", "Allow once", "Deny", "Always allow", "Allow for this task", "Always allow for this routine", "Not now"]);
const ownValue = (value: object, key: string): unknown => {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch { return undefined; }
};

/** Authorship of an authoritative stored row, shared by transcript and
 * sidebar exits. Do not call this on provider events or request bodies. */
export function storedRowDisplayMetadata(row: unknown): TrustedRowMetadata {
  const role = row && typeof row === "object" ? ownValue(row, "role") : undefined;
  const origin = row && typeof row === "object" ? ownValue(row, "origin") : undefined;
  const via = row && typeof row === "object" ? ownValue(row, "via") : undefined;
  // The phone writers stamp these third-party rows as unproven. They use
  // the normal non-owner display scan, never the owner's text exemption.
  const phoneLine = role === "user" && origin === "unproven" && (via === "share" || via === "ask-intent");
  const generated = phoneLine || row && typeof row === "object" && (ownValue(row, "from") || ownValue(row, "routineRunPrompt"));
  const knownOwner = role === "user" && !generated && (origin === "desktop" || origin === "companion");
  return { authorship: knownOwner ? "owner" : role === "bot" || role === "user" && generated ? "bot" : "unknown" };
}

/** Reconstruct only bounded action metadata, even when display text has
 * exhausted its budget. Original request and option values stay private. */
function historicalCardControls(row: object): Record<string, unknown> | undefined {
  const card = ownValue(row, "card"), id = ownValue(row, "id");
  if (!card || typeof card !== "object" || typeof id !== "string" || id.length > 1024) return undefined;
  const questions = ownValue(card, "questions");
  const length = Array.isArray(questions) ? ownValue(questions, "length") : undefined;
  if (!Array.isArray(questions) && typeof ownValue(card, "requestId") !== "string" && typeof ownValue(card, "requestHandle") !== "string") return undefined;
  const out: Record<string, unknown> = { requestHandle: `${Array.isArray(questions) ? "q" : "p"}.${id}` };
  for (const key of ["dismissed", "expired", "sentAsMessage", "answerAsSend", "orphaned", "unattended"]) {
    const value = ownValue(card, key); if (typeof value === "boolean") out[key] = value;
  }
  const answered = ownValue(card, "answered");
  if (typeof answered === "string") out.answered = answered ? DISPLAY_MARKER : "";
  if (Array.isArray(questions) && typeof length === "number" && length <= 4) {
    out.questions = Array.from({ length }, (_, q) => {
      const question = ownValue(questions, String(q));
      const record: Record<string, unknown> = { id: `q.${q}`, handle: `q.${q}`, questionHandle: `q.${q}`, question: DISPLAY_MARKER, options: [] };
      if (!question || typeof question !== "object") return record;
      for (const key of ["multiSelect", "allowOther", "secret"]) { const value = ownValue(question, key); if (typeof value === "boolean") record[key] = value; }
      const options = ownValue(question, "options"), count = options && typeof options === "object" ? ownValue(options, "length") : undefined;
      if (Array.isArray(options) && typeof count === "number" && count <= 10) record.options = Array.from({ length: count }, (_, o) => ({ handle: `o.${q}.${o}`, label: `Option ${o + 1}` }));
      return record;
    });
    out.options = [];
  } else {
    const options = ownValue(card, "options"), count = options && typeof options === "object" ? ownValue(options, "length") : undefined;
    out.options = [];
    if (Array.isArray(options) && typeof count === "number" && count <= 20) for (let i = 0; i < count; i++) {
      const option = ownValue(options, String(i));
      if (typeof option === "string" && PERMISSION_LABELS.has(option)) (out.options as string[]).push(option);
    }
  }
  return out;
}

/** Copy-only historical exit. Raw approval/question records remain in the
 * store for execution; this function never patches them or returns a raw
 * unknown subtree. Host IDs/paging metadata are outside the text unit. */
export function sanitizeBotDisplayMessage(row: unknown, trustedRowMetadata: TrustedRowMetadata): Record<string, unknown> {
  if (!row || typeof row !== "object") return { role: "bot", kind: "activity", text: DISPLAY_MARKER };
  if (trustedRowMetadata.authorship === "owner") return row as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  let units = 0, nodes = 0, scalars = 0, rootExceeded = false;
  const slots: Array<{ target: Record<string, unknown> | unknown[]; key: string | number; text: string }> = [];
  const widgetFieldNames = new Set<string>();
  const charge = (size = 1) => { units += size; if (units > DISPLAY_WORK) throw new Error("display budget"); };
  const primitive = (value: unknown): boolean => value === null || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value);
  const hostValue = (value: unknown): unknown => {
    if (primitive(value)) return value;
    if (typeof value === "string" && value.length <= 1024) return value;
    if (Array.isArray(value)) {
      const length = ownValue(value, "length");
      if (typeof length !== "number" || length > 256) return undefined;
      const copy: string[] = [];
      for (let i = 0; i < length; i++) {
        const item = ownValue(value, String(i));
        if (typeof item !== "string" || item.length > 1024) return undefined;
        copy.push(item);
      }
      return copy;
    }
    return undefined;
  };
  // These properties come from the authoritative stored row, not provider
  // payloads. They are the only fields restored after a budget failure.
  for (const key of ROOT_CONTROL_KEYS) {
    const value = hostValue(ownValue(row, key));
    if (Array.isArray(value) && !["artifactIds", "withheldFromBots", "to"].includes(key)) continue;
    const cost = typeof value === "string" ? value.length : Array.isArray(value) ? value.reduce((sum, item) => sum + String(item).length, 0) : 1;
    units += cost; scalars += cost;
    if (scalars > DISPLAY_SCALARS) { rootExceeded = true; break; }
    if (value !== undefined) out[key] = value;
  }
  if (trustedRowMetadata.authorship === "unknown") return { id: out.id, at: out.at, seq: out.seq, parentId: out.parentId, insertedBefore: out.insertedBefore, replyToId: out.replyToId, role: "bot", kind: "activity", text: DISPLAY_MARKER };
  for (const [key, value] of Object.entries(out)) {
    if (typeof value === "string" && !HOST_ROOT_IDS.has(key) && !CONTROL_VALUES.has(value)) slots.push({ target: out, key, text: value });
  }
  const project = (value: unknown, target: Record<string, unknown> | unknown[], key: string | number, path: string, depth: number): void => {
    charge();
    if (++nodes > DISPLAY_NODES) throw new Error("display node budget");
    if (depth > 40) throw new Error("display depth");
    if (typeof value === "string") {
      scalars += value.length;
      charge(value.length);
      if (scalars > DISPLAY_SCALARS) throw new Error("display scalar budget");
      (target as Record<string | number, unknown>)[key] = value;
      const field = String(key);
      // A validated host stamp names the engine even when the row text is withheld.
      const isEngineIdentity = HOST_ENGINE_PATHS.has(path) && value.length <= 1024 &&
        !value.includes("«redacted") && redactSecretsInText(value) === value;
      const isControl = isEngineIdentity || HOST_CONTROL_PATHS.has(path) && value.length <= 1024;
      const isEnum = ["kind", "status", "type", "state", "reason", "role", "origin", "verification", "reportedOutcome", "approvalScope"].includes(field) && CONTROL_VALUES.has(value);
      const isPermissionLabel = path.startsWith("card.options.") && PERMISSION_LABELS.has(value);
      if (!isControl && !isEnum && !isPermissionLabel) slots.push({ target, key, text: value });
      return;
    }
    if (primitive(value)) { (target as Record<string | number, unknown>)[key] = value; return; }
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      const length = ownValue(value, "length");
      if (typeof length !== "number" || length > DISPLAY_NODES) throw new Error("display array budget");
      const copy: unknown[] = [];
      (target as Record<string | number, unknown>)[key] = copy;
      for (let i = 0; i < length; i++) project(ownValue(value, String(i)), copy, i, `${path}.${i}`, depth + 1);
      return;
    }
    const copy: Record<string, unknown> = {};
    (target as Record<string | number, unknown>)[key] = copy;
    // Widget answers are keyed by the fields declared in this stored tree.
    // Copy only those scalar answers, through the same bounded display scan.
    // An undeclared key or arbitrary subtree still has no display exit.
    if (path === "widget.settled.values" || path === "widget.settled.other") {
      for (const field of widgetFieldNames) {
        const descriptor = Object.getOwnPropertyDescriptor(value, field);
        if (descriptor && !("value" in descriptor)) throw new Error("display accessor");
        if (descriptor && (typeof descriptor.value === "string" || typeof descriptor.value === "boolean"))
          project(descriptor.value, copy, field, `${path}.${field}`, depth + 1);
      }
      return;
    }
    if (path.startsWith("widget.root")) {
      const name = ownValue(value, "name"), type = ownValue(value, "type");
      if (typeof name === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(name)
        && !name.split(".").some(part => ["__proto__", "prototype", "constructor"].includes(part))
        && typeof type === "string" && ["Select", "DatePicker", "TimePicker", "DayPicker", "Checkbox", "RadioGroup", "Input", "Textarea", "ListView"].includes(type)) {
        widgetFieldNames.add(name);
        if (widgetFieldNames.size > 20) throw new Error("display widget field budget");
      }
    }
    for (const field of DISPLAY_KEYS) {
      charge();
      // Original provider request/answer ids and grant keys are execution
      // only. The display handles below do not contain those bytes.
      if (field === "requestId" || path === "card" && field === "answers") continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, field);
      if (descriptor && !("value" in descriptor)) throw new Error("display accessor");
      if (descriptor) project(descriptor.value, copy, field, `${path}.${field}`, depth + 1);
    }
  };
  try {
    if (rootExceeded) throw new Error("display metadata budget");
    for (const key of ROOT_DISPLAY_KEYS) {
      const descriptor = Object.getOwnPropertyDescriptor(row, key);
      if (descriptor && !("value" in descriptor)) throw new Error("display accessor");
      if (descriptor) project(descriptor.value, out, key, key, 0);
    }
    // G2 owns the limit application receipt. Expose only its option position
    // and flags; principal, approval identity and failover identity stay private.
    const application = ownValue(row, 'limitApplication'), storedLimitCard = ownValue(row, 'card');
    if (application && typeof application === 'object' && storedLimitCard && typeof storedLimitCard === 'object'
      && ownValue(storedLimitCard, 'tool') === 'murage_limit_offer'
      && typeof ownValue(application, 'approvalId') === 'string'
      && ownValue(application, 'approvalId') === ownValue(storedLimitCard, 'approvalId')) {
      const answer = ownValue(application, 'answer'), options = ownValue(storedLimitCard, 'options');
      const choice = answer && typeof answer === 'object' ? ownValue(answer, 'choice') : undefined;
      const label = choice && typeof choice === 'object' ? ownValue(choice, 'label') : undefined;
      const optionCount = Array.isArray(options) ? ownValue(options, 'length') : undefined;
      if (answer && typeof answer === 'object' && ownValue(answer, 'kind') === 'engine'
        && typeof ownValue(answer, 'nextTime') === 'boolean' && typeof ownValue(answer, 'routines') === 'boolean'
        && typeof label === 'string' && Array.isArray(options) && typeof optionCount === 'number' && optionCount <= 256) {
        let optionIndex = -1;
        for (let i = 0; i < optionCount; i++) if (ownValue(options, String(i)) === label) { optionIndex = i; break; }
        if (optionIndex >= 0) out.limitApplication = { optionIndex, nextTime: ownValue(answer, 'nextTime'), routines: ownValue(answer, 'routines') };
      }
    }
    const safe = sanitizeDisplayTextUnit(slots.map(slot => slot.text), redactSecretsInText, trustedRowMetadata.ownerOnly);
    for (let i = 0; i < slots.length; i++) (slots[i].target as Record<string | number, unknown>)[slots[i].key] = safe[i];
    const masked = safe.some((text, i) => text !== slots[i].text || text.includes("«redacted"));
    if (!masked && ownValue(row, "kind") === "screen") {
      // Raster bytes are a separate existing image boundary, not free text.
      for (const key of ["png", "mime"]) { const value = ownValue(row, key); if (typeof value === "string") out[key] = value; }
    }
    if (masked) { delete out.attachments; delete out.widget; }
    const card = out.card as Record<string, unknown> | undefined;
    if (card && typeof out.id === "string") {
      // PROVISIONAL INTERFACE: F8 has no concrete export on the frozen base.
      // R1/R2's deterministic historical handles are derived here solely
      // from the authoritative message and array positions; 1B resolves them.
      const storedOwn = ownValue(row, "card");
      if (storedOwn && typeof storedOwn === "object" && ownValue(storedOwn, "kind") === "own-write") {
        card.kind = "own-write"; card.requestId = ownValue(storedOwn, "requestId");
        const writer = ownValue(storedOwn, "writer");
        if (writer && typeof writer === "object" && card.writer && typeof card.writer === "object") for (const field of ["version", "holdId", "stateRevision", "state", "tool", "bodyHash", "ref", "restored"]) { const value = ownValue(writer, field); if (value !== undefined) (card.writer as Record<string, unknown>)[field] = value; }
        return out;
      }
      const questions = card.questions as Array<Record<string, unknown>> | undefined;
      const storedCard = ownValue(row, "card");
      if (storedCard && typeof storedCard === "object" && (questions || typeof ownValue(storedCard, "requestId") === "string" || typeof ownValue(storedCard, "requestHandle") === "string")) {
        // Reconstruct on every pass, including replay of an already safe
        // projection. A masked description must not erase its action handle.
        card.requestHandle = `${questions ? "q" : "p"}.${out.id}`;
      }
      questions?.forEach((question, q) => {
        question.id = `q.${q}`; question.handle = `q.${q}`; question.questionHandle = `q.${q}`;
        (question.options as Array<Record<string, unknown>> | undefined)?.forEach((option, o) => {
          delete option.id; option.handle = `o.${q}.${o}`;
          if (masked) option.label = `Option ${o + 1}`;
        });
      });
    }
    if (trustedRowMetadata.hostRequestId && out.card && typeof out.card === 'object') {
      (out.card as Record<string, unknown>).requestId = trustedRowMetadata.hostRequestId;
      delete (out.card as Record<string, unknown>).requestHandle;
    }
    return out;
  } catch {
    // No rescanning, stringify, exception detail or input logging on failure.
    const skeleton: Record<string, unknown> = { role: "bot", kind: "activity", text: DISPLAY_MARKER };
    for (const key of ["id", "at", "seq", "parentId", "insertedBefore", "replyToId"]) if (out[key] !== undefined) skeleton[key] = out[key];
    const controls = historicalCardControls(row);
    if (controls) { skeleton.kind = "options"; skeleton.card = { title: DISPLAY_MARKER, subtitle: DISPLAY_MARKER, ...controls }; }
    return skeleton;
  }
}

/** A screen message without its pixels. The client fetches those from
 * `/api/threads/:threadId/messages/:id/image` when it actually shows one.
 * Not exported: every row leaves through wireThread. */
function slimMessage(message: Message): Message | Record<string, unknown> {
  if (message.kind !== "screen" || !message.png) return message;
  const { png: _png, mime: _mime, ...rest } = message;
  return { ...rest, hasImage: true };
}

/** How much of a bot's description the roster carries (code points): what the sidebar, the chat intro (180) and the library's detail line
 * show. A bot whose description is longer is marked `descriptionCut`, and the settings panel reads the whole text from GET /api/bots/:id
 * before it can be edited. The owner's 43 descriptions were 41 KB of the boot page; the cut copies are 7 KB. Rows are never cut: the roster
 * carries a sidebar line instead of rows (shared/sidebar-line.ts), and every page of rows is whole. */
export const ROSTER_DESCRIPTION_CHARS = 240;

/** What the delivery gate asks of the store: one probe, the newest number, one row's number. */
export type SeqStore = Pick<Store, "threadNumbered" | "newestSeq" | "messageSeq"> & Partial<Pick<Store, "displayHostRequestId">>;
export type TranscriptStore = Pick<Store, "messagePage" | "newestPageSpan" | "branchHeadSpan" | "branchPage" | "openCardsOutside"> & Partial<Pick<Store, "openCardsOutsideStatus">> & SeqStore;

type Row = Message | Record<string, unknown>;
type Gated<B> = Omit<B, "newestSeq"> & { newestSeq?: number };

/** THE one exit for a thread's rows (ROOM-ORDER-DESIGN r8 R8): a page, a window, a delta, a frame, a POST answer. Takes the body that
 * carries the rows (`message`, `messages`, `openCards`, anything else passed through), probes `numbered(threadId)` ONCE, maps every row
 * (through slimMessage unless `slim: false`, the shape frames and answers always had) and then:
 * - a pending (not yet numbered) thread, or `legacy` (a branch page, in parent-link order): `seq` is removed from every row and the
 *   envelope carries no `newestSeq`;
 * - a numbered thread: every row carries `seq` (a missing stamp is read from the column) and the envelope carries
 *   `newestSeq` = the server's MAX(seq) now (0 for an empty thread).
 * The rows and the cache are never changed: the gate shapes copies. Read, probed and gated in one synchronous step, so no delivery
 * straddles the walk's flip of the thread. */
/** The reader-side metadata of one stored row. `ownerOnly` is the route's
 * proof (index.ts ownerOnlyTranscript), never a request field. */
export function storedRowReadMetadata(row: unknown, ownerOnly: boolean | undefined, hostRequestId?: string): TrustedRowMetadata {
  const base = storedRowDisplayMetadata(row);
  return { ...base, ...(ownerOnly === true && base.authorship === "unknown" && ownerOwnUnstampedRow(row) ? { authorship: "bot" as const } : {}), hostRequestId, ownerOnly };
}
/** On the owner's own read a user row that carries no origin at all (a call
 * note, a steer recovered after a restart, history from before origins) is
 * shown as the owner's line through the normal display scan (no owner text
 * exemption without a proven origin), never as a bare «redacted» activity row.
 * A row with any origin, a phone share/ask line, a sender or a routine prompt
 * keeps its stored standing. */
function ownerOwnUnstampedRow(row: unknown): boolean {
  if (!row || typeof row !== "object") return false;
  const origin = ownValue(row, "origin");
  return ownValue(row, "role") === "user" && (origin === undefined || origin === null) && ownValue(row, "via") === undefined
    && !ownValue(row, "from") && !ownValue(row, "routineRunPrompt");
}

export function wireThread<B extends { message?: unknown; messages?: readonly unknown[]; openCards?: readonly unknown[] }>(store: SeqStore, threadId: string, body: B, options: { slim?: boolean; legacy?: boolean; ownerOnly?: boolean } = {}): Gated<B> {
  const numbered = !options.legacy && store.threadNumbered(threadId);
  const slim = options.slim !== false;
  const wire = (row: unknown): unknown => {
    const safe = sanitizeBotDisplayMessage(row, storedRowReadMetadata(row, options.ownerOnly, store.displayHostRequestId?.(threadId, row)));
    const shaped = (slim ? slimMessage(safe as unknown as Message) : safe) as Row;
    const { seq, ...rest } = shaped as Record<string, unknown>;
    if (!numbered) return rest;
    const number = typeof seq === "number" ? seq : typeof rest.id === "string" ? store.messageSeq(threadId, rest.id) : null;
    return number === null ? rest : { ...rest, seq: number };
  };
  const { newestSeq: _stale, ...out } = body as B & { newestSeq?: unknown };
  const gated = out as Record<string, unknown>;
  if (body.message !== undefined) gated.message = wire(body.message);
  if (Array.isArray(body.messages)) gated.messages = body.messages.map(wire);
  if (Array.isArray(body.openCards)) gated.openCards = body.openCards.map(wire);
  if (numbered) gated.newestSeq = store.newestSeq(threadId) ?? 0;
  return gated as Gated<B>;
}

/** Whether a request or stream takes open request cards beside its page
 * (`openCards`, `olderFrom`). The 1.0.2 renderer says so (header on every call,
 * query on the event stream), the way it asks for task deltas; an older
 * renderer, the phone and the companion say nothing and are sent the page they
 * always were, with every open card inside it. */
export function takesCardsBeside(headers: IncomingHttpHeaders, query: URLSearchParams): boolean {
  return headers[CARDS_BESIDE_HEADER] === CARDS_BESIDE_VALUE || query.get(CARDS_BESIDE_QUERY) === CARDS_BESIDE_VALUE;
}

/** The page a client opens a thread on. A client that takes cards beside its
 * page gets at least `limit` of the newest rows, reaching back far enough to
 * hold the active branch head (up to BRANCH_HEAD_PAGE_CAP rows); a head further
 * back than that (another fork grew past it) gets the head's own branch, read by
 * parent links (Store.branchPage): the client renders the SELECTED branch from
 * what it holds, never the newest fork's rows in its place. Open request cards
 * older than the page travel beside it, so one old unanswered card never
 * inflates a switch. Any other client gets the page it always got: at least
 * `limit` rows and, within BRANCH_HEAD_PAGE_CAP, every open card and the branch head inside them. Zero stays
 * zero: that caller asked for settings, not a transcript. Either way a page
 * is at most max(limit, BRANCH_HEAD_PAGE_CAP) rows. */
export function transcriptPage(store: TranscriptStore, threadId: string, limit: number, beside: boolean): { messages: Message[]; hasMore: boolean; activeLeafId: string | null; olderFrom?: string | null; branch?: true } {
  // Every client's page stops at BRANCH_HEAD_PAGE_CAP rows past `limit`: one stale open card (or a head) 10,000 rows back must not make a phone page
  // 10,000 rows. A card or head older than that is reached by paging back (`before`), which is how a client without cards-beside already scrolls.
  if (!beside) return store.messagePage(threadId, limit > 0 ? Math.max(limit, Math.min(store.newestPageSpan(threadId), BRANCH_HEAD_PAGE_CAP)) : limit)!;
  const span = limit > 0 ? store.branchHeadSpan(threadId) : 0;
  // a branch page is in parent-link order, not number order: it goes out legacy (wirePage)
  return span > BRANCH_HEAD_PAGE_CAP ? { ...store.branchPage(threadId, limit)!, branch: true } : store.messagePage(threadId, Math.max(limit, span))!;
}

/** The farthest a newest page stretches back for the branch head. */
const BRANCH_HEAD_PAGE_CAP = 500;

/** The rows of a page as sent, with the cards beside it and the cursor to page
 * back by when the page is a branch page. */
export function wirePage(store: TranscriptStore, threadId: string, page: ReturnType<typeof transcriptPage>, beside: boolean, bound = false, ownerOnly = false) {
  return wireThread(store, threadId, {
    messages: page.messages as Message[],
    ...(beside ? pageOpenCards(store, threadId, page.messages) : {}),
    // The branch head the cards were worked out for: a conversation that
    // branches binds them to it (a room does not branch).
    ...(beside && bound && page.activeLeafId ? { openCardsLeaf: page.activeLeafId } : {}),
    ...(beside && page.olderFrom ? { olderFrom: page.olderFrom } : {}),
    hasMore: page.hasMore,
  }, { legacy: page.branch, ownerOnly });
}

/** `openCards` for a frame, left out when the page already holds every open card. */
function pageOpenCards(store: TranscriptStore, threadId: string, page: readonly { id?: unknown }[]): { openCards?: Message[]; openCardsPending?: true } {
  const { cards, pending } = store.openCardsOutsideStatus ? store.openCardsOutsideStatus(threadId, page) : { cards: store.openCardsOutside(threadId, page), pending: false };
  // `openCardsPending`: the upgrade has not indexed this thread yet, so older open cards may be missing; a client keeps the cards it holds and asks again when told.
  return { ...(cards.length ? { openCards: cards } : {}), ...(pending ? { openCardsPending: true as const } : {}) };
}

