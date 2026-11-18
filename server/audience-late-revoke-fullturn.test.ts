import { appendFileSync, existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
import { fixtureEvidenceStamp } from "./memory/testing/writetime-fixture.ts";

const moduleUrl = (file: string) => pathToFileURL(join(process.cwd(), "server", file)).href;
let fixtureLive = false;
let server: VerificationServer, headers: Record<string, string>;
let activeCase: { botId: string; threadId: string; groupId?: string } | undefined;
const result = () => {
  const file = join(server.info.dataDir, "e-observation.json");
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) as Record<string, any> : undefined;
};
const api = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(server.info.url + path, { method, headers: { ...headers, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  expect(response.ok).toBe(true); return await response.json() as any;
};

// Fixture-only lexical access to the real startTurn. No product test route or
// live app mutation is introduced. The loader only appends observation/drive
// code, leaving admission, preparation, replay and beforeSubmit untouched.
const expose = `
globalThis.__areaEStart = async command => {
  const { WritetimeFixture } = await import(${JSON.stringify(moduleUrl("memory/testing/writetime-fixture.ts"))});
  const humans = await import(${JSON.stringify(moduleUrl("human-principals.ts"))});
  const db = database(); const f = new WritetimeFixture(db);
  // WritetimeFixture's four synthetic scopes predate the array audience wire.
  // Keep those fixture inputs valid before the real roster/lineage worker reads them.
  db.prepare("UPDATE memory_scopes SET audience='[]' WHERE id IN ('s-room','s-bot','s-other','s-project') AND json_type(audience)<>'array'").run();
  if (command.config === "D3") {
    const bindingId = humans.observeVerifiedHuman({platform:"slack",connectionId:"e-fixture",authorityId:"e-team",userId:command.threadId});
    const row = db.prepare("SELECT intent FROM memory_scope_bindings WHERE id=?").get(bindingId);
    const binding = JSON.parse(row.intent); binding.personId = "e-person-" + command.threadId;
    db.prepare("UPDATE memory_scope_bindings SET intent=? WHERE id=?").run(JSON.stringify(binding), bindingId);
    humans.bindHumanThread(command.threadId, humans.resolveHumanBinding(bindingId));
  }
  store.appendMessage(command.threadId, {role:"user",kind:"text",text:"fixture previous question",origin:command.config === "D1" || command.config === "R1" ? "desktop" : "unproven"});
  const secret = store.appendMessage(command.threadId, {role:"bot",kind:"text",text:"SECRET"});
  const number = db.prepare("SELECT no FROM memory_thread_no WHERE thread_id=?").get(command.threadId);
  let lineage = number && db.prepare("SELECT lsn FROM memory_line_lineage WHERE thread_no=? AND message_id=?").get(number.no, secret.id);
  if (!lineage) {
    const lsn = Number(db.prepare("SELECT next FROM memory_lsn WHERE id=1").get().next);
    f.lineage(command.threadId, secret.id, lsn); lineage = {lsn};
  }
  // The seed must pass the real reader before it can prove a late revoke.
  // Give the fixture's background lineage pass its normal opportunity before
  // admitting a held provider (which would defer that background work).
  const { lineageThreadReady, denyLookup } = await import(${JSON.stringify(moduleUrl("memory/deny-read.ts"))});
  bumpLineageWarm(command.threadId); memoryWorker.hurryLineage(5000);
  const readyUntil = Date.now() + 10000;
  while (!lineageThreadReady(db, command.threadId) && Date.now() < readyUntil) await new Promise(resolve=>setTimeout(resolve,20));
  const seedVerdict = denyLookup(db,{threadId:command.threadId,lines:[{messageId:secret.id,author:'generated'}]},{audience:null}).get(secret.id);
  if (seedVerdict?.state !== 'shown') console.error('Area E seed precondition', JSON.stringify(seedVerdict));
  const bundle = "e-held-" + command.threadId;
  if (command.mutation === "section") {
    const meta = db.prepare('SELECT policy_revision,deletion_epoch FROM memory_meta WHERE id=1').get();
    f.receipt(bundle, command.threadId, "areaE", "fixture-held", {policyRevision:Number(meta.policy_revision),deletionEpoch:Number(meta.deletion_epoch)});
    const no = db.prepare("SELECT no FROM memory_thread_no WHERE thread_id=?").get(command.threadId).no;
    db.prepare("INSERT INTO memory_receipt_lines(thread_no,first_lsn,bundle_id) VALUES(?,?,?)").run(no, lineage.lsn, bundle);
    db.prepare("UPDATE memory_line_lineage SET mem_lsn=? WHERE thread_no=? AND message_id=?").run(lineage.lsn, no, secret.id);
  }
  globalThis.__areaECurrent = {command, f, bundle, lsn:Number(lineage.lsn), refusals:0};
  if (command.groupId) {
    store.appendMessage(command.threadId, {role:"user",kind:"text",text:"fixture question",origin:command.config === "R1" ? "desktop" : "unproven"});
    try { await runGroupMemberTurn(command.groupId, command.threadId, command.botId, 0, undefined, undefined,
      (message,error) => globalThis.__areaEObserve({failure:1,error:String(message),code:String(error?.message),cause:String(error?.cause?.message),stack:String(error?.cause?.stack)})); }
    catch(error) { globalThis.__areaEObserve({denied:Number(error.status === 403), failure:1,error:String(error.message)}); }
    return;
  }
  const options = {threadId:command.threadId, ...(command.config === "D2" ? {origin:"unproven"} : {})};
  if(command.admission === "automationSource") options.automationSource = "schedule";
  if(command.admission === "commsDepth") options.commsDepth = 1;
  if(command.admission === "cardContinuation") options.cardContinuation = true;
  if(command.admission === "memoryRedispatch") options.memoryRedispatch = 1;
  try { await startTurn(command.botId, "fixture question", options); }
  catch(error) { globalThis.__areaEObserve({denied:Number(error.status === 403), failure:1,error:String(error.message)}); }
};
`;

describe.skipIf(process.platform === "win32")("Area E actual direct/room admission and last-resort submission", () => {
  // Each admitted generation owns a separate server, lineage worker and fake.
  // A held refusal in one case cannot become the next case's preparation.
  beforeEach(async () => {
    fixtureLive = false; activeCase = undefined;
    server = await launchVerificationServer({}, undefined, { instrumentationSource: `
      const fs = await import('node:fs'); const path = await import('node:path');
      const {registerHooks} = await import('node:module');
      const target = ${JSON.stringify(moduleUrl("index.ts"))};
      registerHooks({load(url, context, next) { const loaded=next(url,context); if(url!==target)return loaded;
        return {...loaded,source:(typeof loaded.source==='string'?loaded.source:Buffer.from(loaded.source).toString('utf8'))+${JSON.stringify(expose)}}; }});
      const dir = process.env.MURAGE_DATA_DIR;
      const originalAppend = fs.default.appendFileSync;
      fs.default.appendFileSync = function(file, bytes, ...rest) {
        const result = originalAppend.call(this, file, bytes, ...rest);
        if (String(file) === path.join(dir, 'e-wire.jsonl')) {
          const row = JSON.parse(String(bytes)), observation = globalThis.__areaEObservation, active = globalThis.__areaECurrent;
          if (row.prompt && observation && row.threadId === active?.command.threadId) {
            observation.writes++; observation.payloadSecretCount += Number(String(row.frame).includes('SECRET'));
            observation.generationUnchanged = Number(active.f.generation() === active.releaseGeneration);
            globalThis.__areaEObserve(observation);
          }
        }
        return result;
      };
      (await import('node:module')).syncBuiltinESMExports();
      globalThis.__areaEObserve = value => fs.writeFileSync(path.join(dir,'e-observation.json'),JSON.stringify(value));
      const {MemoryDispatchReceipt} = await import(${JSON.stringify(moduleUrl("memory/dispatch.ts"))});
      const originalCheck=MemoryDispatchReceipt.prototype.assertCurrent;
      MemoryDispatchReceipt.prototype.assertCurrent=function(...args) {
        originalCheck.apply(this,args);
        const active=globalThis.__areaECurrent;
        if(active?.command.route==='last-resort' && active.refusals < 2) { active.refusals++; throw new Error('MEMORY_CONTEXT_REVOKED'); }
      };
      const {BUILT_IN_DRIVERS}=await import(${JSON.stringify(moduleUrl("drivers/builtIn.ts"))});
      const {makeLateTerminalDriver}=await import(${JSON.stringify(moduleUrl("testing/fake-late-terminal-driver.ts"))});
      const driver=makeLateTerminalDriver(), create=driver.create.bind(driver);
      driver.create=async input=>{const instance=await create(input), send=instance.adapter.sendTurn.bind(instance.adapter);
        instance.adapter.sendTurn=async turn=>{
          const active=globalThis.__areaECurrent;
          if(!active||turn.threadId!==active.command.threadId)return send(turn);
          const observation={prepared:1,secretCount:Number((String(turn.system ?? '')+' '+JSON.stringify(turn.memoryContext ?? null)+' '+turn.text).includes('SECRET')),payloadSecretCount:0,writes:0,refused:0,
            setupRefusals:active.refusals,receiptCount:Number(Boolean(turn.memoryContext)),
            transcriptCount:turn.transcript?.length ?? 0,systemChars:String(turn.system ?? '').length,
            mountCount:Object.keys(turn.integrations ?? {}).length,imageCount:turn.images?.length ?? 0,
            minimalInput:Number(turn.text.includes('fixture question') || turn.text.includes('Ask for a fresh message before continuing.'))};
          globalThis.__areaEObserve(observation);
          await new Promise(resolve=>{const timer=setInterval(()=>{if(fs.existsSync(path.join(dir,'e-release'))){clearInterval(timer);resolve();}},20);});
          if(active.command.flip && active.command.mutation !== 'section') active.f.audienceFlip(turn.threadId,active.lsn);
          if(active.command.mutation === 'section') observation.receiptRevokedCount=Number(active.f.db.prepare("SELECT state FROM memory_disclosures WHERE bundle_id=?").get(active.bundle)?.state==='revoked');
          const generation=active.f.generation(); active.releaseGeneration=generation;
          globalThis.__areaEObservation = observation;
          const before=turn.beforeSubmit;
          turn={...turn,beforeSubmit:()=>{try{before?.();}catch(error){observation.refused++;throw error;}
            finally{observation.generationUnchanged=Number(active.f.generation()===generation);globalThis.__areaEObserve(observation);}}};
          return send(turn);
        }; return instance;};
      BUILT_IN_DRIVERS.push(driver);
      const cfgPath=path.join(dir,'config.json'),cfg=JSON.parse(fs.readFileSync(cfgPath,'utf8'));
      cfg.instances.areaE={driver:'fakeLateTerminal',environment:{FAKE_LATE_FENCED_WRITES:'1',FAKE_LATE_HANDBACK:'1',FAKE_LATE_TEARDOWN:'1',FAKE_LATE_DUMP:path.join(dir,'e-wire.jsonl'),FAKE_LATE_DUMP_FRAME:'1'}};
      fs.writeFileSync(cfgPath,JSON.stringify(cfg));
      let processing=false;
      const timer=setInterval(async()=>{const file=path.join(dir,'e-command.json');if(processing||!globalThis.__areaEStart||!fs.existsSync(file))return;
        processing=true;const command=JSON.parse(fs.readFileSync(file,'utf8'));fs.rmSync(file);
        try{await globalThis.__areaEStart(command);}finally{processing=false;}},20);timer.unref();
    ` });
    fixtureLive = true;
    // The launcher's persistent evidence is outside the checkout and survives
    // fixture cleanup. Only identity and counts are recorded, never payload.
    appendFileSync(`${server.info.logPath}.area-e.jsonl`, JSON.stringify(fixtureEvidenceStamp()) + "\n");
    const proof = await (await fetch(server.info.url + "/api/desktop-secret")).json() as { secret: string };
    headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
  }, 30000);
  afterEach(async () => {
    if (!fixtureLive) return;
    try {
      const observation = result();
      // Release this fixture's held fake even when a precondition fails.
      writeFileSync(join(server.info.dataDir, 'e-release'), 'fixture cleanup');
      if (!observation?.prepared || observation.failure) console.error('Area E fixture diagnostics', JSON.stringify(observation), readFileSync(server.info.logPath, 'utf8').slice(-6000));
      if (activeCase) {
        // A revoked conversation can already have retired its interrupt route.
        // Cleanup records that status without turning a completed assertion red.
        const interruptPath = activeCase.groupId ? `/api/groups/${activeCase.groupId}/interrupt` : `/api/bots/${activeCase.botId}/interrupt`;
        const response = await fetch(server.info.url + interruptPath, {
          method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ threadId: activeCase.threadId }),
        });
        await response.arrayBuffer();
        if (!response.ok) console.error('Area E cleanup interrupt status', response.status);
      }
    } finally {
      activeCase = undefined; fixtureLive = false;
      await server.close();
    }
  });
  async function run(config: string, route: string, admission: string, flip: boolean, mutation = "line") {
    for (const name of ["e-release", "e-observation.json"]) rmSync(join(server.info.dataDir, name), { force: true });
    const bot = (await api("POST", "/api/bots", { name: "E fixture", modelSelection: { instanceId: "areaE", model: "late-1" } })).bot;
    await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false });
    const group = config.startsWith("R") ? (await api("POST", "/api/groups", { name: "E isolated room", memberIds: [bot.id], setup: { bulletin: "", defaultResponder: { kind: "member", botId: bot.id } } })).group : undefined;
    const task = group ?? (await api("POST", `/api/bots/${bot.id}/tasks`, { title: "E isolated conversation" })).task;
    activeCase = { botId: bot.id, threadId: task.threadId, groupId: group?.id };
    writeFileSync(join(server.info.dataDir, "e-command.json"), JSON.stringify({ botId: bot.id, threadId: task.threadId, groupId: group?.id, config, route, admission, flip, mutation }));
    await expect.poll(() => result()?.prepared ?? result()?.denied, { timeout: 15000 }).toBe(1);
    if (!result()?.prepared) console.error("Area E admission failed", JSON.stringify(result()));
    appendFileSync(`${server.info.logPath}.area-e.jsonl`, JSON.stringify({ phase: "prepared", config, route, admission, mutation, flip: Number(flip), ...result() }) + "\n");
    if (admission === "unadmitted") { expect(result()?.denied).toBe(1); expect(result()?.prepared).toBeUndefined(); return; }
    // MAIN RULING INT-CONFLICT-DEFAULT fa4cb76449c: R7/R8 final recovery is
    // message-only. Stored SECRET must be absent at preparation AND delivery;
    // the positive wire write and real minimal input prevent a vacuous refusal.
    expect(result()?.secretCount, "T-C prepared payload follows its recovery tier").toBe(route === "last-resort" ? 0 : 1);
    if (route === "last-resort") {
      expect(result()).toMatchObject({ setupRefusals: admission === "memoryRedispatch" ? 1 : 2, receiptCount: 0, transcriptCount: 0, systemChars: 0, mountCount: 0, imageCount: 0, minimalInput: 1 });
    }
    if (flip && mutation === "section") await api("PATCH", `/api/bots/${bot.id}`, { section: "E changed audience" });
    writeFileSync(join(server.info.dataDir, "e-release"), "");
    await expect.poll(() => (result()?.writes ?? 0) + (result()?.refused ?? 0), { timeout: 15000 }).toBeGreaterThan(0);
    appendFileSync(`${server.info.logPath}.area-e.jsonl`, JSON.stringify({ phase: "submitted", config, route, admission, mutation, flip: Number(flip), ...result() }) + "\n");
    expect(result()?.generationUnchanged).toBe(1);
    if (mutation === "section") expect(result()?.receiptRevokedCount, "the real section edit must flip the held disclosure").toBe(Number(flip));
    if (route === "last-resort") {
      // MAIN RULING INT-CONFLICT-DEFAULT fa4cb76449c: revoking omitted history
      // cannot authorize its disclosure; the only delivered content is minimal.
      expect(result()?.writes).toBe(1); expect(result()?.refused).toBe(0); expect(result()?.payloadSecretCount).toBe(0);
    } else if (flip && config !== "D1" && config !== "R1") { expect(result()?.refused).toBe(1); expect(result()?.writes).toBe(0); expect(result()?.payloadSecretCount).toBe(0); }
    else { expect(result()?.writes).toBe(1); expect(result()?.refused).toBe(0); expect(result()?.payloadSecretCount).toBe(1); }
    await expect.poll(async () => (await api("GET", "/api/bots?messages=0")).bots.find((b: any) => b.id === bot.id)?.busy === true, { timeout: 15000 }).toBe(false);
  }
  for (const route of ["ordinary", "last-resort"]) {
    // control: T-C first proves delivery of SECRET without a revoke, on the
    // channel-person shape and real startTurn, independently of red cases.
    it.each(["automationSource", "commsDepth", "cardContinuation", "memoryRedispatch"])(`T-C control D3 ${route} %s baseline delivery`, admission => run("D3", route, admission, false), 60000);
    // historical-red (current BASE evidence recorded separately): actual D3 submission formerly reused content-only replay
    // or unchanged-generation prefix checks, releasing the prepared SECRET.
    it.each(["automationSource", "commsDepth", "cardContinuation", "memoryRedispatch"])(`T-C D3 ${route} %s flip refuses with zero writes`, admission => run("D3", route, admission, true), 60000);
    // control: unadmitted D3 must never reach the adapter.
    it(`T-ADMISSION control D3 ${route} unadmitted`, () => run("D3", route, "unadmitted", false), 60000);
    // control: T-A OWN requires delivery, not merely absence of an exception.
    it(`T-A OWN control D1 ${route}`, () => run("D1", route, "owner", true), 60000);
    // historical-red (current BASE evidence recorded separately): owner identity alone did not justify audience exemption.
    it(`T-A MAIN D2 ${route}`, () => run("D2", route, "owner", true), 60000);
    // control: both actual room admission paths first demonstrate delivery.
    it.each(["R1", "R2"])(`T-ADMISSION control %s ${route} delivery`, config => run(config, route, "room", false), 60000);
    // control: the owner-room own-line exception preserves delivery.
    it(`T-OW control R1 ${route} audience flip`, () => run("R1", route, "room", true), 60000);
    // historical-red (current BASE evidence recorded separately): ordinary prefix/last-resort replay did not recheck the
    // R2 audience mark at this actual room member's final submission.
    it(`T-R FLIP R2 ${route}`, () => run("R2", route, "room", true), 60000);
  }
  for (const admission of ["automationSource", "commsDepth", "cardContinuation", "memoryRedispatch"]) {
    // control: T-C baseline delivery is established with the same real held
    // receipt/line linkage used by the section-edit regression, still valid.
    it(`T-C control held receipt ${admission}`, () => run("D3", "last-resort", admission, false, "section"), 60000);
    // historical-red (current BASE evidence recorded separately): edit the actual bot section through the isolated server;
    // the resulting receipt flip must suppress the already-prepared payload.
    it(`T-C late section edit ${admission}`, () => run("D3", "last-resort", admission, true, "section"), 60000);
  }
});
