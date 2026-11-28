// M9 witnesses (BEDROCK-ENGINE-1023 r2 section 7), pure layer: env Delete/Set, R7, errors, redaction, binding decode, import allowlist.
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import ts from "typescript";
import {
  applyBedrockEnv, bedrockDeleteNames, bedrockErrorRowText, bedrockFrameApplies, bedrockIsLimit, bedrockRedact, bedrockSet, bedrockSettingsRefusal,
  classifyBedrockError, classifyBedrockName, decodeBedrockBinding, readBedrockSettings, bedrockCommandsSentence, bedrockSaveLine,
} from "./bedrock-env.ts";
import { bedrockInfo } from "./claude-accounts.ts";
import { withOfflineInstallation } from "./installation-database-snapshot.ts";
import { stageInstallationStateWhileOwned } from "./installation-state-snapshot.ts";
import { inventoryFidelity } from "./installation-fidelity-snapshot.ts";
import { backupFixture } from "./testing/backup-fixture.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
import { claudeAllowlistEnv } from "./drivers/headless-text-only.ts";

const files = { configFile: "/h/.aws/config", credentialsFile: "/h/.aws/credentials" };
const binding = { profile: "p", region: "us-east-1" };

describe("W1 env: Delete then Set (account- and endpoint-changing names only)", () => {
  const owner = () => ({
    AWS_ROLE_ARN: "arn:aws:iam::1:role/x", AWS_ENDPOINT_URL: "http://localstack.test", CLAUDE_CODE_USE_MANTLE: "1", AWS_ACCESS_KEY_ID: "k", AWS_SECRET_ACCESS_KEY: "s",
    AWS_BEARER_TOKEN_BEDROCK: "b", ANTHROPIC_API_KEY: "a", AWS_ENDPOINT_URL_BEDROCK_RUNTIME: "http://x.test", AWS_PROFILE: "work", AWS_REGION: "eu-west-1",
    HTTPS_PROXY: "http://proxy.test:3128", ANTHROPIC_DEFAULT_HAIKU_MODEL: "fixture-profile-id", PATH: "/bin",
  } as Record<string, string | undefined>);
  const routing = (name: string) => /^(ANTHROPIC_API_KEY|CLAUDE_CODE_USE_MANTLE)$/.test(name);
  it("W1 deletes the routing names and sets the Bedrock names; W20 keeps proxy and model names", () => {
    const m = owner();
    applyBedrockEnv(m, binding, files, routing);
    for (const name of ["AWS_ROLE_ARN", "AWS_ENDPOINT_URL", "CLAUDE_CODE_USE_MANTLE", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_BEARER_TOKEN_BEDROCK", "ANTHROPIC_API_KEY", "AWS_ENDPOINT_URL_BEDROCK_RUNTIME"])
      expect(m[name], `${name} left the Bedrock env`).toBeUndefined(); // W1-delete
    expect(m.CLAUDE_CODE_USE_BEDROCK, "W1 use bedrock").toBe("1"); // W1-set
    expect(m.AWS_PROFILE).toBe("p");
    expect(m.AWS_REGION).toBe("us-east-1");
    expect(m.AWS_CONFIG_FILE).toBe(files.configFile);
    expect(m.HTTPS_PROXY, "W20 proxy kept").toBe("http://proxy.test:3128"); // W20-keep
    expect(m.ANTHROPIC_DEFAULT_HAIKU_MODEL, "W20 model kept").toBe("fixture-profile-id");
    expect(m.PATH).toBe("/bin");
  });
  it("Set runs after the strip: CLAUDE_CODE_USE_BEDROCK survives a strip that deletes it (the three strip sites)", () => {
    const m: Record<string, string | undefined> = { CLAUDE_CODE_USE_BEDROCK: "0" };
    delete m.CLAUDE_CODE_USE_BEDROCK; // stripClaudeOwnedEnv
    bedrockSet(m, binding, files);
    expect(m.CLAUDE_CODE_USE_BEDROCK, "W1 set after strip").toBe("1"); // W1-order
  });
  it("an untagged routing name counts as Delete; a non-routing name is left alone; a non-AWS provider name is dropped silently", () => {
    expect(classifyBedrockName("CLAUDE_CODE_FUTURE_THING", true)).toBe("delete");
    expect(classifyBedrockName("CLAUDE_CODE_FUTURE_THING", false)).toBe("free");
    expect(classifyBedrockName("OPENAI_API_KEY", false)).toBe("free");
    expect(classifyBedrockName("ANTHROPIC_VERTEX_PROJECT_ID", true)).toBe("ignore");
    const m: Record<string, string | undefined> = { ANTHROPIC_VERTEX_PROJECT_ID: "v", VERTEX_REGION_CLAUDE_HAIKU: "x", OPENAI_API_KEY: "o" };
    bedrockDeleteNames(m, () => true);
    expect(Object.keys(m)).toEqual(["OPENAI_API_KEY"].filter(() => false));
  });
});

describe("W18 text-only runs keep the Bedrock Set (a text-only run never runs first-party)", () => {
  it("the allowlist env carries the Set and the keep names on a Bedrock instance and nothing AWS-ish otherwise", () => {
    const temp = { root: "/tmp/r", home: "/tmp/r/h" } as never;
    const bedrock = claudeAllowlistEnv({ PATH: "/bin", CLAUDE_CODE_USE_BEDROCK: "1", AWS_PROFILE: "p", AWS_REGION: "us-east-1", AWS_CONFIG_FILE: "/h/.aws/config", HTTPS_PROXY: "http://proxy.test:3128", AWS_ACCESS_KEY_ID: "x-never-set-here", OPENAI_API_KEY: "o" } as never, temp, 100);
    expect(bedrock.CLAUDE_CODE_USE_BEDROCK, "W18 text-only keeps the engine switch").toBe("1"); // W18-text
    expect(bedrock.AWS_PROFILE).toBe("p");
    expect(bedrock.AWS_CONFIG_FILE).toBe("/h/.aws/config");
    expect(bedrock.HTTPS_PROXY).toBe("http://proxy.test:3128");
    expect(bedrock.OPENAI_API_KEY, "other names still dropped").toBeUndefined();
    expect(bedrock.AWS_ACCESS_KEY_ID, "a credential name is not a Set or keep name").toBeUndefined();
    const plain = claudeAllowlistEnv({ PATH: "/bin", AWS_PROFILE: "p" } as never, temp, 100);
    expect(plain.AWS_PROFILE, "a non-Bedrock instance is unchanged").toBeUndefined();
  });
});

describe("W2 / W17 / W20 R7: settings files cannot redirect (identity refusal, no noLimits argument)", () => {
  const dir = mkdtempSync(join(tmpdir(), "bedrock-r7-"));
  const write = (name: string, doc: unknown) => { const p = join(dir, name); writeFileSync(p, typeof doc === "string" ? doc : JSON.stringify(doc)); return p; };
  const hand = { ...Object.fromEntries(Object.entries({ AWS_PROFILE: "p", AWS_REGION: "us-east-1", CLAUDE_CODE_USE_BEDROCK: "1", AWS_DEFAULT_REGION: "us-east-1", AWS_EC2_METADATA_DISABLED: "true", AWS_CONFIG_FILE: files.configFile, AWS_SHARED_CREDENTIALS_FILE: files.credentialsFile })) };
  const routing = (name: string) => /^(AWS_|CLAUDE_CODE_USE_|HTTPS_PROXY|NODE_EXTRA|ANTHROPIC_)/.test(name);
  const refusal = (...docs: unknown[]) => bedrockSettingsRefusal(docs.map((d, i) => readBedrockSettings(write(`s${i}-${Math.random()}.json`, d as never))), hand, routing);
  it("W2 a Set or Delete name with a value other than the hand's is R7; the same value is not", () => {
    expect(refusal({ env: { AWS_PROFILE: "other" } })?.name, "W2 profile").toBe("AWS_PROFILE");
    expect(refusal({ env: { AWS_REGION: "eu-west-9" } })?.name).toBe("AWS_REGION");
    expect(refusal({ env: { CLAUDE_CODE_USE_BEDROCK: "0" } })?.name).toBe("CLAUDE_CODE_USE_BEDROCK");
    expect(refusal({ env: { AWS_ENDPOINT_URL_BEDROCK_RUNTIME: "http://x.test" } })?.name, "W2 endpoint (Delete names are absent from the hand)").toBe("AWS_ENDPOINT_URL_BEDROCK_RUNTIME");
    expect(refusal({ env: { AWS_PROFILE: "p" } }), "W2 same value").toBeNull();
  });
  it("W17 the three helper keys are R7, and the text names the file", () => {
    for (const key of ["apiKeyHelper", "awsCredentialExport", "awsAuthRefresh"]) expect(refusal({ [key]: "x" })?.name, `W17 ${key}`).toBe(key);
    const r = refusal({ awsAuthRefresh: "aws sso login" });
    expect(r?.text).toContain("sets awsAuthRefresh");
    expect(r?.text).toContain("Nothing was sent");
  });
  it("W20 proxy, CA and model names never cause R7 (keep tag); a Vertex name is dropped, not refused", () => {
    expect(refusal({ env: { HTTPS_PROXY: "http://proxy.test:3128", NODE_EXTRA_CA_CERTS: "/fixture/ca.pem", ANTHROPIC_DEFAULT_HAIKU_MODEL: "fixture-id" } }), "W20 keep").toBeNull(); // W20-R7
    expect(refusal({ env: { ANTHROPIC_VERTEX_PROJECT_ID: "team", CLOUD_ML_REGION: "x", GOOGLE_APPLICATION_CREDENTIALS: "/x" } }), "L2 vertex names").toBeNull();
  });
  it("M3 a settings file that exists and cannot be checked is R7 (also under No limits: there is no noLimits argument)", () => {
    const bad = write("bad.json", "{not json");
    expect(bedrockSettingsRefusal([readBedrockSettings(bad)], hand, routing)?.text, "M3 cannot check").toContain("cannot check"); // M3
    expect(bedrockSettingsRefusal([readBedrockSettings(join(dir, "missing.json"))], hand, routing), "a missing file is empty").toBeNull();
  });
  it("cleanup", () => rmSync(dir, { recursive: true, force: true }));
});

describe("section 4 errors, W8b, W11, W26, W27", () => {
  const ctx = { accountId: "123456789012", region: "us-east-1", profile: "work-dev" };
  it("W11 each table row, with the catch-all for an unmatched 403", () => {
    expect(classifyBedrockError("AccessDeniedException: You don't have access to the model with the specified model ID")).toBe("access-denied");
    expect(classifyBedrockError("ValidationException: The provided model identifier is invalid")).toBe("validation");
    expect(classifyBedrockError("ExpiredTokenException: The security token included in the request is expired"), "W11 expired").toBe("expired"); // W11-expired
    expect(classifyBedrockError("The SSO session associated with this profile has expired or is otherwise invalid")).toBe("expired");
    expect(classifyBedrockError("ThrottlingException: Too many requests")).toBe("throttled");
    expect(classifyBedrockError("The security token included in the request is invalid"), "W11 403 catch-all").toBe("other"); // W11-403
    expect(bedrockErrorRowText("access-denied", ctx, "")).toBe("Your AWS account …9012 has no access to this model in us-east-1. Turn it on under Model access in the Bedrock console, then send again.");
    expect(bedrockErrorRowText("expired", ctx, "")).toContain("aws sso login --profile work-dev");
    expect(bedrockErrorRowText("other", ctx, "The security token included in the request is invalid")).toContain("Bedrock refused this message for AWS account …9012");
  });
  it("W26 only throttling and quota count as a limit", () => {
    expect(bedrockIsLimit(classifyBedrockError("ThrottlingException"))).toBe(true);
    expect(bedrockIsLimit(classifyBedrockError("ServiceQuotaExceededException"))).toBe(true);
    for (const t of ["ExpiredTokenException", "AccessDeniedException model", "403 Forbidden"]) expect(bedrockIsLimit(classifyBedrockError(t)), `W26 ${t}`).toBe(false); // W26
  });
  it("W11 / W26 the texts Claude Code relays on Bedrock (`API Error: <status> <AWS message>`, no exception name) get the same rows", () => {
    for (const t of ["API Error: 429 Too many tokens, please wait before trying again.", "API Error: 429 Too many requests, please wait before trying again.", "API Error (429 Too many tokens, please wait before trying again.)", "Too many tokens per day, please wait before trying again."])
      expect(classifyBedrockError(t), t).toBe("throttled"); // W26-relayed-limit
    expect(classifyBedrockError("API Error: 403 The security token included in the request is expired")).toBe("expired"); // W11-relayed-expired
    expect(classifyBedrockError("API Error: 403 You don't have access to the model with the specified model ID.")).toBe("access-denied"); // W11-relayed-denied
    for (const t of ["API Error: 403 The security token included in the request is invalid.", "API Error: 400 Input is too long for requested model.", "API Error: 403 Usage limit reached for this AWS account.",
      "API Error: 403 User: arn:aws:sts::123456789012:assumed-role/rate-limit-lab/dev is not authorized to perform: bedrock:InvokeModelWithResponseStream", "API Error: 429 The model is not ready for inference. Wait and try your request again.",
      "API Error: 400 ValidationException: Too many tokens for this model identifier", "API Error: 400 Too many input tokens. Max input tokens: 200000, request input token count: 265434", "API Error: 403 AccessDeniedException: Too many requests, please wait before trying again. is not allowed for this model", "API Error: 400 Invalid model identifier 'Too many tokens, please wait before trying again.'", "API Error: 403 Too many requests, please wait before trying again."])
      expect(bedrockIsLimit(classifyBedrockError(t)), t).toBe(false); // W26-relayed-refusal
  });
  it("W8b a confirmed Stop and a runner subtype are never a Bedrock row", () => {
    const frame = { text: "Request aborted by the user while AWS was answering (403)", isApiError: false, isErrorResult: true };
    expect(bedrockFrameApplies({ ...frame, stopRequested: true }), "W8b stop").toBe(false); // W8b-stop
    expect(bedrockFrameApplies({ text: "Reached maximum number of turns (3)", isApiError: false, isErrorResult: true, subtype: "error_max_turns" }), "W8b max turns").toBe(false); // W8b-subtype
    expect(bedrockFrameApplies({ text: "AccessDeniedException model", isApiError: true, isErrorResult: false, stopRequested: true }), "stop beats api error").toBe(false);
    expect(bedrockFrameApplies({ text: "ThrottlingException", isApiError: false, isErrorResult: true }), "a provider result applies").toBe(true);
  });
  it("W27 redaction: arn tokens and exactly 12 digits; a 13-digit timestamp keeps its meaning", () => {
    const raw = "User: arn:aws:sts::123456789012:assumed-role/Dev/owner@example.test is not authorized at 1731974400123";
    const out = bedrockRedact(raw);
    expect(out, "W27 arn").not.toContain("arn:aws"); // W27-arn
    expect(out).not.toContain("123456789012");
    expect(out).toContain("1731974400123");
    expect(bedrockRedact("account 123456789012 ok")).toBe("account …9012 ok");
    expect(bedrockErrorRowText("other", ctx, raw), "W27 row").not.toMatch(/arn:aws|(?<!\d)\d{12}(?!\d)/); // W27-row
  });
});

describe("W13 decode, W25 outbound, W28 values, W21 sentence, W10 imports", () => {
  it("W13 a partial or hand-edited block is UNBOUND; a valid one survives", () => {
    const ok = { profile: "p", region: "us-east-1", accountId: "123456789012", epoch: 2 };
    expect(decodeBedrockBinding(ok)).toEqual(ok);
    expect(decodeBedrockBinding({ ...ok, accountId: undefined }), "W13 missing accountId").toBeNull(); // W13-id
    expect(decodeBedrockBinding({ ...ok, epoch: "x" }), "W13 epoch").toBeNull(); // W13-epoch
    expect(decodeBedrockBinding({ ...ok, profile: "bad profile" })).toBeNull();
    expect(decodeBedrockBinding({ ...ok, region: "mars" })).toBeNull();
  });
  // W25 drives the real serialisers that copy config.json off the local config: the restorable stage (state/config.json + its manifest)
  // and the encrypted backup's raw copy (inventoryFidelity, the bytes writeEncryptedInstallationBackup zips). The desktop has no cloud
  // catalog or diagnostics serialiser of instances (CHECKLIST.md r4 lists the search); these two are the paths that leave config.json.
  it("W25 a bound Bedrock account is in neither the stage nor the encrypted backup's copy of config.json; the copy holds it as an unbound Bedrock account", async () => {
    const f = backupFixture();
    try {
      const bedrock = { profile: "work-dev", region: "us-west-2", accountId: "123456789012", epoch: 3 };
      writeFileSync(join(f.data, "config.json"), JSON.stringify({ profile: { name: "Fixture" }, instances: {
        fixture: { driver: "fuigoAgent", enabled: true, config: { apiKey: "FAKE-CREDENTIAL-CANARY" } },
        aws: { driver: "claudeAgent", displayName: "Work AWS", enabled: true, config: { configDir: join(f.data, "claude-aws"), bedrock } } } }));
      await withOfflineInstallation(f.data, async (installation) => {
        const stage = await stageInstallationStateWhileOwned(installation, f.parent);
        const inventory = await inventoryFidelity(installation, stage, { scope: "application-data", credentialPolicy: "preserve-in-encrypted-fidelity" });
        const raw = readFileSync(inventory.sources.find((file) => file.path === "config.json")!.source, "utf8");
        for (const leak of ["work-dev", "us-west-2", "123456789012"]) expect(raw, `W25 encrypted backup copy holds ${leak}`).not.toContain(leak); // W25
        const restored = JSON.parse(raw).instances;
        expect(restored.aws, "W25 the backup copy holds an unbound Bedrock account").toMatchObject({ driver: "claudeAgent", displayName: "Work AWS", config: { bedrock: {} } });
        expect(decodeBedrockBinding(restored.aws.config.bedrock), "W25 restored block is UNBOUND").toBeNull();
        expect(restored.fixture.config.apiKey, "the backup's own credential policy is unchanged").toBe("FAKE-CREDENTIAL-CANARY");
        const staged = readFileSync(join(stage.directory, "state", "config.json"), "utf8") + JSON.stringify(stage.manifest);
        for (const leak of ["work-dev", "us-west-2", "123456789012"]) expect(staged, `W25 stage holds ${leak}`).not.toContain(leak); // W25-stage
      });
      expect(JSON.parse(readFileSync(join(f.data, "config.json"), "utf8")).instances.aws.config.bedrock, "the local config.json keeps its binding").toEqual(bedrock);
    } finally { f.db.close(); removeTempDirSync(f.parent); }
  });
  it("W25 fail closed: when the backup's redacted copy cannot be written, the backup fails instead of shipping the raw config.json", async () => {
    const f = backupFixture();
    try {
      writeFileSync(join(f.data, "config.json"), JSON.stringify({ profile: { name: "Fixture" }, instances: {
        aws: { driver: "claudeAgent", displayName: "Work AWS", enabled: true, config: { configDir: join(f.data, "claude-aws"), bedrock: { profile: "work-dev", region: "us-west-2", accountId: "123456789012", epoch: 3 } } } } }));
      await withOfflineInstallation(f.data, async (installation) => {
        const stage = await stageInstallationStateWhileOwned(installation, f.parent);
        mkdirSync(join(stage.directory, "raw-config.json")); // the redacted copy's path is taken, so its write fails (EISDIR)
        const outcome = await inventoryFidelity(installation, stage, { scope: "application-data", credentialPolicy: "preserve-in-encrypted-fidelity" })
          .then((inventory) => readFileSync(inventory.sources.find((file) => file.path === "config.json")!.source, "utf8"), (error: unknown) => error);
        expect(typeof outcome === "string" && outcome.includes("work-dev"), "W25 fail closed: the raw config.json with the binding is never a backup source").toBe(false); // W25-closed
        expect(outcome, "the backup fails").toBeInstanceOf(Error);
      });
    } finally { f.db.close(); removeTempDirSync(f.parent); }
  });
  it("bedrockInfo shows the masked account in Settings", () => {
    const entry = { driver: "claudeAgent", displayName: "Work AWS", config: { configDir: "/d/claude-1", bedrock: { profile: "work-dev", region: "us-west-2", accountId: "123456789012", epoch: 3 } } } as never;
    expect(bedrockInfo(entry)?.label).toBe("Claude on Bedrock (AWS …9012, us-west-2)");
  });
  it("W21 the powershell-inherit sentence is on the Save line only in inherit mode", () => {
    const b = { profile: "personal", region: "us-east-1", accountId: "111111111111", epoch: 1 };
    expect(bedrockSaveLine(b, true), "W21 inherit").toContain(bedrockCommandsSentence("personal", "us-east-1")); // W21-sentence
    expect(bedrockSaveLine(b, false)).not.toContain("commands the bot runs");
    expect(bedrockSaveLine(b, false)).toContain("111111111111");
  });
  it("W10 server/** imports only STSClient, GetCallerIdentityCommand, getDefaultRoleAssumer (client-sts) and fromIni (credential-provider-ini), and no *Command from anywhere else", () => {
    const root = join(import.meta.dirname, ".");
    const walk = (d: string): string[] => readdirSync(d).flatMap((n) => { const p = join(d, n); const s = statSync(p); return s.isDirectory() ? (n === "node_modules" ? [] : walk(p)) : /\.ts$/.test(n) && !/\.test\.ts$/.test(n) ? [p] : []; });
    const bad: string[] = [];
    for (const file of walk(root)) {
      const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
      sf.forEachChild((n) => {
        if (!ts.isImportDeclaration(n) || !ts.isStringLiteral(n.moduleSpecifier) || !n.moduleSpecifier.text.startsWith("@aws-sdk/")) return;
        const mod = n.moduleSpecifier.text;
        const names = (n.importClause?.namedBindings && ts.isNamedImports(n.importClause.namedBindings) ? n.importClause.namedBindings.elements.map((e) => (e.propertyName ?? e.name).text) : ["*default"]);
        const allowed: Record<string, string[]> = { "@aws-sdk/client-sts": ["STSClient", "GetCallerIdentityCommand", "getDefaultRoleAssumer"], "@aws-sdk/credential-provider-ini": ["fromIni"] };
        for (const name of names) if (!allowed[mod]?.includes(name)) bad.push(`${file}: ${mod} ${name}`);
      });
    }
    expect(bad, "W10 imports").toEqual([]); // W10
  });
});
void mkdirSync;
