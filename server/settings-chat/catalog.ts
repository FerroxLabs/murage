// M6 catalog (owner: M6 lane). designs/settings-chat-1023/DESIGN.md section 3.
// One chat class per (inventory id, writer target): inline / open / no. Fail closed: a missing record, writer, journal row,
// atomicity pass or page control makes an id `open`, never `inline`; no F1 home makes it `no`.
import type { ChatClass, WriterTarget } from "../../shared/settings-chat.ts";
import { CHAT_CARD_WRITER } from "../../shared/settings-chat.ts";

/** F1 inventory / X2 registry record for one control (owner: shell F1, devices X2). */
export interface InventoryRecord {
  id: string;
  label: string;
  /** "Settings > Bots > Dax > Model" style path. */
  path: string;
  scope: "chat" | "bot" | "every-bot" | "app";
  /** X2: how the Settings control writes. Only `immediate` can be inline (condition 2). */
  interaction?: "immediate" | "form" | "confirm";
  retired?: boolean;
  /** The page is hidden on this build by a surface gate. */
  hidden?: boolean;
}

export type WriterTargetKind = WriterTarget["kind"];
/** Writer surface rule the handler applies itself (routeAdmits cannot see it), e.g. the task writer's desktop-only settings 404. */
export type SurfaceRule = "any" | "desktop";

/** One writer for one target of an id (condition 3): route, method, body builder and in-handler surface rule. */
export interface WriterEntry {
  target: WriterTargetKind;
  method: "PATCH" | "POST" | "PUT";
  /** Path template: `:botId` and `:taskId` are filled from the card, never from a body. */
  path: string;
  /** Builds the writer body the Settings page would send for this value. */
  body: (value: unknown) => Record<string, unknown>;
  /** The body field the writer compares `expect` against (SV0). */
  field: string;
  surface: SurfaceRule;
  /** Exported page control the card reuses (one renderer per control). */
  chatControl?: string;
}

export interface CatalogDeclaration {
  id: string;
  writers: WriterEntry[];
  /** Access, level or lifecycle control (condition 6). */
  lifecycle?: boolean;
  secret?: boolean;
  /** Private value (condition 7): account email, paths, host names, phone numbers, contacts, allowed senders. */
  private?: boolean;
  /** X1 purchase action (condition 4). */
  purchase?: boolean;
}

export interface CatalogInputs {
  inventory: readonly InventoryRecord[];
  declarations: readonly CatalogDeclaration[];
  /** Store build: purchase actions are not created, drawn or indexed (X1). */
  storeBuild: boolean;
  /** J0 writer table has the `chat-card` row (core J0). */
  journalWriters: ReadonlySet<string>;
  /** Writer keys `${id}|${target}` whose W4b atomicity gate passed on this branch. */
  atomic: ReadonlySet<string>;
  /** Page controls exported for chat (`ChatControl` names). */
  chatControls: ReadonlySet<string>;
  /** Writer routes that exist on this branch, `${method} ${path}`. */
  routes: ReadonlySet<string>;
  /** Writer routes that compare `expect` (SV0, core) on this branch, `${method} ${path}` (condition 1). */
  expectRoutes: ReadonlySet<string>;
}

export interface CatalogEntry {
  id: string;
  target: WriterTargetKind;
  class: ChatClass;
  /** Every failed condition, in order. Empty for inline. */
  reasons: string[];
  label?: string;
  path?: string;
  scope?: InventoryRecord["scope"];
}

export const writerKey = (id: string, target: WriterTargetKind): string => `${id}|${target}`;

/** The chat class of one (id, writer target) (design section 3, Fable M1: per writer target). */
export function chatClass(id: string, target: WriterTargetKind, inputs: CatalogInputs): CatalogEntry {
  const record = inputs.inventory.find(row => row.id === id);
  const declaration = inputs.declarations.find(row => row.id === id);
  if (!record || record.retired) return { id, target, class: "no", reasons: [record ? "retired" : "no Settings home"] };
  const base = { id, target, label: record.label, path: record.path, scope: record.scope };
  if (record.hidden) return { ...base, class: "no", reasons: ["hidden on this build"] };
  if (declaration?.purchase && inputs.storeBuild) return { ...base, class: "no", reasons: ["purchase in a Store build"] };
  const reasons: string[] = [];
  const writer = declaration?.writers.find(row => row.target === target);
  if (!declaration) reasons.push("no class entry");
  if (!writer) reasons.push("no writer for this target");
  if (writer && !inputs.expectRoutes.has(`${writer.method} ${writer.path}`)) reasons.push("1: writer takes no expect");
  if (record.interaction !== "immediate") reasons.push("2: Settings control is not immediate");
  if (writer && !inputs.routes.has(`${writer.method} ${writer.path}`)) reasons.push("3: writer route missing on this branch");
  if (declaration?.purchase) reasons.push("4: purchase action");
  if (declaration?.secret) reasons.push("5: secret");
  if (declaration?.lifecycle) reasons.push("6: access, level or lifecycle");
  if (declaration?.private) reasons.push("7: private value");
  if (!inputs.journalWriters.has(CHAT_CARD_WRITER)) reasons.push("J0 has no chat-card writer row");
  if (!inputs.atomic.has(writerKey(id, target))) reasons.push("W4b atomicity not proven for this writer");
  if (!writer?.chatControl || !inputs.chatControls.has(writer.chatControl)) reasons.push("page exports no ChatControl");
  return { ...base, class: reasons.length ? "open" : "inline", reasons };
}

