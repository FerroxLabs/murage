// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The one check behind "Keep all" (PROPOSAL-v2 section 7, Phase 0). Pure rules,
// versioned in code, nothing stored. It runs when the list is read (to say how
// many are everyday) and again, per item, when Keep all commits. Anything the
// rules cannot place asks the owner one by one.
//
// Phase 0 scope: the owner pressing Keep all has seen each text, so the speaker
// of the evidence is reported but does not block. What blocks is what can
// quietly widen who sees a memory or change something the owner decided:
// identity kinds, corrections, anything touching a pinned or owner-edited item,
// shared spaces, sensitive subjects, and evidence that is no longer there.
import type { DatabaseSync } from "node:sqlite";
import { isPipKind } from "./pip-kinds.ts";

/** Bump when a rule changes; the version rides in every keep event. */
export const ELIGIBILITY_RULE_VERSION = 1;

export type AskReason =
  | "identity" | "correction" | "replaces-pinned" | "edited" | "shared-space"
  | "sensitive-money" | "sensitive-health" | "sensitive-secret" | "sensitive-person"
  | "source-gone";

export interface Eligibility {
  decision: "keep" | "ask" | "refuse";
  reasons: AskReason[];
  ruleVersion: number;
}

export interface EligibilityRow {
  id: string; version: number; scope_id: string; kind: string; text: string; assertion: string;
  supersedes_id: string | null; owner_pinned: number; state: string;
}

// Letters on both sides disqualify a match, so "tax" does not match "syntax".
const word = (terms: readonly string[]) => new RegExp(`(?<![\\p{L}\\p{N}])(?:${terms.join("|")})(?![\\p{L}\\p{N}])`, "iu");
// Scripts without spaces between words are matched as plain substrings.
const loose = (terms: readonly string[]) => new RegExp(terms.join("|"), "u");

const MONEY = [
  word(["salary", "salaries", "payroll", "wage", "wages", "bank", "iban", "swift", "routing number", "account number", "credit card", "debit card", "mortgage", "loan", "debt", "tax", "taxes", "invoice total", "budget",
    "salario", "sueldo", "nómina", "banco", "tarjeta de crédito", "hipoteca", "préstamo", "deuda", "impuestos",
    "salaire", "banque", "carte bancaire", "prêt", "dette", "impôt", "impôts",
    "gehalt", "lohn", "konto", "kreditkarte", "hypothek", "kredit", "schulden", "steuer", "steuern",
    "salário", "cartão de crédito", "empréstimo", "dívida", "imposto", "impostos"]),
  /[$€£¥]\s?\d|\d\s?(?:usd|eur|gbp|dollars|euros|pounds)\b/iu,
  loose(["給与", "給料", "銀行", "口座", "ローン", "借金", "税金", "वेतन", "बैंक", "कर्ज", "टैक्स"]),
];
const HEALTH = [
  word(["diagnosis", "diagnosed", "medication", "prescription", "therapy", "therapist", "illness", "disease", "surgery", "pregnant", "pregnancy", "allergy", "allergic", "medical", "doctor",
    "diagnóstico", "medicamento", "receta", "terapia", "enfermedad", "cirugía", "embarazo", "alergia", "médico",
    "diagnostic", "ordonnance", "maladie", "chirurgie", "grossesse", "allergie", "médecin",
    "diagnose", "medikament", "rezept", "krankheit", "operation", "schwanger", "schwangerschaft", "allergie", "arzt",
    "receita", "doença", "cirurgia", "gravidez", "alergia", "médico"]),
  loose(["診断", "病気", "薬", "手術", "妊娠", "アレルギー", "बीमारी", "दवा", "इलाज", "गर्भ"]),
];
const SECRET = [
  word(["password", "passcode", "pin code", "api key", "secret key", "private key", "token", "credential", "credentials", "ssn", "social security", "passport", "license number",
    "contraseña", "clave", "pasaporte", "mot de passe", "mot-de-passe", "passeport", "passwort", "kennwort", "reisepass", "senha", "passaporte"]),
  /\b(?:sk|pk|ghp|xox[abp]|AKIA)[-_A-Za-z0-9]{12,}/,
  loose(["パスワード", "暗証", "パスポート", "पासवर्ड", "पासपोर्ट"]),
];
const PERSON = [
  word(["my wife", "my husband", "my partner", "my girlfriend", "my boyfriend", "my son", "my daughter", "my mother", "my father", "my mom", "my dad", "my brother", "my sister", "my ex", "my boss",
    "mi esposa", "mi esposo", "mi pareja", "mi hijo", "mi hija", "ma femme", "mon mari", "mon fils", "ma fille", "meine frau", "mein mann", "mein sohn", "meine tochter", "minha esposa", "meu marido", "meu filho", "minha filha"]),
  // A name after a preposition or a verb of speaking: "about Dana", "Ask Ravi", "told Ravi".
  new RegExp(`(?<![\\p{L}])(?:${["about", "with", "told", "asked", "from", "for", "tell", "ask", "call", "email", "meet", "meeting with"].map(w => `[${w[0].toUpperCase()}${w[0]}]${w.slice(1)}`).join("|")})\\s+(?!The\\b|A\\b|An\\b|This\\b|That\\b|My\\b|Your\\b|Our\\b|${["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday", "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"].join("\\b|")}\\b)\\p{Lu}\\p{Ll}{2,}`, "u"),
  loose(["私の妻", "私の夫", "息子", "娘", "मेरी पत्नी", "मेरे पति"]),
];

