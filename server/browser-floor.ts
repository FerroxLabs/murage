// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The hard floor classifier for Murage for Chrome (spec 2.5).
//
// `classifyFloor(facts)` is a pure function of the facts the executor collects
// for the effect target. It answers one question: does this step need the
// owner in person? Four categories, in the spec's words:
//
//   consent       F1  terms, policies, consent, OAuth and app authorisation
//   verification  F2  CAPTCHA, "I'm not a robot", "Click here to verify"
//   credentials   F3  password, one-time code, card, ID and payment entry
//   payment       F4  the final pay or place-order button
//
// No mode, site setting, card or instruction lifts a floor result. When the
// classifier is unsure it says floor: missing facts, an unreadable frame, a
// thrown error. The facts carry names and snippets only, never field values.
//
// Rule order (first match wins):
//   dialog text, challenge page, target in CAPTCHA, unreadable frame,
//   field entry (F3), upload (F3), verification names (F2), payment (F4),
//   consent (F1), credentials submit (F3), weak words in context, unsure.

import { matchFrame, matchFrameName, CHALLENGE_PATH_PATTERNS, CHALLENGE_TITLE_PHRASES, CHALLENGE_TITLE_PREFIXES, OAUTH_PATH_PATTERN } from "../shared/browser-floor-signatures.ts";
import type { FloorKind, FrameRef } from "../shared/browser-floor-signatures.ts";
import type { PhraseTable } from "./browser-floor-lexicon.ts";
import {
  CARD_AUTOCOMPLETE_PREFIX,
  CONSENT_AGREE_VERB,
  CONSENT_CONTROL_STRONG,
  CONSENT_CONTROL_WEAK,
  CONSENT_DECLINE,
  CONSENT_OPENERS,
  CONSENT_SAVE_CHOICES,
  CONSENT_TOPIC,
  CREDENTIAL_AUTOCOMPLETE_TOKENS,
  CREDENTIAL_FIELD,
  CREDENTIAL_IDENTIFIER_TOKENS,
  FOUNDRY_PAY_PATTERNS,
  ID_UPLOAD_FIELD,
  OAUTH_ALLOW,
  OAUTH_PHRASES,
  PAY_CONTROL,
  PAY_CONTROL_WEAK,
  SENTENCE_AGREE,
  SENTENCE_BY_ACTION,
  VERIFY_HUMAN,
  VERIFY_WORD,
  compilePhrases,
  foldText,
} from "./browser-floor-lexicon.ts";

export type { FloorKind, FrameRef };

export interface FloorFacts {
  /** The tool operation: click, type, fill, press, select, check, upload, dialog_accept, keyboard_type, and so on. */
  operation: string;
  /** For press and keyboard_press: the key, as a DOM key name ("Enter", " ", "a"). */
  key?: string;

  tag?: string;
  /** The input type attribute. */
  type?: string;
  role?: string;
  /** Accessible name from Accessibility.getPartialAXTree. */
  name?: string;
  description?: string;
  /** Visible text of the target. */
  text?: string;
  /** The value attribute of a button or submit input. Never the value of a field. */
  buttonValue?: string;
  title?: string;
  ariaLabel?: string;
  alt?: string;
  placeholder?: string;
  /** The id and name attributes, joined by a space. */
  fieldName?: string;
  autocomplete?: string;
  /** The guard saw this element as type=password at some point. */
  wasPassword?: boolean;
  checked?: boolean;
  required?: boolean;
  /** The action would submit its form (submit button, image button, Enter at focus). */
  submits?: boolean;

  form?: {
    action?: string;
    method?: string;
    hasPasswordField?: boolean;
    hasOneTimeCodeField?: boolean;
    hasCardFields?: boolean;
    hasCurrencyAmount?: boolean;
  };

  /** Visible text near the target, each capped at 1,000 characters by the collector. */
  snippets?: {
    form?: string;
    dialog?: string;
    landmark?: string;
    /** Up to 300 characters before the target in reading order. */
    before?: string;
    /** Up to 300 characters after the target in reading order. */
    after?: string;
  };

  page?: {
    urlPath?: string;
    title?: string;
    hasPaymentRequestButton?: boolean;
    hasCurrencyAmount?: boolean;
    hasConsentManager?: boolean;
    hasCaptcha?: boolean;
    hasPaymentFrame?: boolean;
    /** Child frames, hosts (and paths where kept). */
    frames?: FrameRef[];
  };

  /** Booleans from the signature tables. The first three say the TARGET sits inside the framework. */
  signatures?: {
    consentManager?: boolean;
    captcha?: boolean;
    payment?: boolean;
    /** The page is a challenge interstitial. */
    challengePage?: boolean;
  };

  /** The frame the target lives in when it is not the top frame. */
  frame?: { host: string; path?: string; readable: boolean };

  /** In a consent banner: is any optional category switched on? Unknown means unknown. */
  consentOptionalOn?: boolean;

  /** For dialog operations: the JavaScript dialog being answered. */
  dialog?: { kind: string; text: string };

