// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The level classifier for Murage for Chrome (spec 2.1, 2.2, 2.6, 2.7).
//
// `classifyLevel(input)` is a pure function. Given the operation, the facts the
// executor collected for the effect target, the hard-floor result, the site
// category, the bot's approval mode, the routine flag and the task grants, it
// answers two things: which level the action is (L1 free, L2 once per task per
// site, L3 always ask, or floor) and whether a card must be shown.
//
// Rules, in the order they decide:
//   1. Floor. A floor result (from the caller or from the facts) wins over every
//      other input and never produces a card: the caller hands off to the owner.
//      No mode, category, grant, routine flag, intent or checker value reaches it.
//   2. Level from the effect of the action on its resolved target. An effect
//      that cannot be determined is L3.
//   3. Card from the mode table (2.2), the site category (2.3), the grants (2.4)
//      and the routine rules (2.6).
//   4. The intent check and the action checker can only tighten: a card never
//      becomes no card.
//
// Anything unexpected is strict: an unknown mode is "step", an unknown category is
// "askEveryStep", a missing or broken input is floor.
//
// One canonical action. The operation and the key are normalised once and the same
// values feed both the floor recheck and the level, so a key spelled "space",
// "Return" or "NumpadEnter" cannot slip past the floor while the level reads it as
// Space or Enter. A disagreement between `input.operation` / `input.key` and
// `facts.operation` / `facts.key` is floor (unsure). For a press whose key the
// floor does not know by its DOM name, the floor is given no key, so it checks the
// target as both typing and activation.

import { classifyFloor, foldFloorText } from "./browser-floor.ts";
import type { FloorFacts, FloorResult } from "./browser-floor.ts";
import { DESTRUCTIVE_PATTERNS, PAY_CONTROL, compilePhrases } from "./browser-floor-lexicon.ts";
import type { PhraseTable } from "./browser-floor-lexicon.ts";

export type BrowserLevel = "L1" | "L2" | "L3" | "floor";
export type ApprovalMode = "step" | "task" | "full";
// The one SiteCategory union, from the site categories module (T11). Re-exported for callers of this module.
import type { SiteCategory } from "../shared/browser-site-categories.ts";
export type { SiteCategory };

/** What the executor adds to the floor facts for level decisions. */
export interface LevelFacts extends FloorFacts {
  /** The origin of the page the target lives on, for the cross-origin form check. */
  pageOrigin?: string;
  /** The target is contenteditable. */
  contentEditable?: boolean;
  /** The target is a code editor (CodeMirror, Monaco, Ace and the like) that handles Tab. */
  codeEditor?: boolean;
  /** The target is a link or control that downloads a file. */
  download?: boolean;
  /** Leaving this page would trigger a beforeunload prompt because typed data would be lost. */
  discardsTypedData?: boolean;
  /** A navigation whose URL carries data from the page or the conversation to another place. */
  navigationCarriesNovelData?: boolean;
  /** For a click on a label: the control the label activates, already resolved by the collector. */
  labelControl?: Partial<LevelFacts>;
}

// Collector and executor (T20) duties, from the Opus gate:
// - navigate, open, tab_new and popup_adopt are L1 only when `navigationCarriesNovelData === false`
//   is set explicitly. Missing means unknown, which is L3.
// - beforeunload accept is L2 only when `discardsTypedData === false` is set explicitly.
// - type, fill, paste, insert_text and the other entry operations must set `textHasNewline: true`
//   on the input when the text holds "\n" or "\r"; the action then follows the Enter rule.
// - A label click needs `labelControl`; the floor is checked on the label and on its control.

export interface LevelInput {
  operation: string;
  key?: string;
  facts: LevelFacts;
  /** The floor result for these facts, or null when the floor found nothing. */
  floor: FloorResult | null;
  category: SiteCategory;
  mode: ApprovalMode;
  routine: boolean;
  grants: { l1: boolean; l2: boolean };
  siteAllowedAlways: boolean;
  intent?: "pass" | "card" | "refuse";
  checker?: "allow" | "ask" | "block";
  /**
   * For entry operations: the text to type holds a line break ("\n" or "\r"). A line break in a
   * field acts as Enter, so the action follows the Enter rule. The executor sets it from the tool text.
   */
  textHasNewline?: boolean;
}