export function sensitiveReasons(text: string): AskReason[] {
  const out: AskReason[] = [];
  if (MONEY.some(rule => rule.test(text))) out.push("sensitive-money");
  if (HEALTH.some(rule => rule.test(text))) out.push("sensitive-health");
  if (SECRET.some(rule => rule.test(text))) out.push("sensitive-secret");
  if (PERSON.some(rule => rule.test(text))) out.push("sensitive-person");
  return out;
}

/** Scope kinds that are not one bot's own notes: they are read by more than one bot or person. */
function sharedScope(db: DatabaseSync, scopeId: string): boolean {
  const scope = db.prepare("SELECT kind,owner_key FROM memory_scopes WHERE id=?").get(scopeId);
  if (!scope) return true;
  const kind = String(scope.kind);
  if (kind === "conversation") return false;
  if (kind === "bot") return /#(?:general|team:|project:|room:)/.test(String(scope.owner_key));
  return true;
}

/** The evidence is still exactly what the owner would see: active sources at the recorded revision, not forgotten, spans inside the text. */
export function evidenceStillThere(db: DatabaseSync, id: string, version: number): boolean {
  const handles = db.prepare("SELECT source_id,source_revision,end_byte FROM memory_evidence WHERE record_id=? AND record_version=?").all(id, version);
  if (!handles.length) return false;
  for (const handle of handles) {
    const source = db.prepare("SELECT s.state,s.revision,v.payload FROM memory_sources s JOIN memory_source_versions v ON v.source_id=s.id AND v.revision=? WHERE s.id=?").get(handle.source_revision, handle.source_id);
    if (!source || source.state !== "active" || source.revision !== handle.source_revision) return false;
    if (db.prepare("SELECT 1 FROM memory_tombstones WHERE target_type='source' AND target_id=? AND (revision IS NULL OR revision=?)").get(handle.source_id, handle.source_revision)) return false;
    let text: unknown;
    try { text = JSON.parse(String(source.payload)).text; } catch { return false; }
    if (typeof text !== "string" || Number(handle.end_byte) > Buffer.byteLength(text)) return false;
  }
  return true;
}

export function memoryEligibility(db: DatabaseSync, row: EligibilityRow): Eligibility {
  const reasons: AskReason[] = [];
  if (isPipKind(row.kind)) reasons.push("identity");
  else if (db.prepare("SELECT 1 FROM memory_record_details WHERE record_id=? AND record_version=? AND partition='identity'").get(row.id, row.version)) reasons.push("identity");
  if (row.supersedes_id) {
    reasons.push("correction");
    const target = db.prepare("SELECT 1 FROM memory_records WHERE id=? AND owner_pinned=1 AND state='active'").get(row.supersedes_id);
    if (target) reasons.push("replaces-pinned");
  }
  if (row.owner_pinned === 1) reasons.push("replaces-pinned");
  // An owner edit saved as a new waiting version: the owner already decided its words, so it is theirs to keep.
  if (row.version > 1 && row.assertion === "owner-statement") reasons.push("edited");
  if (sharedScope(db, row.scope_id)) reasons.push("shared-space");
  reasons.push(...sensitiveReasons(row.text));
  if (!evidenceStillThere(db, row.id, row.version)) {
    // Evidence that is gone cannot be kept at all; the owner sees why instead of a silent miss.
    return { decision: "refuse", reasons: [...new Set([...reasons, "source-gone" as const])], ruleVersion: ELIGIBILITY_RULE_VERSION };
  }
  const unique = [...new Set(reasons)];
  return { decision: unique.length ? "ask" : "keep", reasons: unique, ruleVersion: ELIGIBILITY_RULE_VERSION };
}

/** The one log line per batch (PROPOSAL-v2 section 11, line 7): counts only. */
export function eligibilityLine(results: ReadonlyArray<Eligibility>): string {
  const count = (decision: Eligibility["decision"]) => results.filter(item => item.decision === decision).length;
  return `[memory] eligibility rule=${ELIGIBILITY_RULE_VERSION} keep=${count("keep")} ask=${count("ask")} refuse=${count("refuse")} unknown=0`;
}