  /** Recipients the form or dialog around a send, share or invite is about to go to: the addresses, handles and numbers in its
   * recipient-like fields (T21, intent rule I2). Read only by the separate recipients scan, never by the floor, and never from a
   * password, code or card field. Absent means no recipient field was found or the scan could not run. */
  recipients?: string[];
  /** T22: the recipients scan ran on a send or submit and could not read the page (it threw, or answered with something unusable). The
   * recipients are then unknown, and intent rule I2 treats unknown as a reason to ask. Absent when the scan worked or did not apply. */
  recipientScanFailed?: boolean;
  /** Native action-kind classification, independent of the action level. */
  sendCapable?: boolean;
  /** The recipient scan hit its cap: who this goes to cannot be bound, so the owner takes over. */
  recipientCapped?: boolean;
  /** The complete native inventory counted zero field-like elements. */
  recipientNoField?: boolean;
  /** All fields were positively classified, with a composer and no explicit recipients. */
  recipientComposer?: boolean;
  /** The collector could not read the target (frame, AX call or isolated world failed). */
  factsFailed?: boolean;
}

export interface FloorResult {
  floor: FloorKind | null;
  /** Plain sentence, free of page text. */
  reason: string;
  /** Stable rule id, for tests and the activity log. */
  rule: string;
  /** True when floor was chosen because the classifier could not tell. */
  unsure?: boolean;
}

// ---------------------------------------------------------------------------
// Compiled matchers
// ---------------------------------------------------------------------------

const M = {
  consentStrong: compilePhrases(CONSENT_CONTROL_STRONG),
  consentWeak: compilePhrases(CONSENT_CONTROL_WEAK),
  agreeVerb: compilePhrases(CONSENT_AGREE_VERB),
  topic: compilePhrases(CONSENT_TOPIC),
  decline: compilePhrases(CONSENT_DECLINE),
  openers: compilePhrases(CONSENT_OPENERS),
  saveChoices: compilePhrases(CONSENT_SAVE_CHOICES),
  byAction: compilePhrases(SENTENCE_BY_ACTION),
  sentenceAgree: compilePhrases(SENTENCE_AGREE),
  oauth: compilePhrases(OAUTH_PHRASES),
  oauthAllow: compilePhrases(OAUTH_ALLOW),
  verifyHuman: compilePhrases(VERIFY_HUMAN),
  verifyWord: compilePhrases(VERIFY_WORD),
  field: compilePhrases(CREDENTIAL_FIELD),
  idUpload: compilePhrases(ID_UPLOAD_FIELD),
  pay: compilePhrases(PAY_CONTROL),
  payWeak: compilePhrases(PAY_CONTROL_WEAK),
};

// D1: these changes belong to the owner even when no credential field is visible.
// Use the existing floor protocol so callers cannot turn a hand-back into a card.
const OWNER_ACCOUNT_ACTIONS: PhraseTable = {
  en: ["change password", "reset password", "update password", "change your password", "reset your password", "2fa", "two factor", "two-factor", "two step verification", "multi factor", "mfa", "sharing settings", "share settings", "change permissions", "update permissions", "manage access", "grant access", "revoke", "make public", "close account", "close your account", "delete account", "delete your account", "deactivate account"],
  es: ["cambiar contraseña", "restablecer contraseña", "cambiar la contraseña", "dos factores", "configuración de uso compartido", "cambiar permisos", "conceder acceso", "revocar", "hacer público", "cerrar cuenta", "eliminar cuenta"],
  fr: ["changer le mot de passe", "réinitialiser le mot de passe", "deux facteurs", "paramètres de partage", "modifier les autorisations", "accorder l'accès", "révoquer", "rendre public", "fermer le compte", "supprimer le compte"],
  de: ["passwort ändern", "passwort zurücksetzen", "zwei faktor", "freigabeeinstellungen", "berechtigungen ändern", "zugriff gewähren", "widerrufen", "öffentlich machen", "konto schließen", "konto löschen"],
  pt: ["alterar senha", "redefinir senha", "dois fatores", "configurações de compartilhamento", "alterar permissões", "conceder acesso", "revogar", "tornar público", "encerrar conta", "fechar conta", "excluir conta"],
  ja: ["パスワードを変更", "パスワード変更", "パスワードをリセット", "二要素認証", "2段階認証", "共有設定", "権限を変更", "アクセスを許可", "アクセスを取り消す", "公開する", "アカウントを閉鎖", "アカウントを削除", "退会"],
  zh: ["修改密码", "修改密碼", "更改密码", "更改密碼", "重置密码", "重置密碼", "双重认证", "雙重驗證", "共享设置", "共享設定", "更改权限", "更改權限", "授予访问权限", "授予存取權限", "撤销", "撤銷", "设为公开", "設為公開", "关闭账户", "關閉帳戶", "删除账户", "刪除帳戶", "注销", "註銷"],
  hi: ["पासवर्ड बदलें", "पासवर्ड रीसेट करें", "दो चरणों में पुष्टि", "दो कारक प्रमाणीकरण", "साझाकरण सेटिंग", "अनुमतियां बदलें", "पहुंच प्रदान करें", "पहुँच प्रदान करें", "पहुंच रद्द करें", "सार्वजनिक करें", "खाता बंद करें", "खाता हटाएं"],
};
const ownerAccount = compilePhrases(OWNER_ACCOUNT_ACTIONS);