export interface LevelResult {
  level: BrowserLevel;
  needsCard: boolean;
  reason: string;
  /** Stable rule id, for tests and the activity log. */
  rule: string;
  /**
   * Routine runs only: the site is not Allow always, so the action is not done and the bot is told to
   * tell the owner and continue without it. `needsCard` is also true so a caller that ignores this flag
   * fails closed to a card.
   */
  skip?: boolean;
  /**
   * The action is refused: the site is handover only or Never, the intent check refused it, or the
   * action checker blocked it. `needsCard` is also true so a caller that ignores this flag fails
   * closed to a card. Checked before any mode rule.
   */
  refuse?: true;
  /**
   * The site is not yet allowed for this task (no L1 grant, not Allow always): the card to show is the
   * site card (spec 2.2 "New site", 2.3), not an action card. `needsCard` is true.
   */
  siteCard?: true;
}

// ---------------------------------------------------------------------------
// Lexicon for L3 by name (send, post, delete, buy and the other irreversible steps).
// The pay and Foundry destructive tables come from T02's lexicon; this adds the
// verbs that are L3 but not floor.
// ---------------------------------------------------------------------------

const L3_ACTION: PhraseTable = {
  en: [
    "send", "send message", "send email", "post", "post comment", "publish", "reply", "reply all", "comment", "share", "invite", "tweet", "submit", "forward",
    "delete", "remove", "erase", "discard", "unsubscribe", "cancel subscription", "cancel membership", "cancel plan", "close account", "deactivate", "revoke",
    "make public", "grant access", "change permissions", "change password", "update permissions",
    "add to cart", "add to basket", "add to bag", "checkout", "proceed to checkout", "buy", "order", "purchase", "place bid", "bid now",
    "download",
  ],
  es: ["enviar", "enviar mensaje", "publicar", "responder", "comentar", "compartir", "invitar", "eliminar", "borrar", "quitar", "cancelar suscripcion", "darse de baja", "cerrar cuenta", "añadir al carrito", "agregar al carrito", "comprar", "pedir", "descargar", "revocar"],
  fr: ["envoyer", "publier", "répondre", "commenter", "partager", "inviter", "supprimer", "effacer", "retirer", "annuler l'abonnement", "se désabonner", "fermer le compte", "ajouter au panier", "acheter", "commander", "télécharger", "révoquer"],
  de: ["senden", "absenden", "veröffentlichen", "antworten", "kommentieren", "teilen", "einladen", "löschen", "entfernen", "abonnement kündigen", "kündigen", "konto schließen", "in den warenkorb", "kaufen", "bestellen", "herunterladen", "widerrufen"],
  pt: ["enviar", "publicar", "responder", "comentar", "compartilhar", "convidar", "excluir", "apagar", "remover", "cancelar assinatura", "encerrar conta", "adicionar ao carrinho", "comprar", "pedir", "baixar", "revogar"],
  ja: ["送信", "投稿", "公開", "返信", "コメント", "共有", "招待", "削除", "取り消し", "解約", "退会", "カートに入れる", "購入", "注文", "ダウンロード"],
  zh: ["发送", "發送", "发布", "發佈", "发表", "回复", "回覆", "评论", "評論", "分享", "邀请", "邀請", "删除", "刪除", "移除", "取消订阅", "取消訂閱", "注销", "加入购物车", "加入購物車", "购买", "購買", "下单", "下載", "下载"],
  hi: ["भेजें", "पोस्ट करें", "प्रकाशित करें", "जवाब दें", "टिप्पणी करें", "साझा करें", "आमंत्रित करें", "हटाएं", "मिटाएं", "सदस्यता रद्द करें", "खाता बंद करें", "कार्ट में जोड़ें", "खरीदें", "ऑर्डर करें", "डाउनलोड करें"],
};

const M = {
  l3: compilePhrases(L3_ACTION),
  pay: compilePhrases(PAY_CONTROL),
};

// D1: deletion always needs the owner's confirmation, whatever the mode, grant or checker.
// New-recipient sends are decided by the recipient facts (C1 wires them); a generic "Send"
// word must not card an approved conversation. Account/security changes are floor above this.
const ALWAYS_ASK_ACTION: PhraseTable = {
  en: ["delete", "remove", "erase"],
  es: ["eliminar", "borrar", "quitar"],
  fr: ["supprimer", "effacer", "retirer"],
  de: ["löschen", "entfernen"],
  pt: ["excluir", "apagar", "remover"],
  ja: ["削除", "消去"],
  zh: ["删除", "刪除", "移除"],
  hi: ["हटाएं", "मिटाएं"],
};
const alwaysAsk = compilePhrases(ALWAYS_ASK_ACTION);

