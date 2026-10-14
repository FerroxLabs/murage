// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Terms acceptance: which version of the Terms of Service and Privacy Policy
// this install's owner accepted, when, and in which app version.
//
// The record lives in DATA_DIR/terms-acceptance.json (owner-only, written
// through writeFileAtomic), never only in the browser, so it survives a
// reinstall of the app, a cleared browser and a second device. The renderer
// shows the acceptance screen until the current TERMS_VERSION (shared/terms.ts)
// is on record, and the server only records it; this file does not stop
// background work (routines, channels) for an install that has not accepted
// yet, so an update never silently halts someone's automations.
//
// HEADLESS AND CLOUD SETUPS. There is no screen to tick, so an operator who
// has accepted the terms for that install on the owner's behalf (or an
// automated test) sets MURAGE_TERMS_ACCEPTED=<TERMS_VERSION> in the server's
// environment. The status then reads accepted with source "environment" and
// nothing is written. It is deliberately not exposed in the app's UI, and it
// only counts when it names the exact current version.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PRIVACY_URL, TERMS_URL, TERMS_VERSION, type TermsStatus } from "../shared/terms.ts";
import { writeFileAtomic } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";

const FILE = "terms-acceptance.json";
const KEEP = 20;
const APP_VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,6}(?:-[0-9A-Za-z.]{1,16})?$/;
const TERMS_VERSION_SHAPE = /^\d{4}-\d{2}-\d{2}$/;

export interface TermsRecord {
  version: string;
  acceptedAt: string;
  appVersion?: string;
}

function isRecordShape(value: unknown): value is TermsRecord {
  if (!value || typeof value !== "object") return false;
  const raw = value as Record<string, unknown>;
  return typeof raw.version === "string" && TERMS_VERSION_SHAPE.test(raw.version)
    && typeof raw.acceptedAt === "string" && !Number.isNaN(Date.parse(raw.acceptedAt));
}

/** Every acceptance on record, oldest first. A missing or damaged file reads
 * as none, which asks the owner again, the right way round for a legal record. */
export function readTermsRecords(dir: string = DATA_DIR): TermsRecord[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dir, FILE), "utf8"));
    const list = parsed && typeof parsed === "object" && Array.isArray((parsed as { accepted?: unknown }).accepted)
      ? (parsed as { accepted: unknown[] }).accepted : [];
    return list.filter(isRecordShape).map((entry) => ({
      version: entry.version,
      acceptedAt: entry.acceptedAt,
      ...(typeof entry.appVersion === "string" && APP_VERSION.test(entry.appVersion) ? { appVersion: entry.appVersion } : {}),
    }));
  } catch {
    return [];
  }
}

export function termsStatus(dir: string = DATA_DIR, env: NodeJS.ProcessEnv = process.env): TermsStatus {
  if (env.MURAGE_TERMS_ACCEPTED === TERMS_VERSION) return { version: TERMS_VERSION, accepted: true, source: "environment" };
  const records = readTermsRecords(dir);
  const current = records.find((entry) => entry.version === TERMS_VERSION);
  if (current) return { version: TERMS_VERSION, accepted: true, acceptedVersion: current.version, acceptedAt: current.acceptedAt, source: "record" };
  const last = records.at(-1);
  return { version: TERMS_VERSION, accepted: false, ...(last ? { acceptedVersion: last.version, acceptedAt: last.acceptedAt } : {}) };
}

export function recordTermsAcceptance(
  input: { appVersion?: string },
  dir: string = DATA_DIR,
  now: () => Date = () => new Date(),
): TermsStatus {
  const records = readTermsRecords(dir).filter((entry) => entry.version !== TERMS_VERSION);
  const entry: TermsRecord = {
    version: TERMS_VERSION,
    acceptedAt: now().toISOString(),
    ...(input.appVersion && APP_VERSION.test(input.appVersion) ? { appVersion: input.appVersion } : {}),
  };
  const accepted = [...records, entry].slice(-KEEP);
  writeFileAtomic(join(dir, FILE), JSON.stringify({ accepted, termsUrl: TERMS_URL, privacyUrl: PRIVACY_URL }, null, 2) + "\n", { mode: 0o600 });
  return termsStatus(dir, {});
}

type ApiAnswer = { status: number; body: unknown };

export async function handleTermsApi(
  request: { method: string; path: string; readBody: () => Promise<unknown> },
  dir: string = DATA_DIR,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ApiAnswer | null> {
  const { method, path } = request;
  if (path === "/api/terms" && method === "GET") return { status: 200, body: termsStatus(dir, env) };
  if (path === "/api/terms/accept" && method === "POST") {
    let body: unknown;
    try {
      body = await request.readBody();
    } catch {
      return { status: 400, body: { error: "The request could not be read. Try again." } };
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) return { status: 400, body: { error: "Send { version, ageConfirmed }." } };
    const { version, ageConfirmed, appVersion, ...rest } = body as Record<string, unknown>;
    if (Object.keys(rest).length) return { status: 400, body: { error: `Unknown field: ${Object.keys(rest)[0]}` } };
    if (ageConfirmed !== true) return { status: 400, body: { error: "Confirm that you are 18 or older and agree to the terms." } };
    // An older screen left open across an update must not accept newer terms it never showed.
    if (version !== TERMS_VERSION) return { status: 409, body: { error: "The terms were updated. Reload Murage to read them.", version: TERMS_VERSION } };
    if (appVersion !== undefined && (typeof appVersion !== "string" || !APP_VERSION.test(appVersion))) {
      return { status: 400, body: { error: "appVersion must look like 1.0.2." } };
    }
    return { status: 200, body: recordTermsAcceptance({ appVersion: appVersion as string | undefined }, dir) };
  }
  if (path === "/api/terms" || path === "/api/terms/accept") return { status: 405, body: { error: "method not allowed" } };
  return null;
}