const READ_OPERATIONS = new Set([
  "read", "snapshot", "screenshot", "scroll", "navigate", "wait", "hover", "find", "get_text", "get_page_text", "read_page",
  "list_tabs", "tabs", "tab_list", "tab_switch", "back", "forward", "reload", "console", "network", "describe", "mouse_move", "scroll_to",
]);
const ENTRY_OPERATIONS = new Set(["type", "fill", "select", "paste", "insert_text", "keyboard_type", "keyboard_insert", "form_input", "set_value"]);
const ACTIVATE_OPERATIONS = new Set(["click", "dblclick", "double_click", "right_click", "check", "uncheck", "toggle", "tap", "keyboard_activate", "activate", "submit"]);
const PRESS_OPERATIONS = new Set(["press", "keyboard_press", "key"]);

const SNIPPET_CAP = 1000;
const NEAR_CAP = 300;

const CURRENCY = /(?:[$€£¥₹₩₽₺₪]\s?\d|\d[\d.,]*\s?(?:[$€£¥₹₩]|usd|eur|gbp|cad|aud|inr|jpy|cny|brl|mxn|chf|dollars?|euros?|pounds?|円|元|रुपये)(?![a-z]))/iu;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clip(text: string | undefined, cap: number): string {
  return typeof text === "string" ? text.slice(0, cap) : "";
}

function fold(text: string | undefined, cap: number): string {
  return foldFloorText(clip(text, cap));
}

/** Shared bounded-label normalisation for the floor and level classifiers. */
export function foldFloorText(text: string): string {
  // Includes bidi isolates and variation selectors as well as zero-width formats.
  const visible = text.normalize("NFKC").replace(/[\t\n\r]/gu, " ")
    .replace(/[\p{Default_Ignorable_Code_Point}\p{Cc}]/gu, "");
  // A Latin action beside a CJK translation still has a word boundary.
  return foldText(visible
    .replace(/(\p{Script=Latin})(?=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}])/gu, "$1 ")
    .replace(/([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}])(?=\p{Script=Latin})/gu, "$1 "));
}

function incompleteLabel(f: FloorFacts): boolean {
  // The current collector supplies no truncation bit. A value at its cap is
  // ambiguous, including a genuinely complete value of exactly that length.
  const limits = { name: 500, description: 500, text: 500, buttonValue: 200,
    title: 200, ariaLabel: 200, alt: 200, placeholder: 200, fieldName: 160 } as const;
  return (Object.keys(limits) as Array<keyof typeof limits>).some(key => {
    const value = f[key];
    return typeof value === "string" && value.length >= limits[key];
  });
}

function mixedScriptLabel(f: FloorFacts): boolean {
  // Lookalikes in a single word cannot establish the action. Keep separate
  // translated words usable, and hand ambiguous Latin/Greek/Cyrillic words back.
  return controlNames(f).concat(fieldNames(f)).some(name => name.split(/\s+/u).some(word =>
    /\p{Script=Latin}/u.test(word) && /[\p{Script=Cyrillic}\p{Script=Greek}]/u.test(word)));
}

function classifyOwnerAccount(names: string[]): FloorResult | null {
  return names.some(name => ownerAccount.test(name))
    ? hit("consent", "owner-account-change", "The owner controls account, access and security changes in person.")
    : null;
}

function hit(floor: FloorKind, rule: string, reason: string, unsure = false): FloorResult {
  return unsure ? { floor, rule, reason, unsure: true } : { floor, rule, reason };
}

const NONE = (rule: string, reason: string): FloorResult => ({ floor: null, rule, reason });

/** Names a control can be known by, folded, deduplicated. Never a field value. */
function controlNames(f: FloorFacts): string[] {
  const buttonLike = isButtonLike(f);
  const tag = (f.tag ?? "").toLowerCase();
  // The text of a textarea, select or text input is what the owner typed, not a name.
  const textIsValue = !buttonLike && !isCheckLike(f) && (tag === "textarea" || tag === "select" || tag === "input");
  const raw = [f.name, textIsValue ? undefined : f.text, f.title, f.ariaLabel, f.alt, buttonLike ? f.buttonValue : undefined];
  const names: string[] = [];
  for (const item of raw) {
    const folded = fold(item, 500);
    if (folded && !names.includes(folded)) names.push(folded);
  }
  return names;
}

/** Names of a field: label, name and placeholder, plus the folded identifier. */
function fieldNames(f: FloorFacts): string[] {
  const raw = [f.name, f.description, f.title, f.ariaLabel, f.placeholder, f.alt];
  const names: string[] = [];
  for (const item of raw) {
    const folded = fold(item, 500);
    if (folded && !names.includes(folded)) names.push(folded);
  }
  return names;
}

