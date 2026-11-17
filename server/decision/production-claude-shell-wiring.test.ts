import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { launchVerificationServer, runControlMurage, type VerificationServer } from '../../scripts/control-murage.ts';
import { raiseLevel } from '../testing/raise-level.ts';

// Real index.ts, Claude driver, permission broker, decision ingress, ledger,
// policy, transport and persisted cards. Only the CLI is the launcher's fake.
// The production host installs its own approval builder. Instrument only the
// fixture route and fake CLI inputs, leaving that wiring under test.
const bridge = String.raw`
    if (path === '/api/native-shell-fixture' && method === 'POST') {
      const body = await readBody(req);
      const bot = store.bot(body.botId);
      if (!bot || !mayApprove(req,url)) return json(res,403,{});
      store.markThreadHighLevel(bot.threadId);
      process.env.FAKE_CLAUDE_PERM_TOOL = body.tool;
      process.env.FAKE_CLAUDE_PERM_INPUT = JSON.stringify({command:'echo fixture'});
      return json(res,200,{marked:store.threadHighLevelMarked(bot.threadId)});
    }
`;
let fixture: VerificationServer;
let headers: Record<string,string>;
const actions: unknown[] = [];
const bots: string[] = [];
async function request(method:string,path:string,body?:unknown) {
  const res=await fetch(fixture.info.url+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
  const result={status:res.status,body:await res.json() as any};
  actions.push({method,path,body,result});
  return result;
}
async function api(method:string,path:string,body?:unknown) {
  const result=await request(method,path,body);
  expect(result.status,JSON.stringify(result.body)).toBeLessThan(300);
  return result.body;
}
beforeAll(async()=>{
  fixture=await launchVerificationServer({},undefined,{instrumentationSource:`
    const {registerHooks}=await import('node:module');
    registerHooks({load(url,context,next){
      const loaded=next(url,context);
      if(url.endsWith('/server/drivers/claude.ts')) {
        // Pass scripted CLI inputs through the driver's captured environment.
        const anchor='extra: { ...ownedTurnNames(env, stripOwned), ...claudeNames,';
        const source=String(loaded.source);
        if(!source.includes(anchor))throw Error('fake CLI environment anchor missing');
        return {...loaded,source:source.replace(anchor,anchor+' FAKE_CLAUDE_PERM_TOOL: process.env.FAKE_CLAUDE_PERM_TOOL, FAKE_CLAUDE_PERM_INPUT: process.env.FAKE_CLAUDE_PERM_INPUT,')};
      }
      if(!url.endsWith('/server/index.ts'))return loaded;
      let source=String(loaded.source);
      const route='    const accessRoute =';
      if(!source.includes(route))throw Error('native shell fixture anchor missing');
      return {...loaded,source:source.replace(route,${JSON.stringify(bridge)}+route)};
    }});
  `});
  headers={'content-type':'application/json','x-murage-surface':'desktop',
    'x-murage-surface-secret':(await (await fetch(fixture.info.url+'/api/desktop-secret')).json() as {secret:string}).secret};
},150_000);
afterAll(async()=>{
  if(!fixture)return;
  try {
    const control=[];
    for(const args of [['doctor'],...bots.flatMap(bot=>[['wait','--bot',bot,'--timeout','1'],['messages','--bot',bot,'--limit','20']])]) {
      control.push({args:[...args,'--url',fixture.info.url],result:await runControlMurage([...args,'--url',fixture.info.url],{env:{...process.env,MURAGE_DATA_DIR:fixture.info.dataDir}})});
    }
    // The runner stores the action/state JSON and fixture log outside the checkout.
    console.info('Native shell verification',JSON.stringify({fixture:fixture.info,actions,control,serverLog:readFileSync(fixture.info.logPath,'utf8')}));
  }finally{await fixture.close();}
});

it.each([
  ['PowerShell',true],['PowerShell',false],['Bash',true],['Bash',false],
] as const)('H1 native Claude %s in a HighLevel thread at noLimits=%s runs or presents the normal card',async(tool,noLimits)=>{
  const instances=await api('GET','/api/instances');
  const model=instances.instances.find((item:any)=>item.instanceId==='verification').models.options[0].id;
  const {bot}=await api('POST','/api/bots',{name:`Native ${tool} ${noLimits}`,modelSelection:{instanceId:'verification',model}});
  bots.push(bot.id);
  await api('PATCH',`/api/bots/${bot.id}`,{computer:'off',browser:false,composio:false});
  if(noLimits)expect((await raiseLevel(request,bot.id,{noLimits:true,acknowledgeNoLimits:true})).status).toBe(200);
  expect(await api('POST','/api/native-shell-fixture',{botId:bot.id,tool})).toEqual({marked:'marked'});
  await api('POST',`/api/bots/${bot.id}/messages`,{threadId:bot.threadId,text:'__fixture_permission_tool__'});
  const messages=async()=> (await api('GET',`/api/threads/${bot.threadId}/messages?limit=100`)).messages as any[];
  // MAIN RULING INT-CONFLICT-DEFAULT a62419d6d5 / ee7826ac02: use the public opaque card handle end to end, without native ids.
  if(!noLimits){
    let card:any;
    await expect.poll(async()=>{
      card=(await messages()).find(row=>row.card?.requestHandle&&!row.card.answered);
      return card?.card.tool;
    },{timeout:30_000}).toBe(tool);
    expect(card.card.options).toEqual(['Allow','Deny']);
    await api('POST',`/api/threads/${bot.threadId}/respond`,{requestHandle:card.card.requestHandle,action:'allow'});
  }
  await expect.poll(async()=> (await messages()).some(row=>row.text==='permission: allowed'),{timeout:30_000}).toBe(true);
  if(noLimits)expect((await messages()).filter(row=>row.card?.requestHandle)).toEqual([]);
},60_000);
