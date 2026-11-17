// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Runner injection owner: emailstore-1019. Server persistence witness owner: emailstore-1019.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { launchVerificationServer } from "../../scripts/control-murage.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { homeServerEnvironment } from "../cloud-home/boot.ts";

// Observe the real options and private-port result; leave both production callbacks intact.
const observer = `
const {registerHooks}=await import('node:module');
registerHooks({load(url,context,next){
 const loaded=next(url,context);
 if(!url.endsWith('/server/index.ts'))return loaded;
 let source=String(loaded.source);
 const constructor='const emailRuntime = new EmailRuntime({';
 const ready='for (const message of earlyEmailShellMessages.splice(0)) emailShellSink(message);';
 if(!source.includes(constructor)||!source.includes(ready))throw Error('Email wiring observer anchor moved');
 source=source.replace(constructor,\`let fixtureEmailOptions;
 const emailRuntime = new (class extends EmailRuntime {constructor(options){super(options);fixtureEmailOptions=options;}})({\`);
 source=source.replace(ready,ready+\`
 let fixtureAckCount=0;
 const fixtureAck=emailRuntime.secrets.ack.bind(emailRuntime.secrets);
 emailRuntime.secrets.ack=meta=>{fixtureAckCount++;fixtureAck(meta);};
 emailRuntime.secrets.setBotKey('fixture',{token:'fixture-value',keyId:'fixture-key'});
 const fixturePersist=fixtureEmailOptions.persistSecrets({bots:{}},{rev:1,epoch:1});
 await new Promise(resolve=>setImmediate(resolve));
 (await import('node:fs')).writeFileSync((await import('node:path')).join(DATA_DIR,'email-wiring.json'),JSON.stringify({
  unavailable:emailRuntime.secrets.unavailable,available:emailRuntime.secrets.available,
  persisted:fixturePersist,acks:fixtureAckCount,durable:emailRuntime.secrets.isDurable('fixture-key'),
  cloudHome,hasPort:!!utilityParentPort
 }));
 if(process.env.FIXTURE_EMAIL_EXIT==='1')process.exit(0);
 \`);
 return {...loaded,source};
}});
`;

it.each(["env-file", "inherited"])("standalone installer ignores the memory variable from %s", source => {
  const root = mkdtempSync(join(tmpdir(), "email-wiring-"));
  try {
    const preload = join(root, "observe.mjs"), envFile = join(root, "murage.env");
    writeFileSync(preload, observer);
    // Even the old test gates can be supplied by this file; none may enable a store.
    writeFileSync(envFile, `NODE_ENV=test\nVITEST=1\n${source === "env-file" ? "MURAGE_TEST_EMAIL_STORE=memory\n" : ""}`);
    const env = {
      PATH: process.env.PATH, HOME: root, MURAGE_DATA_DIR: root, MURAGE_ENV_FILE: envFile,
      MURAGE_SERVER_ENTRY: fileURLToPath(new URL("../index.ts", import.meta.url)),
      MURAGE_ENGINE_EXCLUSION_PATH: fileURLToPath(new URL("../testing/engine-exclusion-stub.cjs", import.meta.url)),
      NODE_OPTIONS: `--import=${preload}`, FIXTURE_EMAIL_EXIT: "1",
      ...(source === "inherited" ? { MURAGE_TEST_EMAIL_STORE: "memory" } : {}),
    };
    try {
      execFileSync(process.execPath, [fileURLToPath(new URL("../../installer/bin/murage.mjs", import.meta.url)), "start"], { env, timeout: 30_000, stdio: "pipe" });
    } catch (error) {
      // The observer ends the server before the launcher's health check succeeds.
      if ((error as { signal?: string }).signal) throw error;
    }
    expect(JSON.parse(readFileSync(join(root, "email-wiring.json"), "utf8"))).toEqual({
      unavailable: "store", available: false, persisted: false, acks: 0, durable: false, cloudHome: false, hasPort: false,
    });
  } finally { removeTempDirSync(root); }
}, 45_000);

it("desktop with the memory variable still sends EMAIL_SECRETS_SAVE over its private port", async () => {
  const fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
    process.env.MURAGE_TEST_EMAIL_STORE='memory';
    const {EventEmitter}=await import('node:events');
    process.parentPort=new EventEmitter();
    globalThis.fixtureEmailSaves=0;
    process.parentPort.postMessage=message=>{if(message.type==='murage:email-secrets-save')globalThis.fixtureEmailSaves++;};
    ${observer.replace("cloudHome,hasPort:!!utilityParentPort", "cloudHome,hasPort:!!utilityParentPort,saves:globalThis.fixtureEmailSaves")}
  ` });
  try {
    expect(JSON.parse(readFileSync(join(fixture.info.dataDir, "email-wiring.json"), "utf8"))).toEqual({
      unavailable: null, available: true, persisted: true, acks: 0, durable: false, cloudHome: false, hasPort: true, saves: 2,
    });
  } finally { await fixture.close(); }
}, 60_000);

it("Cloud home ignores the memory variable and posts the save to its supervisor", async () => {
  const boot = homeServerEnvironment({ machineId: "fixture", adminUrl: "https://admin.example.test", publicOrigin: "https://fixture.example.test", bootstrapSecret: "fixture-".repeat(5) }, "UTC");
  expect(boot.MURAGE_CLOUD_ROLE).toBe("home");
  expect(boot).not.toHaveProperty("MURAGE_TEST_EMAIL_STORE");
  const fixture = await launchVerificationServer(process.env, undefined, {
    cloud: { publicOrigin: "https://fixture.example.test", bootstrapSecret: "fixture-bootstrap-secret-32-characters" },
    instrumentationSource: `process.env.MURAGE_TEST_EMAIL_STORE='memory';
      const fixtureSend=process.send.bind(process);
      process.send=(message,...args)=>{if(message.type==='murage:email-secrets-save')
        globalThis.fixtureEmailPosted=true;return fixtureSend(message,...args);};
      ${observer.replace("cloudHome,hasPort:!!utilityParentPort", "cloudHome,hasPort:!!utilityParentPort,posted:globalThis.fixtureEmailPosted===true")}`,
  });
  try {
    expect(JSON.parse(readFileSync(join(fixture.info.dataDir, "email-wiring.json"), "utf8"))).toEqual({
      unavailable: "cloud", available: false, persisted: true, acks: 0, durable: false, cloudHome: true, hasPort: true, posted: true,
    });
  } finally { await fixture.close(); }
}, 60_000);