function isButtonLike(f: FloorFacts): boolean {
  const tag = (f.tag ?? "").toLowerCase();
  const type = (f.type ?? "").toLowerCase();
  const role = (f.role ?? "").toLowerCase();
  // A chip may expose only its accessible name. Missing semantics cannot exempt it.
  if (!role && !["input", "textarea", "select"].includes(tag) && typeof f.name === "string" && f.name.length > 0) return true;
  if (tag === "button" || tag === "summary") return true;
  if (tag === "input" && ["button", "submit", "image", "reset"].includes(type)) return true;
  return role === "button" || role === "link" || role === "menuitem" || role === "tab" || tag === "a";
}

function isLinkLike(f: FloorFacts): boolean {
  return (f.tag ?? "").toLowerCase() === "a" || (f.role ?? "").toLowerCase() === "link";
}

function isCheckLike(f: FloorFacts): boolean {
  const tag = (f.tag ?? "").toLowerCase();
  const type = (f.type ?? "").toLowerCase();
  const role = (f.role ?? "").toLowerCase();
  if (tag === "input" && (type === "checkbox" || type === "radio")) return true;
  return ["checkbox", "radio", "switch", "menuitemcheckbox", "menuitemradio"].includes(role);
}

function anyName(names: string[], test: (folded: string) => boolean): boolean {
  // Names were bounded on collection above. Length never exempts a control.
  return names.some(test);
}

function isCloseSymbol(f: FloorFacts): boolean {
  const raw = [f.name, f.text, f.title, f.ariaLabel].map(item => (item ?? "").trim());
  return raw.some(item => ["×", "x", "✕", "✖", "╳", "✗", "X"].includes(item));
}

// A key as a model may spell it: "enter", "Return", "NumpadEnter", "Shift+Space", "ControlOrMeta+Enter".
// The base is the part after the last "+" (a lone "+" or a trailing "+" is the plus key itself).
function splitKey(key: string): { base: string; modifiers: string[] } {
  // Key layouts map a line break to Enter.
  if (/^(?:\r\n|\r|\n)$/.test(key)) return { base: "Enter", modifiers: [] };
  if (key === "+" || !key.includes("+") || key.endsWith("++")) return { base: key.endsWith("++") ? "+" : key, modifiers: key.endsWith("++") ? key.slice(0, -2).split("+").filter(Boolean) : [] };
  const parts = key.split("+");
  const base = parts.pop()!;
  return { base: base === "" ? "+" : base, modifiers: parts.filter(Boolean) };
}
const ACTIVATION_BASES = new Set(["enter", "return", "numpadenter", " ", "space", "spacebar"]);
// Keys that never type, activate or submit by themselves. Anything else is unsure, and unsure is floor.
const INERT_BASES = new Set(["tab", "escape", "esc", "backspace", "delete", "arrowup", "arrowdown", "arrowleft", "arrowright", "up", "down", "left", "right", "home", "end", "pageup", "pagedown", "shift", "control", "ctrl", "alt", "meta", "capslock", "insert"]);

function printable(key: string | undefined): boolean {
  if (key === undefined) return true; // unknown key: treat as typing
  const { base } = splitKey(key);
  // A single character, with or without modifiers (Shift+A types "A"), counts as typing.
  return [...base].length === 1 && base !== " ";
}

/** Enter in any spelling, or a key nobody named: it may submit the form. */
function enterLike(key: string | undefined): boolean {
  if (key === undefined) return true;
  const { base } = splitKey(key);
  return ["enter", "return", "numpadenter"].includes(base.toLowerCase());
}

function isActivationKey(key: string | undefined): boolean {
  if (key === undefined) return true;
  const { base, modifiers } = splitKey(key);
  const lower = base.toLowerCase();
  if (ACTIVATION_BASES.has(lower)) return true;
  // A modifier other than Shift makes a shortcut whose effect the page decides: treat it as activation.
  if (modifiers.some(m => m.toLowerCase() !== "shift")) return true;
  // A control or whitespace character other than Space is unknown: unsure, so activation.
  if ([...base].length === 1) return base !== " " && /[\p{Cc}\p{Z}]/u.test(base);
  return !INERT_BASES.has(lower) && !/^f\d{1,2}$/.test(lower);
}

function operationShape(f: FloorFacts): { entry: boolean; activate: boolean; upload: boolean } {
  const op = (f.operation ?? "").toLowerCase();
  if (op === "upload" || op === "file_upload") return { entry: false, activate: false, upload: true };
  if (ENTRY_OPERATIONS.has(op)) return { entry: true, activate: false, upload: false };
  if (ACTIVATE_OPERATIONS.has(op)) return { entry: false, activate: true, upload: false };
  if (PRESS_OPERATIONS.has(op)) return { entry: printable(f.key), activate: isActivationKey(f.key), upload: false };
  // An operation we do not know is both: when unsure, check everything.
  return { entry: true, activate: true, upload: false };
}