function nameNeedsConfirmation(raw: string): boolean {
  const folded = foldFloorText(raw);
  // Keep the compact delete/remove spellings already recognised by the
  // destructive matcher from falling through to Full's generic L3 allowance.
  return alwaysAsk.test(folded) || /delete|remove/iu.test(folded);
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

const L1_OPERATIONS = new Set([
  "snapshot", "read", "screenshot", "status", "tab_list", "tabs", "list_tabs", "scroll", "scroll_into_view", "scroll_to", "hover", "focus", "mouse_move",
  "wait", "back", "forward", "reload", "tab_switch", "tab_new", "tab_close", "close", "find", "describe", "console", "network",
  "read_page", "get_page_text", "pause", "resume", "stop", "detach",
]);
/**
 * Read tools by explicit name (spec 2.1 get_*, is_*, wait_*). A prefix rule would make any future
 * get_/is_/wait_ tool free, including ones that run page script (wait_for_function) or read cookies.
 */
const READ_TOOLS = new Set([
  "get_text", "get_page_text", "get_url", "get_title", "get_attr", "get_value", "get_html", "get_count", "get_box", "get_styles", "get_accessibility_tree",
  "is_visible", "is_enabled", "is_checked",
  "wait_for", "wait_for_text", "wait_for_selector", "wait_for_url", "wait_for_load", "wait_for_navigation", "wait_ms",
]);
/** Navigation: L1 unless it carries novel data or would discard typed data. */
const NAVIGATION_OPERATIONS = new Set(["navigate", "open", "back", "forward", "reload", "tab_new", "tab_close", "close", "popup_adopt"]);
/** Navigation to a URL: L1 only when the URL is known to carry no novel data. */
const URL_NAVIGATIONS = new Set(["navigate", "open", "tab_new", "popup_adopt"]);
const LEAVES_PAGE = new Set(["navigate", "open", "back", "forward", "reload", "tab_close", "close"]);
const ENTRY_OPERATIONS = new Set(["type", "fill", "select", "paste", "insert_text", "keyboard_type", "keyboard_insert", "form_input", "set_value"]);
const CHECK_OPERATIONS = new Set(["check", "uncheck", "toggle"]);
const CLICK_OPERATIONS = new Set(["click", "dblclick", "double_click", "right_click", "tap", "activate", "keyboard_activate"]);
const PRESS_OPERATIONS = new Set(["press", "keyboard_press", "key"]);
const UPLOAD_OPERATIONS = new Set(["upload", "file_upload"]);

const lower = (value: unknown): string => (typeof value === "string" ? value.toLowerCase() : "");

function isL1Operation(opName: string): boolean {
  return L1_OPERATIONS.has(opName) || READ_TOOLS.has(opName);
}

// ---------------------------------------------------------------------------
// Keys (L7)
// ---------------------------------------------------------------------------

interface ParsedKey {
  /** Canonical lower-case base: "enter", "space", "tab", "escape", "arrowup", "pageup", or the single character. */
  base: string;
  shift: boolean;
  /** Any modifier other than Shift, known or not (Control, Meta, Alt, ControlOrMeta, Mod, ⌘, Win, Hyper, ...). */
  otherMods: boolean;
  /** The key as the floor knows it ("Enter", " ", "Tab", "Escape", a single character), or undefined so the floor checks everything. */
  floorKey: string | undefined;
}

const KEY_ALIASES: Record<string, string> = {
  enter: "enter", return: "enter", numpadenter: "enter",
  space: "space", spacebar: "space",
  esc: "escape", escape: "escape",
  up: "arrowup", down: "arrowdown", left: "arrowleft", right: "arrowright",
  pgup: "pageup", pgdn: "pagedown", del: "delete",
};

function parseKey(raw: string | undefined): ParsedKey | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  let baseRaw: string;
  let modParts: string[];
  if (raw === "+") {
    baseRaw = "+";
    modParts = [];
  } else if (raw.endsWith("++")) {
    baseRaw = "+";
    modParts = raw.slice(0, -2).split("+");
  } else {
    const parts = raw.split("+");
    baseRaw = parts.pop() ?? "";
    modParts = parts;
  }
  const mods = modParts.map(part => part.trim().toLowerCase());
  const shift = mods.includes("shift");
  // An empty part ("Control++a") or any modifier that is not Shift counts as a shortcut modifier.
  const otherMods = mods.some(mod => mod !== "shift");
  let base: string;
  if (/^(?:\r\n|\r|\n)$/.test(baseRaw)) {
    // Key layouts map a line break to Enter.
    base = "enter";
  } else if (baseRaw === " ") {
    base = "space";
  } else if (baseRaw.length > 0 && baseRaw.trim() === "") {
    // Any other whitespace or control character: an unknown key, never a free Space.
    base = "unknown-whitespace";
  } else {
    const trimmed = baseRaw.trim();
    if ([...trimmed].length === 1) {
      base = trimmed.toLowerCase();
    } else {
      const norm = trimmed.toLowerCase().replace(/[\s_-]+/g, "");
      base = KEY_ALIASES[norm] ?? norm;
    }
  }
  if (!base) return null;

  let floorKey: string | undefined;
  if (!otherMods && !shift) {
    if (base === "enter") floorKey = "Enter";
    else if (base === "space") floorKey = " ";
    else if (base === "tab") floorKey = "Tab";
    else if (base === "escape") floorKey = "Escape";
    else if ([...base].length === 1) floorKey = baseRaw.trim();
  } else if (!otherMods && shift && base === "tab") {
    floorKey = "Tab";
  }
  return { base, shift, otherMods, floorKey };
}

