// P09 owner HTTP -> /learn dispatch -> fake Claude -> real skill review card.
// Preconditions: Node >=24 and the repository's isolated verification launcher.
// The launcher supplies a temporary profile, no inherited credentials, and only
// the scripted fake CLI. A synthetic source contains its documented hold marker
// so the real agents capability remains active for the tool-stage request.
// Triggers: owner review-as-skill; authenticated skill_manage staging with a
// downgraded model source; owner forget; actual review-card approval endpoint.
// Expected: server-bound source survives staging, nothing is installed before
// approval, and forgetting invalidates approval. No native/model quality claim.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { launchVerificationServer } from "./control-murage.ts";

type Dump = { prompt: { message: { content: string } }; mcpConfig: { mcpServers: Record<string, { env?: Record<string,string> }> } };
type Card = { requestId: string; skillRequest: { stagedId: string; source: string; sha256: string; preview: string } };

async function main() {
  const fixture = await launchVerificationServer();
  let db: DatabaseSync | undefined;
  let desktop: Record<string,string> = {};
  const checks: string[] = [];
  const api = async (method: string, path: string, body?: unknown, headers: Record<string,string> = desktop) => {
    const response = await fetch(`${fixture.info.url}${path}`, {
      method, headers: { "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000),
    });
    return { status: response.status, body: await response.json() as any };
  };
  async function until<T>(label: string, read: () => T | undefined | Promise<T | undefined>): Promise<T> {
    const deadline = Date.now() + 15000;
    for (;;) {
      const result = await read(); if (result !== undefined) return result;
      assert(Date.now() < deadline, `Timed out: ${label}; fixture log ${fixture.info.logPath}`);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  try {
    const proof = await api("GET", "/api/desktop-secret"); assert.equal(proof.status, 200);
    desktop = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.body.secret };
    const configuration = await api("PATCH", "/api/config", { features: { skillRecorder: true } });
    assert.equal(configuration.status, 200, "Fixture must explicitly enable existing /learn review");
    const created = await api("POST", "/api/bots", { name: "Procedure review fixture", section: "MemoryFixture" });
    assert.equal(created.status, 201);
    const bot = created.body.bot as { id: string; threadId: string; modelSelection: { instanceId: string } };
    const instances = await api("GET", "/api/instances"); assert.equal(instances.status, 200);
    assert.equal(instances.body.instances.find((item: any) => item.instanceId === bot.modelSelection.instanceId)?.capabilities.agentsMcp, true);
    db = new DatabaseSync(join(fixture.info.dataDir, "messages.db"));
    db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000");
    const scope = db.prepare("SELECT id FROM memory_scopes WHERE kind='bot' AND owner_key=?").get(bot.id);
    assert(scope, "Fixture bot scope must exist before seeding source");
    const text = "__fixture_hold_authority__ Procedure: inspect the local backup receipt and record its timestamp. Do not run commands.";
    const payload = JSON.stringify({ text, kind: "text", speaker: "owner", outcome: "recorded" });
    const hash = createHash("sha256").update(payload).digest("hex");
    db.exec("BEGIN IMMEDIATE");
    db.prepare("INSERT INTO memory_sources(id,scope_id,thread_id,message_id,revision,content_hash,kind,speaker,outcome,state) VALUES('procedure-source',?,?,NULL,1,?,'text','owner','recorded','active')").run(scope.id, bot.threadId, hash);
    db.prepare("INSERT INTO memory_source_versions(source_id,revision,content_hash,payload,created_at) VALUES('procedure-source',1,?,?,1)").run(hash, payload);
    db.prepare("INSERT INTO memory_records(id,version,scope_id,kind,text,assertion,state,owner_pinned,valid_from,created_at) VALUES('procedure-record',1,?,'procedure',?,'owner-statement','active',0,1,1)").run(scope.id, text);
    db.prepare("INSERT INTO memory_evidence(record_id,record_version,source_id,source_revision,start_byte,end_byte) VALUES('procedure-record',1,'procedure-source',1,0,?)").run(Buffer.byteLength(text));
    db.exec("UPDATE memory_meta SET data_revision=data_revision+1 WHERE id=1; COMMIT");
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    rmSync(fixture.fixtureDumpPath, { force: true });

    const review = await api("POST", "/api/memory/action", { action: "review-as-skill", id: "procedure-record", version: 1, botId: bot.id });
    assert.equal(review.status, 200, "Owner review must start the existing authoring workflow");
    assert.equal(review.body.workflow, "learn");
    assert.equal(review.body.botId, bot.id); assert.equal(review.body.threadId, bot.threadId);
    assert.equal(typeof review.body.messageId, "string");
    assert.match(review.body.source, /^learn:memory-review:[a-f0-9-]{36}$/);
    const received = await until<Dump>("actual /learn provider input", () => {
      try { return JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")) as Dump; } catch { return undefined; }
    });
    assert(received.prompt.message.content.includes("[/learn]"), "The real /learn expansion was not delivered");
    assert(received.prompt.message.content.includes(review.body.source), "Provider input lacks server-issued source handle");
    assert(received.prompt.message.content.includes("procedure-record"), "Provider input lacks exact memory record identity");
    assert(received.prompt.message.content.includes(text), "Provider input lacks authoritative procedure bytes");
    const agents = received.mcpConfig.mcpServers.agents?.env;
    assert(agents?.MURAGE_COMMS_TOKEN, "Held fixture requires an active agents capability");
    assert.equal(agents.MURAGE_SKILL_AUTHORING_ENABLED, "1");
    checks.push("owner-action-delivers-source-linked-learn-turn");

    const skillMd = "---\nname: memory-fixture-procedure\ndescription: Reviews a backup receipt.\n---\n\n# Backup receipt review\n\nRead the existing local receipt and note its timestamp. Do not execute commands.\n";
    const staged = await api("POST", "/api/internal/skills/stage", {
      fromBotId: bot.id, fromThreadId: bot.threadId, action: "create", skill_md: skillMd,
      gist: "Reviews the source-backed local receipt.", source: "conversation",
    }, { authorization: `Bearer ${agents.MURAGE_COMMS_TOKEN}` });
    assert.equal(staged.status, 201, "Current source should allow staging through the real tool endpoint");
    let listing = await api("GET", `/api/bots/${bot.id}/skills`); assert.equal(listing.status, 200);
    assert.deepEqual(listing.body.skills, [], "Unreviewed proposal was installed or enabled");
    const proposal = listing.body.staged.find((item: any) => item.id === staged.body.stagedId);
    assert(proposal, "Staged proposal missing from existing review listing");
    assert.equal(proposal.source, review.body.source, "Model source downgrade replaced server-issued lineage");
    const card = await until<Card>("durable existing skill review card", async () => {
      const page = await api("GET", `/api/threads/${bot.threadId}/messages?limit=100`);
      assert.equal(page.status, 200);
      return page.body.messages.find((item: any) => item.card?.skillRequest?.stagedId === staged.body.stagedId)?.card;
    });
    assert.equal(card.skillRequest.source, review.body.source);
    assert.equal(card.skillRequest.preview, skillMd);
    assert.match(card.skillRequest.sha256, /^[a-f0-9]{64}$/);
    checks.push("model-source-downgrade-cannot-remove-review-lineage");
    checks.push("existing-owner-review-card-before-any-installation");

    const forgotten = await api("POST", "/api/memory/action", { action: "forget", kind: "source", id: "procedure-source", revision: 1 });
    assert.equal(forgotten.status, 200);
    const approval = await api("POST", `/api/bots/${bot.id}/respond`, { requestId: card.requestId, behavior: "allow", reviewedSha256: card.skillRequest.sha256 });
    assert.equal(approval.status, 422, "Existing owner approval must reject revoked memory source");
    assert.match(approval.body.error, /^MEMORY_SKILL_SOURCE_/);
    listing = await api("GET", `/api/bots/${bot.id}/skills`); assert.equal(listing.status, 200);
    assert.deepEqual(listing.body.skills, [], "Revoked source proposal reached installed skills");
    checks.push("forgotten-source-blocks-actual-owner-approval");
    const interrupted = await api("POST", `/api/bots/${bot.id}/interrupt`); assert.equal(interrupted.status, 200);
    console.log(JSON.stringify({ ok: true, checks, node: process.version, fixtureLog: fixture.info.logPath,
      limits: "Isolated fake Claude transport and actual HTTP staging/review only; no provider model calls, native model quality, or GUI proof." }));
  } finally {
    db?.close();
    await fixture.close();
  }
}
main().catch(error => { console.error(error instanceof Error ? error.stack : String(error)); process.exitCode = 1; });