function tokens(identifier: string): string[] {
  const split = identifier.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const joined = identifier.toLowerCase().replace(/[^a-z0-9]+/g, "");
  return [...split, joined];
}

function autocompleteTokens(value: string | undefined): string[] {
  return (value ?? "").toLowerCase().split(/\s+/).filter(Boolean);
}

function hasCurrency(...texts: Array<string | undefined>): boolean {
  return texts.some(text => !!text && CURRENCY.test(clip(text, SNIPPET_CAP).normalize("NFKC")));
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

interface Context {
  consent: boolean;
  challenge: boolean;
  payment: boolean;
  /** The page URL or text says this is an OAuth or app authorisation screen. */
  oauthText: boolean;
  oauthPath: boolean;
  targetInConsent: boolean;
  targetInCaptcha: boolean;
  targetInPayment: boolean;
  challengePage: boolean;
}

function folded5(f: FloorFacts): { form: string; dialog: string; landmark: string; before: string; after: string } {
  const s = f.snippets ?? {};
  return {
    form: fold(s.form, SNIPPET_CAP),
    dialog: fold(s.dialog, SNIPPET_CAP),
    landmark: fold(s.landmark, SNIPPET_CAP),
    before: foldFloorText(clip(s.before, SNIPPET_CAP).slice(-NEAR_CAP)),
    after: fold(s.after, NEAR_CAP),
  };
}

function frameFlags(frames: FrameRef[] | undefined): { consent: boolean; captcha: boolean; payment: boolean } {
  const flags = { consent: false, captcha: false, payment: false };
  for (const frame of frames ?? []) {
    if (!frame || typeof frame.host !== "string") continue;
    const sig = matchFrame(frame);
    if (sig) flags[sig.kind] = true;
  }
  return flags;
}

function isChallengePage(f: FloorFacts): boolean {
  if (f.signatures?.challengePage) return true;
  const path = f.page?.urlPath ?? "";
  if (path && CHALLENGE_PATH_PATTERNS.some(pattern => pattern.test(path))) return true;
  const title = fold(f.page?.title, 300);
  if (!title) return false;
  if (CHALLENGE_TITLE_PREFIXES.some(prefix => title.startsWith(foldText(prefix)))) return true;
  return CHALLENGE_TITLE_PHRASES.some(phrase => title.includes(foldText(phrase)));
}

function buildContext(f: FloorFacts, near: ReturnType<typeof folded5>): Context {
  const frames = frameFlags(f.page?.frames);
  const sig = f.signatures ?? {};
  const targetFrame = f.frame && typeof f.frame.host === "string" ? matchFrame(f.frame) : null;
  const targetInConsent = !!sig.consentManager || targetFrame?.kind === "consent";
  const targetInCaptcha = !!sig.captcha || targetFrame?.kind === "captcha";
  const targetInPayment = !!sig.payment || targetFrame?.kind === "payment";
  const challengePage = isChallengePage(f);
  const names = controlNames(f);
  const oauthText = [near.form, near.dialog, near.landmark, fold(f.page?.title, 300)].some(text => M.oauth.test(text));
  const oauthPath = OAUTH_PATH_PATTERN.test(f.page?.urlPath ?? "");
  const clickToAgreeAnywhere = agreeSentencesRaw(f, names).length > 0;
  const topicNear = [near.form, near.dialog, near.before, near.after].some(text => text && M.topic.test(text));
  const consent = targetInConsent || !!f.page?.hasConsentManager || frames.consent || clickToAgreeAnywhere || topicNear;
  const challenge = challengePage || targetInCaptcha || !!f.page?.hasCaptcha || frames.captcha;
  const payment =
    targetInPayment ||
    !!f.page?.hasPaymentFrame ||
    !!f.page?.hasPaymentRequestButton ||
    frames.payment ||
    !!f.form?.hasCardFields ||
    !!f.form?.hasCurrencyAmount ||
    hasCurrency(f.snippets?.form, f.snippets?.dialog);
  return { consent, challenge, payment, oauthText, oauthPath, targetInConsent, targetInCaptcha, targetInPayment, challengePage };
}

interface AgreeSentence {
  hasBy: boolean;
  namesLabel: boolean;
}

/** Click-to-agree sentences in one snippet. The snippet is split on raw punctuation before folding. */
function agreeSentences(foldedOrRaw: string, names: string[]): AgreeSentence[] {
  const out: AgreeSentence[] = [];
  for (const piece of foldedOrRaw.split(/[.!?;:\n\r。！？]+/u)) {
    const sentence = foldFloorText(piece);
    if (!sentence || !M.sentenceAgree.test(sentence)) continue;
    const namesLabel = names.some(name => name.length >= 3 && sentence.includes(name));
    out.push({ hasBy: M.byAction.test(sentence), namesLabel });
  }
  return out;
}

/** Raw snippets keep their punctuation so sentences can be split; folded snippets lose it. */
function agreeSentencesRaw(f: FloorFacts, names: string[]): AgreeSentence[] {
  const s = f.snippets ?? {};
  const out: AgreeSentence[] = [];
  for (const text of [s.form, s.dialog, s.landmark, s.before, s.after]) {
    if (typeof text === "string" && text) out.push(...agreeSentences(clip(text, SNIPPET_CAP), names));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

function classifyDialog(f: FloorFacts): FloorResult {
  const op = (f.operation ?? "").toLowerCase();
  const kind = (f.dialog?.kind ?? "").toLowerCase();
  const text = fold(f.dialog?.text, SNIPPET_CAP);
  // Declining a dialog binds nothing, and an alert only informs.
  if (op.includes("dismiss") || op.includes("cancel")) return NONE("dialog-dismiss", "Dismissing a dialog binds nothing.");
  if (kind === "alert" || kind === "beforeunload") return NONE("dialog-info", "An alert only informs.");
  if (!text) return hit("consent", "dialog-unreadable", "The dialog text could not be read.", true);
  if (M.field.test(text)) return hit("credentials", "dialog-credentials", "The dialog asks for a password, code, card or ID.");
  const account = classifyOwnerAccount([text]);
  if (account) return account;
  if (M.pay.test(text)) return hit("payment", "dialog-payment", "The dialog asks to confirm a payment or order.");
  if (M.agreeVerb.test(text) || M.topic.test(text) || M.sentenceAgree.test(text)) {
    return hit("consent", "dialog-consent", "The dialog asks the owner to agree to terms or consent.");
  }
  return NONE("dialog-other", "The dialog is not about consent, credentials or payment.");
}

function classifyEntry(f: FloorFacts, names: string[]): FloorResult | null {
  const type = (f.type ?? "").toLowerCase();
  if (type === "password" || f.wasPassword) return hit("credentials", "field-password", "The field is a password field.");
  const tokensAc = autocompleteTokens(f.autocomplete);
  if (tokensAc.some(token => CREDENTIAL_AUTOCOMPLETE_TOKENS.includes(token) || token.startsWith(CARD_AUTOCOMPLETE_PREFIX))) {
    return hit("credentials", "field-autocomplete", "The field is marked as a password, code or card field.");
  }
  if (anyName(names, name => M.field.test(name))) {
    return hit("credentials", "field-name", "The field asks for a password, code, card or ID number.");
  }
  const identifier = clip(f.fieldName, 200);
  if (identifier && tokens(identifier).some(token => CREDENTIAL_IDENTIFIER_TOKENS.includes(token))) {
    return hit("credentials", "field-identifier", "The field's name marks it as a secret or card field.");
  }
  return null;
}

function classifyUpload(names: string[], f: FloorFacts): FloorResult | null {
  const labelled = anyName(names, name => M.idUpload.test(name) || M.field.test(name));
  if (labelled) return hit("credentials", "upload-id", "The upload field is for an ID document or selfie.");
  const identifier = clip(f.fieldName, 200);
  if (identifier && /(passport|licen[cs]e|selfie|idcard|id_card|nationalid|photoid)/i.test(identifier)) {
    return hit("credentials", "upload-id", "The upload field is for an ID document or selfie.");
  }
  return null;
}

function classifyPayName(names: string[]): boolean {
  if (names.some(name => /^(?:pay|pagar|payer|bezahlen|zahlen)(?: |$)/u.test(name))) return true;
  if (anyName(names, name => M.pay.test(name))) return true;
  if (anyName(names, name => FOUNDRY_PAY_PATTERNS.some(pattern => pattern.test(name)))) return true;
  return false;
}

function classifyConsent(f: FloorFacts, names: string[], ctx: Context): FloorResult | null {
  const declined = isCloseSymbol(f) || anyName(names, name => M.decline.test(name));
  const strongName = anyName(names, name => M.consentStrong.test(name));
  const checkLike = isCheckLike(f);

  // Inside a known consent manager everything is floor except declining, closing, opening settings or reading a policy.
  if (ctx.targetInConsent) {
    if (strongName && !anyName(names, name => M.decline.test(name))) return hit("consent", "cmp-accept", "The control accepts cookies or consent.");
    if (declined) return NONE("cmp-decline", "Declining or closing a consent banner binds nothing.");
    if (anyName(names, name => M.saveChoices.test(name))) {
      if (f.consentOptionalOn === false) return NONE("cmp-save-required-only", "Saving with every optional category off binds nothing.");
      return hit("consent", "cmp-save-choices", "Saving cookie choices can switch on optional categories.");
    }
    if (anyName(names, name => M.openers.test(name) || M.topic.test(name)) && !checkLike) {
      return NONE("cmp-opener", "Opening settings or a policy binds nothing.");
    }
    return hit("consent", "cmp-control", "The control is inside a consent banner.");
  }

  // OAuth and app authorisation screens (decision D7).
  if ((ctx.oauthText || ctx.oauthPath) && (isButtonLike(f) || checkLike) && !declined) {
    const allowName = anyName(names, name => M.oauthAllow.test(name) || M.consentStrong.test(name) || M.consentWeak.test(name));
    if (ctx.oauthText || allowName) return hit("consent", "oauth", "The step grants an app access to the owner's account.");
  }

  // Checkbox, switch or radio that agrees to something.
  if (checkLike && !declined) {
    const topicOrVerb = anyName(names, name => M.agreeVerb.test(name) || M.topic.test(name));
    if (topicOrVerb) return hit("consent", "checkbox-name", "The box says it agrees to terms, a policy or consent.");
    const near = folded5(f);
    const nearAgree = [near.before, near.after].some(text => text && (M.sentenceAgree.test(text) || M.consentStrong.test(text)));
    const sentenceAgree = agreeSentencesRaw(f, names).length > 0;
    if (nearAgree || sentenceAgree) return hit("consent", "checkbox-nearby", "The box sits next to an agreement sentence.");
  }

  if (declined) return null;

  // Reading a policy is fine: a link whose name is only a policy or terms title.
  const policyLink =
    isLinkLike(f) && anyName(names, name => (M.topic.test(name) || M.openers.test(name)) && !M.consentStrong.test(name));

  if (!checkLike && anyName(names, name => M.consentStrong.test(name))) {
    return hit("consent", "control-name", "The control says it agrees or accepts.");
  }
  // A control whose own name is a click-to-agree sentence, however long.
  if (!checkLike && !policyLink && names.some(name => M.sentenceAgree.test(name) && M.byAction.test(name))) {
    return hit("consent", "control-sentence", "The control's own text is an agreement sentence.");
  }

  // Click-to-agree sentence in the form, dialog or nearest container.
  if (!checkLike && !policyLink && isButtonLike(f)) {
    const sentences = agreeSentencesRaw(f, names);
    if (sentences.some(sentence => sentence.namesLabel || sentence.hasBy)) {
      return hit("consent", "click-to-agree", "The page says that pressing this control means agreeing to terms.");
    }
  }
  return null;
}

function classifyWeak(f: FloorFacts, names: string[], ctx: Context): FloorResult | null {
  if (isCheckLike(f)) return null;
  const weakConsent = anyName(names, name => M.consentWeak.test(name));
  const weakPay = anyName(names, name => M.payWeak.test(name));
  if (!weakConsent && !weakPay) return null;
  if (weakPay && ctx.payment) return hit("payment", "weak-pay", "A bare Continue, Confirm or Submit sits in a payment context.");
  if (weakConsent && ctx.payment) return hit("payment", "weak-in-payment", "A bare Accept or Confirm sits in a payment context.");
  if (weakConsent && ctx.challenge) return hit("verification", "weak-in-challenge", "A bare Accept or Continue sits next to a human check.");
  if (weakConsent && ctx.consent) return hit("consent", "weak-in-consent", "A bare Accept or Agree sits in a consent context.");
  return null;
}

function unsureResult(f: FloorFacts): FloorResult {
  const op = (f.operation ?? "").toLowerCase();
  const kind: FloorKind = ENTRY_OPERATIONS.has(op) || op === "upload" ? "credentials" : "verification";
  return hit(kind, "unsure", "The page could not be read well enough to tell, so the owner takes this step.", true);
}

/** Round 10 (R9-08): incomplete facts on an activating action are the owner's before any other verdict is returned (Reject all, Settings and Save
 * preferences in a consent manager, a frame the reader could not see into, a weak word). Only an explicit floor verdict outranks it. */
function classify(f: FloorFacts): FloorResult {
  const result = classifyRules(f);
  if (result.floor || !f.factsFailed) return result;
  const op = (f.operation ?? "").toLowerCase();
  if (READ_OPERATIONS.has(op) || f.dialog || op.startsWith("dialog")) return result;
  const shape = operationShape(f);
  return shape.entry || shape.upload || shape.activate ? unsureResult(f) : result;
}

function classifyRules(f: FloorFacts): FloorResult {
  const op = (f.operation ?? "").toLowerCase();
  if (READ_OPERATIONS.has(op)) return NONE("read", "Reading does not need the owner.");

  if (f.dialog || op.startsWith("dialog")) return classifyDialog(f);

  const near = folded5(f);
  const ctx = buildContext(f, near);
  const shape = operationShape(f);
  const names = controlNames(f);
  const fields = fieldNames(f);

  // Challenge interstitial: every action there needs a person. Reads stay allowed (handled above).
  if (ctx.challengePage) return hit("verification", "challenge-page", "This page is a human check.");
  if (ctx.targetInCaptcha) return hit("verification", "captcha", "The control is part of a CAPTCHA or human check.");

  // The target sits in a frame the executor could not read.
  if (f.frame && f.frame.readable === false) {
    const sig = matchFrame(f.frame) ?? matchFrameName(f.frame.host);
    if (sig?.kind === "captcha") return hit("verification", "frame-captcha", "The control is inside an unreadable human-check frame.");
    if (sig?.kind === "payment") return hit("credentials", "frame-payment", "The control is inside an unreadable payment frame.");
    if (sig?.kind === "consent") return hit("consent", "frame-consent", "The control is inside an unreadable consent frame.");
  }

  // F3: typing, filling, selecting or pasting into a secret, code, card or ID field.
  if (shape.entry) {
    const entry = classifyEntry(f, fields);
    if (entry) return entry;
    // Choosing "I agree" in a select agrees as surely as ticking a box does.
    if ((f.operation ?? "").toLowerCase() === "select" || (f.tag ?? "").toLowerCase() === "select") {
      const all = names.concat(fields);
      if (anyName(all, name => M.consentStrong.test(name)) || (anyName(all, name => M.agreeVerb.test(name)) && anyName(all, name => M.topic.test(name)))) {
        return hit("consent", "select-consent", "The choice agrees to terms, a policy or consent.");
      }
    }
  }
  if (shape.upload) {
    const upload = classifyUpload(fields, f);
    if (upload) return upload;
  }

  if (shape.activate || shape.entry || shape.upload) {
    const account = classifyOwnerAccount(names.concat(fields));
    if (account) return account;
    // F2: verification names.
    if (anyName(names, name => M.verifyHuman.test(name)) || anyName(names, name => M.verifyWord.test(name))) {
      return hit("verification", "verify-name", "The control asks to verify or prove you are human.");
    }
  }

  if (shape.activate) {
    // F4: the final pay button.
    if (classifyPayName(names)) return hit("payment", "pay-name", "The control pays, places an order or donates.");
    if (ctx.targetInPayment && anyName(names, name => M.payWeak.test(name))) {
      return hit("payment", "weak-pay", "A bare Continue, Confirm or Submit sits in a payment context.");
    }
    if (ctx.targetInPayment) {
      return hit("credentials", "payment-frame", "The control is inside a payment form or button.");
    }
    // Whether the step submits its form. Unknown (the collector could not prove it) is decided by the
    // control: a submit or image input, or an Enter press (or an unknown key) in a field, submits.
    const submits = f.submits ?? (
      (f.type ?? "").toLowerCase() === "submit" || (f.type ?? "").toLowerCase() === "image"
      || (PRESS_OPERATIONS.has((f.operation ?? "").toLowerCase()) && enterLike(f.key))
    );
    if (submits && f.form?.hasCardFields) return hit("payment", "submit-card-form", "The step submits a form that holds card fields.");

    // F1: consent.
    const consent = classifyConsent(f, names, ctx);
    if (consent) return consent;

    // F3: submitting a form that has a password or one-time-code field.
    if (submits && (f.form?.hasPasswordField || f.form?.hasOneTimeCodeField)) {
      return hit("credentials", "submit-credentials-form", "The step submits a form with a password or code field.");
    }

    // Weak words in context.
    const weak = classifyWeak(f, names, ctx);
    if (weak) return weak;
  } else if (shape.entry && ctx.targetInPayment) {
    return hit("credentials", "payment-frame", "The field is inside a payment form.");
  }

  // An unrecognised embedded frame cannot exempt a name we did classify above.
  if (f.frame?.readable === false && !f.factsFailed) {
    return NONE("frame-other", "The control is in an embedded frame the page reader cannot see into.");
  }

  if (f.factsFailed) {
    // A failed read with no name is unsure for every kind of step (a click or Enter on a closed-shadow host
    // included): the owner takes it. A read that still has a name was decided by the rules above.
    // Round 8 (SEC-01): incomplete facts on ANY activating action (a click, a submit, Enter or Space) are the owner's, whatever name the page gave
    // the control. A page chooses its own names; a name it chose is not proof of what the control does.
    if (names.length === 0 || shape.entry || shape.upload || shape.activate) return unsureResult(f);
  }
  return NONE("none", "Nothing here needs the owner in person.");
}

/**
 * Does this step need the owner in person? Pure. A thrown error, a missing
 * facts object or an unreadable target is floor (spec 2.5.4).
 */
export function classifyFloor(facts: FloorFacts): FloorResult {
  try {
    if (!facts || typeof facts !== "object" || typeof facts.operation !== "string") {
      return hit("verification", "unsure", "The page could not be read well enough to tell, so the owner takes this step.", true);
    }
    const result = classify(facts);
    const op = facts.operation.toLowerCase();
    const dismissed = op.startsWith("dialog") && (op.includes("dismiss") || op.includes("cancel"));
    if (!READ_OPERATIONS.has(op) && !dismissed &&
      (incompleteLabel(facts) || mixedScriptLabel(facts) || (facts.dialog?.text.length ?? 0) >= SNIPPET_CAP)) {
      return result.floor ? { ...result, unsure: true } : unsureResult(facts);
    }
    return result;
  } catch {
    return hit("verification", "classifier-error", "The classifier failed, so the owner takes this step.", true);
  }
}