const TEXT_INPUT_TYPES = new Set(["", "text", "search", "email", "url", "tel", "number", "password", "date", "datetime-local", "month", "time", "week"]);
const PAGING_KEYS = new Set(["home", "end", "pageup", "pagedown"]);
const ARROW_KEYS = new Set(["arrowup", "arrowdown", "arrowleft", "arrowright", "up", "down", "left", "right"]);
const PAGING_ROLES = new Set(["listbox", "option", "combobox", "grid", "treegrid", "menu", "menubar", "menuitem", "menuitemradio", "menuitemcheckbox", "tree", "treeitem"]);
const STATEFUL_ARROW_ROLES = new Set(["radio", "slider", "spinbutton", "switch", "scrollbar", "listbox", "combobox"]);
/** Input types whose value the arrow keys step. */
const STATEFUL_ARROW_INPUTS = new Set(["radio", "range", "number", "date", "time", "datetime-local", "month", "week"]);

function tagOf(facts: LevelFacts): string { return lower(facts.tag); }
function roleOf(facts: LevelFacts): string { return lower(facts.role); }
function typeOf(facts: LevelFacts): string { return lower(facts.type); }

function isTextEntry(facts: LevelFacts): boolean {
  const tag = tagOf(facts);
  const role = roleOf(facts);
  if (tag === "textarea" || facts.contentEditable === true || facts.codeEditor === true) return true;
  if (tag === "input") return TEXT_INPUT_TYPES.has(typeOf(facts));
  return role === "textbox" || role === "searchbox" || role === "combobox" || role === "code";
}

/** A control the Tab key is handled by (inserts a tab or indents) instead of moving focus. */
function tabIsHandled(facts: LevelFacts): boolean {
  const tag = tagOf(facts);
  const role = roleOf(facts);
  if (tag === "textarea" || facts.contentEditable === true || facts.codeEditor === true || role === "code") return true;
  if (role === "textbox" && tag !== "input") return true;
  return false;
}

function isSelectLike(facts: LevelFacts): boolean { return tagOf(facts) === "select"; }

/** A field where Enter is typed into text: an Enter here may send (chat boxes, comment fields). */
function isTypingField(facts: LevelFacts): boolean {
  const tag = tagOf(facts);
  const role = roleOf(facts);
  if (tag === "textarea" || facts.contentEditable === true || facts.codeEditor === true) return true;
  if (tag === "input") return TEXT_INPUT_TYPES.has(typeOf(facts));
  return role === "textbox" || role === "searchbox";
}

function isLinkLike(facts: LevelFacts): boolean {
  const tag = tagOf(facts);
  return tag === "a" || tag === "area" || roleOf(facts) === "link";
}

// ---------------------------------------------------------------------------
// Names and effects
// ---------------------------------------------------------------------------

function nameTexts(facts: LevelFacts): string[] {
  return [facts.name, facts.text, facts.buttonValue, facts.title, facts.ariaLabel, facts.alt]
    .filter((item): item is string => typeof item === "string" && item.length > 0)
    .map(item => item.slice(0, 500));
}

function namesSayL3(facts: LevelFacts): boolean {
  const texts = nameTexts(facts);
  for (const raw of texts) {
    const folded = foldFloorText(raw);
    if (M.l3.test(folded) || M.pay.test(folded)) return true;
    if (DESTRUCTIVE_PATTERNS.some(pattern => pattern.test(raw))) return true;
  }
  return false;
}

function isSubmitControl(facts: LevelFacts): boolean {
  if (facts.submits === true) return true;
  if (facts.submits === false) return false;
  const tag = tagOf(facts);
  const type = typeOf(facts);
  if ((tag === "button" || tag === "input") && (type === "submit" || type === "image")) return true;
  // A button with no type inside a form is a submit button by default.
  if (tag === "button" && type === "" && facts.form) return true;
  return false;
}

