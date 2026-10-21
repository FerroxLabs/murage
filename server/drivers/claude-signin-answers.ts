// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WIN-NOBASH-DESIGN-r2 14.5: the owner's remembered answers to the Claude sign-in card.
//
// Without this the card asked on every turn in a repository whose .claude/settings.json (or settings.local.json) names a sign-in
// setting, so a routine or an unattended bot there was refused once the question timed out. The owner's Allow or Don't allow is
// remembered for the exact repository settings files that raised it AND the exact sign-in names and values they set:
//   - the key is an HMAC of the files' paths, the fingerprint an HMAC of the canonical sorted name=value set (claudeSigninScope),
//     both with a per-install secret salt; no path, name or value is stored in plain text;
//   - a different file, or any change to those names or values, asks again (one entry per key, replaced on the new answer);
//   - a remembered Don't allow refuses the turn with the plain message and no card;
//   - only the owner's own answer is remembered: a timeout, a Stop or a prewarm never is.
// One owner-only JSON file in the data folder (0600 in a 0700 folder), replaced by write-then-rename, at most MAX entries (the
// oldest answer goes first).
import { createHmac, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const CLAUDE_SIGNIN_ANSWERS_FILE = "claude-signin-answers.json";
export const CLAUDE_SIGNIN_ANSWERS_MAX = 256;

/** What a hold is about: the repository settings files that raised it and their sign-in names and values, canonical. Values are
 * in `canonical`, so a scope is never logged; the store keeps only HMACs of it. */
export interface ClaudeSigninScope { files: string[]; canonical: string }

interface StoredAnswer { key: string; fingerprint: string; allowed: boolean; at: number }

const HEX64 = /^[a-f0-9]{64}$/;

export class ClaudeSigninAnswers {
  private readonly path: () => string;
  private readonly now: () => number;
  private loadedFrom: string | null = null;
  private salt = "";
  private answers: StoredAnswer[] = [];

  constructor(path: () => string, now: () => number = Date.now) {
    this.path = path;
    this.now = now;
  }

  private load(): void {
    const file = this.path();
    if (this.loadedFrom === file) return;
    this.loadedFrom = file;
    this.salt = "";
    this.answers = [];
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as { salt?: unknown; answers?: unknown };
      if (typeof parsed.salt === "string" && HEX64.test(parsed.salt)) this.salt = parsed.salt;
      if (this.salt && Array.isArray(parsed.answers)) {
        this.answers = parsed.answers.filter((a): a is StoredAnswer => !!a && typeof a === "object"
          && HEX64.test(String((a as StoredAnswer).key)) && HEX64.test(String((a as StoredAnswer).fingerprint))
          && typeof (a as StoredAnswer).allowed === "boolean" && typeof (a as StoredAnswer).at === "number").slice(-CLAUDE_SIGNIN_ANSWERS_MAX);
      }
    } catch { /* none yet, or unreadable: ask */ }
    if (!this.salt) {
      this.salt = randomBytes(32).toString("hex");
      this.answers = [];
    }
  }

  private save(): void {
    const file = this.path();
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
    writeFileSync(tmp, JSON.stringify({ v: 1, salt: this.salt, answers: this.answers }), { mode: 0o600, flag: "wx" });
    try { chmodSync(tmp, 0o600); } catch { /* best effort on filesystems without modes */ }
    renameSync(tmp, file);
  }

  private mac(kind: string, text: string): string {
    return createHmac("sha256", this.salt).update(`${kind}\u0000${text}`).digest("hex");
  }

  private keyOf(scope: ClaudeSigninScope): string {
    return this.mac("files", JSON.stringify([...scope.files].sort()));
  }

  /** The owner's remembered answer for exactly this scope: true (Allow), false (Don't allow), or undefined (ask). */
  recall(scope: ClaudeSigninScope): boolean | undefined {
    this.load();
    const key = this.keyOf(scope);
    const hit = this.answers.find((answer) => answer.key === key);
    return hit && hit.fingerprint === this.mac("set", scope.canonical) ? hit.allowed : undefined;
  }

  /** Remembers the owner's own answer for this scope, replacing any earlier answer for the same files. */
  remember(scope: ClaudeSigninScope, allowed: boolean): void {
    this.load();
    const key = this.keyOf(scope);
    this.answers = this.answers.filter((answer) => answer.key !== key);
    this.answers.push({ key, fingerprint: this.mac("set", scope.canonical), allowed, at: this.now() });
    if (this.answers.length > CLAUDE_SIGNIN_ANSWERS_MAX) this.answers = this.answers.slice(-CLAUDE_SIGNIN_ANSWERS_MAX);
    try {
      this.save();
    } catch {
      console.warn("claude sign-in answer not saved: the data folder could not be written (the card will ask again)");
    }
  }
}
