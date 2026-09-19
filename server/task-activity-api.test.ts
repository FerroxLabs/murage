// The task switcher sorts and dates tasks by their last message. That time
// lives in the transcript, not on the task record, so the wire projection has
// to carry it: a client only ever holds the open thread's messages.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";

let fixture: VerificationServer, headers: Record<string, string>;
let ids: { bot: string; used: string; empty: string; group: string; groupUsed: string; groupEmpty: string };

beforeAll(async () => {
  fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
    const {Store}=await import(${JSON.stringify(new URL("./store.ts", import.meta.url).href)});
    const {writeFileSync}=await import('node:fs');const {join}=await import('node:path');
    const store=new Store(()=>({instanceId:'verification',model:'sonnet'}));
    const bot=store.createBot({name:'Activity fixture'},{seedMessages:false});
    const used=bot.threadId;store.appendMessage(used,{role:'user',kind:'text',text:'hello',at:1700000000000});
    store.appendMessage(used,{role:'bot',kind:'text',text:'hi',at:1700000060000});
    const empty=store.createTask(bot.id,'Nothing yet').threadId;
    const group=store.createGroup('Activity room',[bot.id],false,undefined,{completed:true});
    store.appendMessage(group.threadId,{role:'user',kind:'text',text:'room hello',at:1700000120000});
    const groupEmpty=store.createGroupTask(group.id,'Quiet room task',false).threadId;
    writeFileSync(join(process.env.MURAGE_DATA_DIR,'activity-fixture.json'),JSON.stringify({bot:bot.id,used,empty,group:group.id,groupUsed:group.threadId,groupEmpty}));
  ` });
  ids = JSON.parse(readFileSync(join(fixture.info.dataDir, "activity-fixture.json"), "utf8"));
  const proof = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string };
  headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
}, 30000);
afterAll(async () => { await fixture?.close(); });

const list = async (query: string) =>
  (await (await fetch(`${fixture.info.url}/api/bots${query}`, { headers })).json()) as { bots: any[]; groups: any[] };

it("sends each task's last message time, and none for a task with no messages", async () => {
  for (const query of ["", "?messages=0"]) {
    const { bots, groups } = await list(query);
    const tasks = bots.find((bot) => bot.id === ids.bot).tasks;
    expect(tasks.find((task: any) => task.threadId === ids.used).lastActivityAt, query).toBe(1700000060000);
    expect(tasks.find((task: any) => task.threadId === ids.empty), query).not.toHaveProperty("lastActivityAt");
    const groupTasks = groups.find((group) => group.id === ids.group).tasks;
    expect(groupTasks.find((task: any) => task.threadId === ids.groupUsed).lastActivityAt, query).toBe(1700000120000);
    expect(groupTasks.find((task: any) => task.threadId === ids.groupEmpty), query).not.toHaveProperty("lastActivityAt");
  }
});

it("keeps the time on a channel task switch answered without messages", async () => {
  const response = await fetch(`${fixture.info.url}/api/groups/${ids.group}/tasks/${ids.groupUsed}?messages=0`, { method: "POST", headers });
  expect(response.status).toBe(200);
  const { group } = await response.json() as { group: any };
  expect(group.tasks.find((task: any) => task.threadId === ids.groupUsed).lastActivityAt).toBe(1700000120000);
});