function formLeavesOrWrites(facts: LevelFacts): boolean {
  const form = facts.form;
  if (!form) return false;
  if (lower(form.method) === "post") return true;
  const action = (form.action ?? "").trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(action) || action.startsWith("//")) {
    if (!facts.pageOrigin) return true;
    try {
      return new URL(action, facts.pageOrigin).origin !== new URL(facts.pageOrigin).origin;
    } catch {
      return true;
    }
  }
  return false;
}

/** A label click is its control: the control's facts over the label's, keeping the canonical operation and key. */
function mergeLabel(facts: LevelFacts): LevelFacts {
  const control = facts.labelControl;
  if (tagOf(facts) !== "label" || !control || typeof control !== "object") return facts;
  return {
    ...facts,
    ...control,
    labelControl: undefined,
    operation: facts.operation,
    key: facts.key,
    name: control.name ?? facts.name,
    tag: control.tag,
    type: control.type,
    role: control.role,
  };
}

interface Decision { level: Exclude<BrowserLevel, "floor">; reason: string; rule: string; alwaysAsk?: true }
const d = (level: Decision["level"], rule: string, reason: string): Decision => ({ level, rule, reason });

interface Action {
  /** Lower-case operation. */
  operation: string;
  /** The key as given, already checked to agree between input and facts. */
  rawKey: string | undefined;
  key: ParsedKey | null;
}

function needsOwnerConfirmation(action: Action, facts: LevelFacts, decision: Decision, textHasNewline: boolean): boolean {
  if (decision.level === "L1") return false;
  const op = action.operation;
  if (op.startsWith("dialog")) {
    if (op.includes("dismiss") || op.includes("cancel") || ["alert", "beforeunload"].includes(lower(facts.dialog?.kind))) return false;
    return nameNeedsConfirmation((facts.dialog?.text ?? "").slice(0, 1000));
  }
  if (ENTRY_OPERATIONS.has(op) && !textHasNewline && facts.submits !== true) return false;
  if (PRESS_OPERATIONS.has(op) && action.key && !action.key.otherMods) {
    if (!["enter", "space"].includes(action.key.base)) return false;
    if (isTypingField(facts) && facts.submits === false) return false;
  }
  return nameTexts(facts).some(nameNeedsConfirmation);
}

function levelFromEffect(action: Action, facts: LevelFacts, textHasNewline: boolean): Decision {
  const opName = action.operation;

  if (isL1Operation(opName) && !NAVIGATION_OPERATIONS.has(opName)) return d("L1", "l1-read", "Looking around changes nothing.");

  if (NAVIGATION_OPERATIONS.has(opName)) {
    if (facts.navigationCarriesNovelData === true) return d("L3", "navigation-novel-data", "The address carries data to another place.");
    if (facts.discardsTypedData === true && LEAVES_PAGE.has(opName)) return d("L3", "beforeunload-typed-data", "Leaving would discard what was typed on this page.");
    if (URL_NAVIGATIONS.has(opName) && facts.navigationCarriesNovelData !== false) {
      return d("L3", "navigation-novel-unknown", "It is not known whether the address carries data to another place.");
    }
    return d("L1", "l1-navigation", "Moving between pages the bot may use changes nothing.");
  }

  if (facts.factsFailed) return d("L3", "facts-failed", "The page could not be read well enough to tell what this does.");

  if (opName.startsWith("dialog")) {
    const kind = lower(facts.dialog?.kind);
    if (opName.includes("dismiss") || opName.includes("cancel")) return d("L2", "dialog-dismiss", "Declining a dialog.");
    if (kind === "alert") return d("L2", "dialog-alert", "Accepting an alert only acknowledges it.");
    if (kind === "beforeunload") {
      return facts.discardsTypedData === false
        ? d("L2", "dialog-beforeunload", "Leaving a page with nothing typed.")
        : d("L3", "beforeunload-typed-data", "Leaving may discard what was typed on this page.");
    }
    if (kind === "confirm" || kind === "prompt") return d("L3", "dialog-confirm", "Accepting a confirm or prompt answers for the owner.");
    return d("L3", "dialog-unknown", "The dialog could not be identified.");
  }

  if (UPLOAD_OPERATIONS.has(opName)) return d("L3", "upload", "Uploading a file sends it to the site.");

  // A form submit, by whatever route, is L3.
  if (isSubmitControl(facts) && (CLICK_OPERATIONS.has(opName) || PRESS_OPERATIONS.has(opName) || ENTRY_OPERATIONS.has(opName) || CHECK_OPERATIONS.has(opName))) {
    return d("L3", "submit", formLeavesOrWrites(facts) ? "This submits a form that writes or goes to another site." : "This submits a form.");
  }
  if (facts.submits === true) return d("L3", "submit", "This submits a form.");

  if (ENTRY_OPERATIONS.has(opName)) {
    if (!facts.tag && !facts.role) return d("L3", "unknown-target", "The field could not be identified.");
    if (textHasNewline) {
      const enter = classifyEnter(facts);
      if (enter.level === "L3") return d("L3", `entry-newline-${enter.rule}`, `The text holds a line break, which acts as Enter. ${enter.reason}`);
    }
    return d("L2", "entry", "Typing or choosing in a field.");
  }

  if (CHECK_OPERATIONS.has(opName)) {
    if (!facts.tag && !facts.role) return d("L3", "unknown-target", "The control could not be identified.");
    if (namesSayL3(facts)) return d("L3", "l3-name", "The control's name says it sends, deletes or buys.");
    return d("L2", "check", "Ticking or unticking a control.");
  }

  if (CLICK_OPERATIONS.has(opName)) return classifyClick(facts);

  if (PRESS_OPERATIONS.has(opName)) return classifyPress(action.key, facts);

  return d("L3", "unknown-operation", "The effect of this action is not known.");
}

