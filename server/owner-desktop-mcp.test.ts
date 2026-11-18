// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import "./testing/port-integrity.ts";
import { existsSync, readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { join } from "node:path";
import { launchVerificationServer } from "../scripts/control-murage.ts";

// Producer and desktop smoke owner: p1-owner-stall-b. Runner owner: gnl-harness.
it("a fresh desktop owner with one ordinary stdio MCP server performs one native action and publicly completes", async () => {
  const fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
    const fs = await import('node:fs'), path = await import('node:path');
    const root = process.env.MURAGE_DATA_DIR, file = path.join(root, 'config.json');
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    const service = path.join(root, 'ordinary-mcp.mjs');
    fs.writeFileSync(service, ${JSON.stringify(`import {createInterface} from 'node:readline';
import {appendFileSync} from 'node:fs';
createInterface({input:process.stdin}).on('line',line=>{
 const q=JSON.parse(line);if(q.id===undefined)return;
 let result={};
 if(q.method==='initialize')result={protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}};
 if(q.method==='tools/list')result={tools:[{name:'echo',inputSchema:{type:'object',properties:{text:{type:'string'}}}}]};
 if(q.method==='tools/call'){
  appendFileSync(process.argv[2],JSON.stringify({tool:q.params.name,input:q.params.arguments})+String.fromCharCode(10));
  result={content:[{type:'text',text:'ordinary MCP action completed'}]};
 }
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result})+String.fromCharCode(10));
});`)});
    cfg.mcpServers = {fixture:{command:process.execPath,args:[service,path.join(root,'ordinary-actions.jsonl')],env:{},enabled:true}};
    Object.assign(cfg.instances.verification.environment ??= {}, {FAKE_CUSTOM_TOOL_SERVER:'fixture',
      FAKE_CUSTOM_TOOL_FAIL_TURN:'1',FAKE_CUSTOM_TOOL_LOG:path.join(root,'ordinary-native.jsonl')});
    fs.writeFileSync(file,JSON.stringify(cfg));
  ` });
  const { ProductClient } = await import(new URL("../scripts/no-limits-live/run.mjs", import.meta.url).href);
  const proof = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string };
  const headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
  const client = new ProductClient(fixture.info.url, headers, fixture.info.dataDir, 12000);
  try {
    const cfg = JSON.parse(readFileSync(join(fixture.info.dataDir, "config.json"), "utf8"));
    expect(Object.keys(cfg.mcpServers)).toEqual(["fixture"]);
    expect(cfg.mcpServers.fixture.enabled).toBe(true);
    const bot = await client.bot("Desktop MCP fixture", { id: "verification", model: "fixture" }, fixture.info.dataDir, "auto");
    expect(bot.noLimits).not.toBe(true);
    await client.connect();
    const result = await client.observe(bot, () => client.api("POST", `/api/bots/${bot.id}/messages`, {
      text: "Call the ordinary fixture tool once.", threadId: bot.threadId,
    }));
    expect(result.complete).toBe(true);
    expect(result.ended).toBe(true);
    expect(result.turn.ok).toBe(true);
    expect(result.events.filter((event: { type: string }) => event.type === "turn.completed")).toHaveLength(1);
    const actions = readFileSync(join(fixture.info.dataDir, "ordinary-actions.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(actions).toEqual([{tool:"echo",input:{text:"hello from claude"}}]);
    const native = readFileSync(join(fixture.info.dataDir, "ordinary-native.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(native).toHaveLength(1);
    expect(native[0]).toMatchObject({engine:"claude",server:"fixture",tool:"echo",isError:false});
  } finally {
    await client.disconnect();
    // Print only on request; the container caller retains this outside the tree.
    if (process.env.SC_LEDGER_EVIDENCE && existsSync(fixture.info.logPath)) {
      console.log(readFileSync(fixture.info.logPath,"utf8"));
    }
    await fixture.close();
  }
}, 60000);