/** Every (id, target) the inventory and declarations name. Undeclared inventory ids read `open` with target `app`. */
export function buildCatalog(inputs: CatalogInputs): CatalogEntry[] {
  const out: CatalogEntry[] = [];
  for (const record of inputs.inventory) {
    const declaration = inputs.declarations.find(row => row.id === record.id);
    const targets = declaration?.writers.length ? declaration.writers.map(row => row.target) : ["app" as const];
    for (const target of targets) out.push(chatClass(record.id, target, inputs));
  }
  return out.sort((a, b) => a.id.localeCompare(b.id) || a.target.localeCompare(b.target));
}

/** The writer for a card's target, or undefined (the caller treats that as `open`). */
export function writerFor(id: string, target: WriterTargetKind, inputs: Pick<CatalogInputs, "declarations">): WriterEntry | undefined {
  return inputs.declarations.find(row => row.id === id)?.writers.find(row => row.target === target);
}

const modelBody = (value: unknown) => ({ modelSelection: value });

/** The shipped declarations (design section 3, starting inline list). Language and web search are candidates only:
 * they stay undeclared (so `open`) until their v10 routes and W9 pass on the integration branch. */
export const DECLARATIONS: readonly CatalogDeclaration[] = [
  {
    id: "bot.model",
    writers: [
      // A thread of a bot with at most one task. "Dax's model". The bot's direct thread of a multi-task bot never uses it (Opus r2 H1).
      { target: "bot", method: "PATCH", path: "/api/bots/:botId", body: modelBody, field: "modelSelection", surface: "any", chatControl: "BotModelChatControl" },
      // A task thread of a bot with more than one task. "This chat's model". Desktop-only in its handler (index.ts task writer 404).
      { target: "task", method: "PATCH", path: "/api/bots/:botId/tasks/:taskId", body: modelBody, field: "modelSelection", surface: "desktop", chatControl: "BotModelChatControl" },
    ],
  },
];

/** Sample concrete paths for checking that a writer route exists on this branch (route-policy has an entry for it). */
const SAMPLE = { botId: "bot-sample", taskId: "task-sample" };

/** The shipped inputs. Every producer M6 consumes is read from its owner's artifact and is empty when that artifact is absent
 * on the branch, so the class falls back to `open` / `no` (fail closed; design section 6, finish dependency):
 * F1 inventory `shared/settings-controls.generated.json` (shell F1), J0 writer table (core J0), SV0 expect routes (core SV0),
 * W4b atomicity passes (recorded per writer by the integration branch), page ChatControls (each page owner). */
export function shippedCatalogInputs(producers: {
  inventory?: readonly InventoryRecord[];
  journalWriters?: Iterable<string>;
  expectRoutes?: Iterable<string>;
  atomic?: Iterable<string>;
  chatControls?: Iterable<string>;
  storeBuild?: boolean;
  routeExists: (method: string, path: string) => boolean;
}): CatalogInputs {
  const routes = new Set<string>();
  for (const declaration of DECLARATIONS) for (const writer of declaration.writers) {
    const sample = writer.path.replace(":botId", SAMPLE.botId).replace(":taskId", SAMPLE.taskId);
    if (producers.routeExists(writer.method, sample)) routes.add(`${writer.method} ${writer.path}`);
  }
  return {
    inventory: producers.inventory ?? [],
    declarations: DECLARATIONS,
    storeBuild: producers.storeBuild ?? false,
    journalWriters: new Set(producers.journalWriters ?? []),
    atomic: new Set(producers.atomic ?? []),
    chatControls: new Set(producers.chatControls ?? []),
    routes,
    expectRoutes: new Set(producers.expectRoutes ?? []),
  };
}