/** Activation effects that make any click, Enter or Space L3 whatever the control's name. */
function activationEffect(facts: LevelFacts): Decision | null {
  if (facts.navigationCarriesNovelData === true) return d("L3", "navigation-novel-data", "Following this carries data to another place.");
  if (facts.download === true) return d("L3", "download", "Downloading a file.");
  if (facts.discardsTypedData === true && isLinkLike(facts)) return d("L3", "beforeunload-typed-data", "Following this link would discard what was typed on this page.");
  return null;
}

function classifyClick(facts: LevelFacts): Decision {
  if (tagOf(facts) === "label") return d("L3", "label-unresolved", "The label's control could not be found.");
  if (!facts.tag && !facts.role) return d("L3", "unknown-target", "The control could not be identified.");
  if (typeOf(facts) === "file") return d("L3", "file-picker", "Choosing a file sends it to the site.");
  const effect = activationEffect(facts);
  if (effect) return effect;
  if (namesSayL3(facts)) return d("L3", "l3-name", "The control's name says it sends, deletes, buys or downloads.");
  return d("L2", "click", "Clicking a control.");
}

/** What Enter does on the focused element (also used for a line break in typed text). */
function classifyEnter(facts: LevelFacts): Decision {
  const tag = tagOf(facts);
  if (facts.submits === true) return d("L3", "key-enter-submit", "Enter submits this form.");
  const effect = activationEffect(facts);
  if (effect) return effect;
  if (!facts.tag && !facts.role) return d("L3", "unknown-target", "The focused element could not be identified.");
  if (isTypingField(facts)) {
    if (facts.submits === false) return d("L2", "key-enter", "Enter in a field whose Enter does not submit.");
    if (facts.form) return d("L3", "key-enter-submit-unknown", "Enter may submit this form and the page could not say.");
    return d("L3", "key-enter-formless", "Enter in a field with no form can still send, and the page could not say it does not.");
  }
  if (facts.submits === undefined && facts.form && (isTextEntry(facts) || tag === "input")) {
    return d("L3", "key-enter-submit-unknown", "Enter may submit this form and the page could not say.");
  }
  if (isSubmitControl(facts)) return d("L3", "key-enter-submit", "Enter activates a submit button.");
  if (namesSayL3(facts) && !isTextEntry(facts)) return d("L3", "l3-name", "Enter activates a control that sends, deletes or buys.");
  return d("L2", "key-enter", "Enter on a control that does not submit.");
}

function classifyPress(key: ParsedKey | null, facts: LevelFacts): Decision {
  if (!key) return d("L3", "key-unknown", "The key is not known.");
  const tag = tagOf(facts);
  const role = roleOf(facts);

  // Shortcuts with any modifier but Shift can do anything the page binds to them.
  if (key.otherMods) return d("L3", "key-shortcut", "A keyboard shortcut can do anything the page binds to it.");

  if (key.base === "tab") {
    return tabIsHandled(facts)
      ? d("L2", "key-tab-handled", "Tab is handled by this editor, so it types a tab.")
      : d("L1", "key-tab-focus", "Tab only moves focus here.");
  }
  if (key.base === "escape") return d("L1", "key-escape", "Escape only closes or cancels.");

  if (PAGING_KEYS.has(key.base)) {
    if (isSelectLike(facts) || PAGING_ROLES.has(role)) return d("L2", "key-paging-widget", "Paging keys change the selection in this widget.");
    return d("L1", "key-paging", "Paging keys only move the view or the caret.");
  }

  if (ARROW_KEYS.has(key.base)) {
    if (isSelectLike(facts) || STATEFUL_ARROW_ROLES.has(role) || (tag === "input" && STATEFUL_ARROW_INPUTS.has(typeOf(facts)))) {
      return d("L2", "key-arrow-widget", "Arrow keys change the value of this control.");
    }
    return d("L1", "key-arrow", "Arrow keys only move focus or the caret.");
  }

  if (key.base === "enter") return classifyEnter(facts);

  if (key.base === "space") {
    if (isSubmitControl(facts)) return d("L3", "key-space-submit", "Space activates a submit button.");
    if (!facts.tag && !facts.role) return d("L3", "unknown-target", "The focused element could not be identified.");
    const effect = activationEffect(facts);
    if (effect) return effect;
    if (namesSayL3(facts) && !isTextEntry(facts)) return d("L3", "l3-name", "Space activates a control that sends, deletes or buys.");
    return d("L2", "key-space", "Space types a space or toggles the focused control.");
  }

  // Printable keys and everything else.
  if ([...key.base].length === 1 || key.base === "backspace" || key.base === "delete") {
    if (isTextEntry(facts)) return d("L2", "key-type", "Typing in a field.");
    return d("L3", "key-no-field", "A key with no field focused can trigger page shortcuts.");
  }
  return d("L3", "key-unknown", "The effect of this key is not known.");
}

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

