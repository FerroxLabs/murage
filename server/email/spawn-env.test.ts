// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Bot email keys never reach an engine (BOT-EMAIL-MURAGE-109 2.3, 2.4): no driver env holds an email:bot key or the email:owner token.
// Compared by fingerprint only; no test prints or asserts a value.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyEmailShellMessage, EMAIL_OWNER_MESSAGE, EMAIL_SECRETS_ENV, EMAIL_SECRETS_SAVE, EmailSecretStore, credentialFingerprint, type EmailSecretsDoc } from "./email-secrets.ts";
import { stripWorkspaceCredentialEnv, WORKSPACE_CREDENTIAL_ENV } from "../config.ts";
import { claudeEnvironment } from "../drivers/claude.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const DOC = { owner: { token: "fx-email-owner-0123456789abcdef", keyId: "key_owner" }, bots: { b1: { token: "fx-email-bot-b1-0123456789abcdef", keyId: "key_b1" } } }; // secret-scan: fixture (fake tokens, compared by fingerprint only)

/** Every fingerprint of every word of every value in an env. */
function envFingerprints(env: Record<string, string | undefined>): Set<string> {
  const out = new Set<string>();
  for (const value of Object.values(env)) {
    if (typeof value !== "string") continue;
    out.add(credentialFingerprint(value));
    for (const word of value.split(/[^A-Za-z0-9_.-]+/)) if (word) out.add(credentialFingerprint(word));
  }
  return out;
}

describe("email keys stay out of every spawned engine", () => {
  it("the shell's hand-off is read once and removed; its name is a workspace credential every driver strips", () => {
    const env: NodeJS.ProcessEnv = { [EMAIL_SECRETS_ENV]: JSON.stringify(DOC), PATH: "/bin" };
    const secrets = new EmailSecretStore();
    expect(secrets.loadFromEnv(env)).toEqual({ loaded: 2 });
    expect(env[EMAIL_SECRETS_ENV]).toBeUndefined();
    expect(WORKSPACE_CREDENTIAL_ENV).toContain(EMAIL_SECRETS_ENV);
    const late: Record<string, string | undefined> = { [EMAIL_SECRETS_ENV]: JSON.stringify(DOC), HOME: "/home/x" };
    stripWorkspaceCredentialEnv(late);
    expect(late[EMAIL_SECRETS_ENV]).toBeUndefined();
  });

  it("Claude's turn env, built from a parent that still had the hand-off, carries no email key (by fingerprint)", () => {
    const secrets = new EmailSecretStore();
    secrets.replaceAll(DOC);
    const parent: NodeJS.ProcessEnv = { ...process.env, [EMAIL_SECRETS_ENV]: JSON.stringify(DOC) };
    const env = claudeEnvironment(null, parent);
    expect(env[EMAIL_SECRETS_ENV]).toBeUndefined();
    const seen = envFingerprints(env);
    expect(secrets.fingerprints()).toHaveLength(2);
    for (const fingerprint of secrets.fingerprints()) expect(seen.has(fingerprint)).toBe(false);
  });

  it("every driver that spawns an engine strips the workspace credentials, and no ACP credential allowlist names the email hand-off", () => {
    const drivers = ["server/drivers/claude.ts", "server/drivers/codex.ts", "server/drivers/pi.ts", "server/drivers/antigravity.ts", "server/drivers/acp/core.ts"];
    for (const file of drivers) expect(readFileSync(join(ROOT, file), "utf8"), file).toMatch(/WORKSPACE_CREDENTIAL_ENV|stripWorkspaceCredentialEnv|childEnv\(/);
    const acp = join(ROOT, "server", "drivers", "acp");
    for (const name of readdirSync(acp).filter(file => file.endsWith(".ts") && !file.endsWith(".test.ts"))) {
      const source = readFileSync(join(acp, name), "utf8");
      for (const match of source.matchAll(/credentialEnv:\s*\[([^\]]*)\]/g)) expect(match[1], name).not.toMatch(/EMAIL/);
    }
  });

  it("the agents integration env names the email mode only, never a key, and the proxy reads no key", () => {
    const index = readFileSync(join(ROOT, "server", "index.ts"), "utf8");
    const start = index.indexOf("function agentsIntegration(");
    const block = index.slice(start, index.indexOf("\n}\n", start));
    expect(block).toContain("[EMAIL_TOOLS_ENV]: emailMode");
    expect(block).not.toMatch(/EMAIL_SECRETS|secrets|botKey|owner\(\)/);
    const proxy = readFileSync(join(ROOT, "server", "drivers", "agents-proxy.ts"), "utf8");
    expect(proxy).not.toMatch(/MURAGE_EMAIL_SECRETS|EMAIL_SECRETS_ENV/);
  });

  it("2.4: the owner token main hands over is stored, handed back for the encrypted store, and still never reaches an engine env", () => {
    const saved: EmailSecretsDoc[] = [];
    const secrets = new EmailSecretStore(doc => saved.push(doc));
    expect(applyEmailShellMessage(secrets, { type: "murage:model-signin-refresh" })).toBe(false);
    expect(applyEmailShellMessage(secrets, { type: EMAIL_OWNER_MESSAGE, owner: { token: "has space", keyId: "k" } })).toBe(true);
    expect(secrets.owner()).toBeNull();
    expect(applyEmailShellMessage(secrets, { type: EMAIL_OWNER_MESSAGE, owner: DOC.owner })).toBe(true);
    expect(secrets.owner()?.keyId).toBe("key_owner");
    expect(saved.at(-1)?.owner?.keyId).toBe("key_owner");
    const env = claudeEnvironment(null, { ...process.env });
    expect(envFingerprints(env).has(credentialFingerprint(DOC.owner.token))).toBe(false);
  });

  it("index.ts persists key changes to the shell, takes the owner hand-off before any other private message, and fluxKey never reads email", () => {
    const index = readFileSync(join(ROOT, "server", "index.ts"), "utf8");
    expect(index).toMatch(/persistSecrets: doc => \{ postDesktopPrivateMessage\(\{ type: EMAIL_SECRETS_SAVE, doc \}\); \}/);
    expect(index).toContain("if (isEmailShellMessage(message))");
    expect(EMAIL_SECRETS_SAVE).toBe("murage:email-secrets-save");
    const fluxConfig = readFileSync(join(ROOT, "server", "flux-config.ts"), "utf8");
    expect(fluxConfig).not.toMatch(/email-secrets|EmailSecret|MURAGE_EMAIL/);
    // the desktop shell feeds MURAGE_EMAIL_SECRETS to the server and saves what the server sends back
    const shell = readFileSync(join(ROOT, "electron", "workspace-credentials.mjs"), "utf8");
    expect(shell).toContain("env.MURAGE_EMAIL_SECRETS = email");
    const main = readFileSync(join(ROOT, "electron", "main.mjs"), "utf8");
    expect(main).toContain("if (isEmailSecretsSave(message))");
    expect(main).toContain('ipcMain.handle("email-owner-signin:start"');
  });
});
