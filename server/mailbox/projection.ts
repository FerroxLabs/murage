import type { FrameSubject } from "../sse-visibility.ts";
import type { Message, Store } from "../store.ts";

export const MAILBOX_PLACEHOLDER = "Email conversation";
const actors = new Set(["owner", "person", "bot", "murage", "routine"]);

export function project(message: Message): Message {
  const { id, at, role, kind, seq, actorKind, parentId, insertedBefore, replyToId, turnId, sendId } = message;
  return {
    id, at, role, kind, sealed: true, text: MAILBOX_PLACEHOLDER,
    ...(typeof seq === "number" ? { seq } : {}),
    ...(actorKind && actors.has(actorKind) ? { actorKind } : {}),
    ...(parentId === null || typeof parentId === "string" ? { parentId } : {}),
    ...(typeof insertedBefore === "string" ? { insertedBefore } : {}),
    ...(typeof replyToId === "string" ? { replyToId } : {}),
    ...(typeof turnId === "string" ? { turnId } : {}),
    ...(typeof sendId === "string" ? { sendId } : {}),
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function ids(value: Record<string, unknown>, fields: readonly string[]): Record<string, string> {
  return Object.fromEntries(fields.flatMap(field => typeof value[field] === "string" ? [[field, value[field]]] : []));
}

const kinds = new Set(["text", "options", "activity", "screen", "connector", "mcpSignIn", "secret", "routine.run", "goal.run"]);
function frameMessage(value: unknown): Message | undefined {
  const message = record(value);
  if (!message || typeof message.id !== "string" || typeof message.at !== "number"
    || (message.role !== "user" && message.role !== "bot") || typeof message.kind !== "string" || !kinds.has(message.kind)) return;
  return project(message as unknown as Message);
}

function framePage(value: Record<string, unknown>): Record<string, unknown> {
  const page: Record<string, unknown> = ids(value, ["id", "threadId", "activeLeafId", "olderFrom"]);
  if (Array.isArray(value.messages)) page.messages = value.messages.map(frameMessage).filter(message => message !== undefined);
  if (Array.isArray(value.openCards)) page.openCards = [];
  if (typeof value.hasMore === "boolean") page.hasMore = value.hasMore;
  const message = frameMessage(value.message);
  if (message) page.message = message;
  return page;
}

export function projectFrame(payload: Record<string, unknown>): Record<string, unknown> {
  const frame = {
    ...ids(payload, ["kind", "threadId", "botId", "groupId", "requestId"]),
    ...framePage(payload),
    ...(typeof payload.seq === "number" ? { seq: payload.seq } : {}),
    sealed: true,
  } as Record<string, unknown>;
  for (const field of ["bot", "group", "threadDelta", "event", "notification"]) {
    const child = record(payload[field]);
    if (child) frame[field] = {
      ...framePage(child), ...ids(child, ["botId", "groupId", "turnId"]),
      title: MAILBOX_PLACEHOLDER,
    };
  }
  return frame;
}

export function sealedFrameSubject(store: Pick<Store, "isMailboxSealed" | "bot" | "group">, subject: FrameSubject): boolean {
  if (subject.scope === "thread") return store.isMailboxSealed(subject.threadId);
  if (subject.scope !== "bot" && subject.scope !== "group") return false;
  const owner = subject.scope === "bot" ? store.bot(subject.botId) : store.group(subject.groupId);
  // A serialized transcript may still be in replay after its roster entry has been deleted.
  return !owner || store.isMailboxSealed(owner.threadId) || !!owner.tasks?.some(task => store.isMailboxSealed(task.threadId));
}

export function mailboxFrameThread(payload: Record<string, unknown>): string | undefined {
  const threadId = payload.threadId ?? record(payload.bot)?.threadId ?? record(payload.group)?.threadId ?? record(payload.threadDelta)?.threadId;
  return typeof threadId === "string" ? threadId : undefined;
}
