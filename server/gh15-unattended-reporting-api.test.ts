// GH15 / releases#7(b): a real scheduled-run HTTP path, synthetic ACP only.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import { launchVerificationServer } from '../scripts/control-murage.ts';
import { raiseLevel } from './testing/raise-level.ts';

async function reportWorkflow(scheduled: boolean) {
  const cli = join(process.cwd(), 'server/testing/fake-acp-cli.ts');
  const idle = pathToFileURL(join(process.cwd(), 'server/testing/idle-load-preload.mjs')).href;
  const call = { toolCallId:'gh15-report', kind:'edit', title:'Apply patch', rawInput:{patch:'*** Begin Patch\n*** Add File: outputs/gh15-report.md\n+GH15_SYNTHETIC_REPORT\n*** End Patch\n'},
    _meta:{'fuigo/tool':{version:1,namespace:'codex',name:'apply_patch',kind:'edit',read_only:false}} };
  const fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
    await import(${JSON.stringify(idle)});
    globalThis[Symbol.for("murage.hostPower.testUnwrapped")] = true;
    const fs=await import('node:fs'); const path=await import('node:path');
    const file=path.join(process.env.MURAGE_DATA_DIR,'config.json'); const cfg=JSON.parse(fs.readFileSync(file,'utf8'));
    const reportCall=${JSON.stringify(call)};
    reportCall.rawInput.patch=reportCall.rawInput.patch.replace('outputs/gh15-report.md',path.join(process.env.MURAGE_DATA_DIR,'gh15-report.md'));
    cfg.instances.gh15={driver:'grokAgent',config:{cli:${JSON.stringify(cli)},fullAuto:false},environment:{PATH:path.dirname(process.execPath),FAKE_ACP_MODE:'permission',FAKE_ACP_GH15_REPORT:'1',FAKE_ACP_PERMISSION_TOOLCALL:JSON.stringify(reportCall),FAKE_ACP_DUMP:path.join(process.env.MURAGE_DATA_DIR,'gh15-acp.json')}};
    fs.writeFileSync(file,JSON.stringify(cfg));
  ` });
  try {
    const secret = (await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as any).secret;
    const headers = {'content-type':'application/json','x-murage-surface':'desktop','x-murage-surface-secret':secret};
    const api = async (method:string,path:string,body?:unknown) => {
      const r=await fetch(`${fixture.info.url}${path}`,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
      return {status:r.status,body:await r.json() as any};
    };
    const created = await api('POST','/api/bots',{name:'GH15 synthetic reporter',modelSelection:{instanceId:'gh15',model:'fake-model'}});
    expect(created.status).toBe(201); const bot=created.body.bot;
    expect((await api('PATCH',`/api/bots/${bot.id}`,{computer:'off',browser:false,composio:false})).status).toBe(200);
    const raised = await raiseLevel(api,bot.id,{fullAccess:true,acknowledgeFullAccess:true});
    expect(raised.status,JSON.stringify(raised.body)).toBe(200);
    const made=await api('POST','/api/routines',{name:'GH15 unattended report',prompt:'Produce the synthetic GH15 report.',botId:bot.id,enabled:scheduled,permissionMode:'full',schedule:scheduled?{type:'once',at:Date.now()+1000}:{type:'interval',everyMinutes:30,anchorAt:Date.now()}});
    expect(made.status,JSON.stringify(made.body)).toBe(201);
    const started=scheduled?undefined:await api('POST',`/api/routines/${made.body.routine.id}/run`);
    if (!scheduled) expect(started!.status).toBe(201);
    let run:any;
    await expect.poll(async()=>{
      const state=await api('GET','/api/routines');
      run=state.body.runs.find((r:any)=>scheduled?r.routineId===made.body.routine.id:r.id===started!.body.run.id);
      return run?.status;
    },{timeout:scheduled?100000:45000}).toBe('completed');
    expect(run.triggerSource).toBe(scheduled?'schedule':'manual');
    expect(run.manual).toBe(!scheduled);
    if (scheduled) await expect.poll(async () => {
      const state = await api('GET','/api/routines');
      run = state.body.runs.find((r:any) => r.routineId === made.body.routine.id);
      return run?.delivery?.state;
    }, { timeout: 30000 }).toBe('sent');
    const messages=(await api('GET',`/api/threads/${run.threadId}/messages?limit=100`)).body.messages;
    expect(messages.some((m:any)=>m.role==='bot' && m.kind==='text' && m.text?.trim())).toBe(true);
    expect(messages.filter((m:any)=>m.kind==='options' && m.card?.requestId && m.card.answered===undefined)).toEqual([]);
    const decision=JSON.parse(readFileSync(join(fixture.info.dataDir,'gh15-acp.json'),'utf8')).decision;
    expect(decision.outcome).toMatchObject({outcome:'selected',optionId:expect.stringMatching(/allow/)});
    expect(existsSync(join(fixture.info.dataDir,'gh15-report.md')), 'An allow decision must produce the report file').toBe(true);
    const report = readFileSync(join(fixture.info.dataDir,'gh15-report.md'),'utf8');
    expect(report).toBe('GH15_SYNTHETIC_REPORT\n');
    expect(messages.some((m:any)=>m.role==='bot' && m.text?.includes('Report written: GH15_SYNTHETIC_REPORT'))).toBe(true);
    if(process.env.SC_ISSUES_EVIDENCE){mkdirSync(process.env.SC_ISSUES_EVIDENCE,{recursive:true});writeFileSync(join(process.env.SC_ISSUES_EVIDENCE,scheduled?'gh15-scheduled-fixture.json':'gh15-fixture.json'),JSON.stringify({fixture:fixture.info,platform:process.platform,reportWriter:process.platform==='win32'?'native Windows PowerShell':'node:fs',report,scheduled,made,started,run,messages,decision},null,2));}
  } catch(error) {
    if(process.env.SC_ISSUES_EVIDENCE){
      mkdirSync(process.env.SC_ISSUES_EVIDENCE,{recursive:true});
      writeFileSync(join(process.env.SC_ISSUES_EVIDENCE,scheduled?'gh15-scheduled-failure.log':'gh15-failure.log'),readFileSync(fixture.info.logPath));
    }
    throw error;
  } finally { await fixture.close(); }
}

it('GH15: a Full access routine completes its report after codex/apply_patch without an owner answer', () => reportWorkflow(false),120000);
it('GH15: the real scheduler dispatches a Full access report without a Run now request or owner answer', () => reportWorkflow(true),150000);
