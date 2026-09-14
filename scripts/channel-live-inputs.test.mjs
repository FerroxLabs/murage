import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { loadSecrets, ManifestError, validateManifest } from "./channel-live-inputs.ts";

const TELEGRAM_TOKEN = "4242:qualification_secret_not_real_ABCDEFGH";
const TELEGRAM_OTHER = "4242:qualification_secret_other_ABCDEFGHIJ";
const SLACK_APP = "xapp-1-AQUAL-1234567890-qualificationsecretnotreal";
const SLACK_BOT = "xoxb-1-QUALIFICATIONSECRET-notreal";
const DISCORD_BOT_USER = "123456789012";
const DISCORD_TOKEN = `${Buffer.from(DISCORD_BOT_USER).toString("base64url")}.QUALIF.qualification_secret_not_real_x`;
const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

// Case-insensitive volumes (default macOS/Windows) let a differently-cased path name the same file.
const caseProbe = mkdtempSync(join(tmpdir(), "channel-live-CaseProbe-"));
const caseInsensitive = existsSync(caseProbe.toLowerCase()) && existsSync(caseProbe.toUpperCase());
rmSync(caseProbe, { recursive: true, force: true });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "channel-live-inputs-")); roots.push(root);
  const repo = join(root, "repo"), secrets = join(root, "secrets");
  mkdirSync(repo); mkdirSync(secrets, { mode: 0o700 });
  const secret = (name, value, mode = 0o600, dir = secrets) => { const file = join(dir, name); writeFileSync(file, value + "\n"); chmodSync(file, mode); return file; };
  const context = { repoRoot: repo, hostname: "qualification-host" };
  const base = { version: 1, authorityReference: "Owner approval ref Q-1", dedicated: true, testHostname: "qualification-host",
    limits: { maxOperatorMessages: 6, maxOutboundMessages: 6, maxMinutes: 30 } };
  const telegram = (tokenFile = secret("tg", TELEGRAM_TOKEN)) => ({ ...base, platform: "telegram", telegram: { botId: "4242", botUsername: "qual_test_bot", ownerUserId: "5151", tokenFile } });
  const slack = (appId = "AQUAL") => ({ ...base, platform: "slack", slack: { teamId: "TQUAL", appId, botUserId: "UBOTQ", botId: "BBOTQ", ownerUserId: "UOWNQ",
    appTokenFile: secret("app", SLACK_APP), botTokenFile: secret("bot", SLACK_BOT) } });
  const discord = (botUserId = DISCORD_BOT_USER) => ({ ...base, platform: "discord", discord: { applicationId: "1111111111", botUserId, ownerUserId: "3333333333",
    tokenFile: secret("dc", DISCORD_TOKEN) } });
  return { root, repo, secrets, secret, context, base, telegram, slack, discord };
}

const refusal = (fn) => { try { fn(); } catch (error) { expect(error).toBeInstanceOf(ManifestError); return error; } throw new Error("expected refusal"); };
const noSecrets = (error) => { for (const value of [TELEGRAM_TOKEN, TELEGRAM_OTHER, SLACK_APP, SLACK_BOT, DISCORD_TOKEN]) expect(error.message).not.toContain(value); };

it("accepts a dedicated manifest for each platform and returns a redacted plan", () => {
  const f = fixture();
  const telegram = validateManifest(f.telegram(), f.context);
  expect(telegram.plan).toMatchObject({ platform: "telegram", credentialFiles: { "telegram.tokenFile": "validated" }, budget: { plannedOperator: 4, plannedOutbound: 3 } });
  const slack = validateManifest(f.slack(), f.context);
  const discord = validateManifest(f.discord(), f.context);
  for (const result of [telegram, slack, discord]) {
    const json = JSON.stringify(result.plan);
    for (const value of [TELEGRAM_TOKEN, SLACK_APP, SLACK_BOT, DISCORD_TOKEN, f.secrets]) expect(json).not.toContain(value);
  }
  expect(discord.plan.identities.ownerUserId).not.toBe("3333333333");
  expect(loadSecrets(telegram.manifest, f.context)).toEqual({ MURAGE_TELEGRAM_BOT_TOKEN: TELEGRAM_TOKEN });
  expect(Object.keys(loadSecrets(slack.manifest, f.context))).toEqual(["MURAGE_SLACK_APP_TOKEN", "MURAGE_SLACK_BOT_TOKEN"]);
});

it("refuses a credential file with a broader mode", () => {
  const f = fixture(), manifest = f.telegram(); chmodSync(manifest.telegram.tokenFile, 0o644);
  const error = refusal(() => validateManifest(manifest, f.context));
  expect(error.message).toContain("mode 0600"); noSecrets(error);
});

it("refuses a symbolic link to a credential", () => {
  const f = fixture(), target = f.secret("tg", TELEGRAM_TOKEN), link = join(f.secrets, "link"); symlinkSync(target, link);
  const error = refusal(() => validateManifest(f.telegram(link), f.context));
  expect(error.message).toContain("symbolic link"); noSecrets(error);
});