const MODES = new Set<ApprovalMode>(["step", "task", "full"]);
const CATEGORIES = new Set<SiteCategory>(["handover", "neverDefault", "askEveryStep", "normal"]);

function floorResult(reason: string, rule: string): LevelResult {
  return { level: "floor", needsCard: false, reason, rule };
}

interface Card { needsCard: boolean; reason: string; rule: string; skip?: boolean; refuse?: true; siteCard?: true }

function cardFor(input: LevelInput, decision: Decision): Card {
  const mode: ApprovalMode = MODES.has(input.mode) ? input.mode : "step";
  const category: SiteCategory = CATEGORIES.has(input.category) ? input.category : "askEveryStep";
  const level = decision.level;
  const routine = input.routine === true;
  const allowAlways = input.siteAllowedAlways === true;

  // Spec 2.3 and 2.7 rule 2: refused before anything else.
  if (category === "handover") {
    return { needsCard: true, refuse: true, reason: "This site is handover only: the owner does it in person and the bot does not act here.", rule: "category-handover" };
  }
  if (category === "neverDefault") {
    return { needsCard: true, refuse: true, reason: "This site is set to Never for the bot, so the action is refused.", rule: "category-never" };
  }

  // Spec 2.6 rule 1: a routine never shows a site card; a site that is not Allow always is skipped.
  if (routine && !allowAlways) {
    return { needsCard: true, skip: true, reason: "skip: this site is not allowed always, so a scheduled run leaves it alone.", rule: "routine-skip" };
  }

  // Intent refusal and checker block (spec 2.7 rule 7): a refusal, before any site or mode rule.
  if (level !== "L1") {
    if (input.intent === "refuse") return { needsCard: true, refuse: true, reason: "The intent check refused this action.", rule: "intent-refuse" };
    if (input.checker === "block") return { needsCard: true, refuse: true, reason: "The action checker blocked this action.", rule: "checker-block" };
  }

  // Spec 2.2 "New site" and 2.7 rule 2: a site with no L1 grant for this task and not Allow always needs
  // the site card, at every level, except in full permissive on a site whose category does not still ask.
  // Routine runs never reach here without Allow always. Grants are not read in a routine (2.6 rule 2).
  const siteAllowed = allowAlways || (!routine && input.grants?.l1 === true);
  let fullNewSite = false;
  if (!siteAllowed) {
    if (mode === "full" && category === "normal") {
      fullNewSite = true;
    } else {
      return { needsCard: true, siteCard: true, reason: "This site is not yet allowed for this task, so the site card comes first.", rule: "site-card" };
    }
  }
  const newSiteNote = fullNewSite ? " Full permissive allows this new site for the task without a card; it is logged." : "";

  if (level === "L1") return { needsCard: false, reason: `No card.${newSiteNote}`, rule: fullNewSite ? "full-new-site" : decision.rule };

  // From here the action is L2 or L3. An intent card and a checker ask only tighten.
  const tightened = input.intent === "card" || input.checker === "ask";
  const base = (needsCard: boolean, reason: string, rule: string): Card => {
    if (needsCard) return { needsCard: true, reason, rule };
    if (tightened) return { needsCard: true, reason: "A check on this action raised a card.", rule: "tightened" };
    return { needsCard: false, reason: `${reason}${newSiteNote}`, rule };
  };
  // Intent must have passed for the full mode to skip a card. A missing or unknown value is not a pass.
  const intentPassed = input.intent === "pass";

  if (decision.alwaysAsk) return base(true, "The owner confirms deletion each time.", "owner-confirmation");

  if (category === "askEveryStep") return base(true, "This site asks at every step.", "ask-every-step");
  if (mode === "step") return base(true, "Ask each step: a card for every action.", "mode-step");

  if (mode === "full") {
    if (!intentPassed) return base(true, "Full permissive, but the intent check did not pass.", "mode-full-intent");
    // Gate ruling: Level 3 in full permissive also needs the action checker to allow. Missing is a card.
    if (level === "L3" && input.checker !== "allow") return base(true, "Full permissive, but the action checker did not allow this Level 3 step.", "mode-full-checker");
    return base(false, "Full permissive and the checks passed.", "mode-full-pass");
  }

  // task mode
  if (level === "L3") return base(true, "Level 3 always asks.", "l3-card");
  const granted = routine ? allowAlways : (input.grants?.l2 === true || allowAlways);
  return granted ? base(false, "Level 2 is already allowed for this task on this site.", "l2-granted") : base(true, "The first Level 2 action on this site needs a card.", "l2-first");
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** One canonical action from the input and the facts, or null when they disagree (unsure means floor). */
function canonicalAction(input: LevelInput): Action | null {
  const operation = input.operation.trim().toLowerCase();
  const factsOperation: unknown = input.facts.operation;
  if (factsOperation !== undefined && (typeof factsOperation !== "string" || factsOperation.trim().toLowerCase() !== operation)) return null;
  const inputKey: unknown = input.key;
  const factsKey: unknown = input.facts.key;
  if (inputKey !== undefined && typeof inputKey !== "string") return null;
  if (factsKey !== undefined && typeof factsKey !== "string") return null;
  if (inputKey !== undefined && factsKey !== undefined && inputKey !== factsKey) return null;
  const rawKey = (inputKey ?? factsKey) as string | undefined;
  return { operation, rawKey, key: parseKey(rawKey) };
}

/**
 * Which level is this action, and does it need a card? Pure. A missing input,
 * a missing or malformed floor value or a thrown error is floor (unsure means floor).
 */
export function classifyLevel(input: LevelInput): LevelResult {
  try {
    if (!input || typeof input !== "object" || typeof input.operation !== "string" || !input.facts || typeof input.facts !== "object") {
      return floorResult("The action could not be understood, so the owner takes this step.", "unsure");
    }
    const given: unknown = input.floor;
    if (given === undefined) return floorResult("The floor was not checked, so the owner takes this step.", "floor-missing");
    if (given !== null) {
      if (typeof given !== "object" || Array.isArray(given)) return floorResult("The floor value could not be read, so the owner takes this step.", "floor-malformed");
      const kind = (given as { floor?: unknown }).floor;
      if (typeof kind === "string" && kind) return floorResult((given as FloorResult).reason || "This step needs the owner in person.", "floor");
      if (kind !== null) return floorResult("The floor value could not be read, so the owner takes this step.", "floor-malformed");
    }

    const action = canonicalAction(input);
    if (!action) return floorResult("The action and the facts disagree about what this step is, so the owner takes this step.", "action-mismatch");

    // The floor looks at the facts again, on the same canonical action the level uses: a caller that
    // passed null cannot lower it. A label click is checked as the label and as its control.
    const pressing = PRESS_OPERATIONS.has(action.operation);
    const raw: LevelFacts = { ...input.facts, operation: action.operation, key: pressing ? action.key?.floorKey : undefined };
    const merged = mergeLabel(raw);
    const again = classifyFloor(raw);
    if (again.floor) return floorResult(again.reason, "floor-facts");
    if (merged !== raw) {
      const control = classifyFloor(merged);
      if (control.floor) return floorResult(control.reason, "floor-label-control");
    }

    let decision = levelFromEffect(action, merged, input.textHasNewline === true);
    if (needsOwnerConfirmation(action, merged, decision, input.textHasNewline === true)) {
      decision = { ...d("L3", "owner-confirmation", "This step needs the owner's confirmation."), alwaysAsk: true };
    }
    const card = cardFor(input, decision);
    const ownReason = card.skip || card.refuse || card.siteCard || card.rule === "tightened";
    return {
      level: decision.level,
      needsCard: card.needsCard,
      reason: ownReason ? card.reason : `${decision.reason} ${card.reason}`,
      rule: card.rule,
      ...(card.skip ? { skip: true } : {}),
      ...(card.refuse ? { refuse: true as const } : {}),
      ...(card.siteCard ? { siteCard: true as const } : {}),
    };
  } catch {
    return floorResult("The classifier failed, so the owner takes this step.", "classifier-error");
  }
}