it("refuses a credential stored inside the repository checkout", () => {
  const f = fixture();
  const error = refusal(() => validateManifest(f.telegram(f.secret("tg-in-repo", TELEGRAM_TOKEN, 0o600, f.repo)), f.context));
  expect(error.message).toContain("outside the repository"); noSecrets(error);
});

it("refuses a '..'-prefixed directory that is still inside the repository", () => {
  const f = fixture(), dotted = join(f.repo, "..secrets"); mkdirSync(dotted, { mode: 0o700 });
  const error = refusal(() => validateManifest(f.telegram(f.secret("tg", TELEGRAM_TOKEN, 0o600, dotted)), f.context));
  expect(error.message).toContain("outside the repository"); noSecrets(error);
});

it.skipIf(!caseInsensitive)("refuses a differently-cased path into the repository (case-insensitive volumes only)", () => {
  const f = fixture(); f.secret("tg-case", TELEGRAM_TOKEN, 0o600, f.repo);
  const variant = join(f.root, "REPO", "tg-case");
  expect(existsSync(variant)).toBe(true);
  const error = refusal(() => validateManifest(f.telegram(variant), f.context));
  expect(error.message).toContain("outside the repository"); noSecrets(error);
});

it("refuses a credential with another hard link", () => {
  const f = fixture(), file = f.secret("tg", TELEGRAM_TOKEN); linkSync(file, join(f.root, "hardlink-copy"));
  const error = refusal(() => validateManifest(f.telegram(file), f.context));
  expect(error.message).toContain("hard links"); noSecrets(error);
});

it("refuses a file swapped after its checks, whether replaced or turned into a link", () => {
  const f = fixture(), file = f.secret("tg", TELEGRAM_TOKEN), other = f.secret("tg-other", TELEGRAM_OTHER);
  const replaced = refusal(() => validateManifest(f.telegram(file), { ...f.context, afterPathCheck: path => renameSync(other, path) }));
  expect(replaced.message).toContain("changed while it was being checked"); noSecrets(replaced);
  const file2 = f.secret("tg2", TELEGRAM_TOKEN), target = f.secret("tg-target", TELEGRAM_OTHER);
  const linked = refusal(() => validateManifest(f.telegram(file2), { ...f.context, afterPathCheck: path => { unlinkSync(path); symlinkSync(target, path); } }));
  expect(linked.message).toContain("changed while it was being checked"); noSecrets(linked);
});

it("refuses a different test host", () => {
  const f = fixture();
  expect(refusal(() => validateManifest(f.telegram(), { ...f.context, hostname: "production-laptop" })).message).toContain("testHostname");
});

it("refuses an identity on the production denylist, including credential-derived identities", () => {
  const f = fixture();
  expect(refusal(() => validateManifest({ ...f.telegram(), denylistIdentityIds: ["4242"] }, f.context)).message).toContain("denylist");
  expect(refusal(() => validateManifest({ ...f.discord(), denylistIdentityIds: [DISCORD_BOT_USER] }, f.context)).message).toContain("denylist");
});

it("refuses credentials that belong to a different identity than the manifest names", () => {
  const f = fixture();
  const telegram = refusal(() => validateManifest({ ...f.telegram(), telegram: { ...f.telegram().telegram, botId: "9999" } }, f.context));
  expect(telegram.message).toContain("telegram.tokenFile belongs to a different identity than telegram.botId"); noSecrets(telegram);
  const discord = refusal(() => validateManifest(f.discord("2222222222"), f.context));
  expect(discord.message).toContain("discord.tokenFile belongs to a different identity than discord.botUserId"); noSecrets(discord);
  const slack = refusal(() => validateManifest(f.slack("AOTHER"), f.context));
  expect(slack.message).toContain("slack.appTokenFile belongs to a different identity than slack.appId"); noSecrets(slack);
});

it("refuses a malformed token without echoing it", () => {
  const f = fixture();
  const error = refusal(() => validateManifest(f.telegram(f.secret("wrong", SLACK_BOT)), f.context));
  expect(error.message).toContain("does not look like a Telegram bot token"); noSecrets(error);
  const discordError = refusal(() => validateManifest({ ...f.discord(), discord: { ...f.discord().discord, tokenFile: f.secret("dc-wrong", TELEGRAM_TOKEN) } }, f.context));
  noSecrets(discordError);
});

it("refuses a non-dedicated identity", () => {
  const f = fixture();
  expect(refusal(() => validateManifest({ ...f.telegram(), dedicated: false }, f.context)).message).toContain("dedicated");
});

it("refuses budgets above the cap or below the planned message sequence", () => {
  const f = fixture();
  expect(refusal(() => validateManifest({ ...f.telegram(), limits: { maxOperatorMessages: 11, maxOutboundMessages: 6, maxMinutes: 30 } }, f.context)).message).toContain("maxOperatorMessages");
  expect(refusal(() => validateManifest({ ...f.telegram(), limits: { maxOperatorMessages: 6, maxOutboundMessages: 6, maxMinutes: 90 } }, f.context)).message).toContain("maxMinutes");
  expect(refusal(() => validateManifest({ ...f.telegram(), limits: { maxOperatorMessages: 2, maxOutboundMessages: 6, maxMinutes: 30 } }, f.context)).message).toContain("planned operator messages");
});
