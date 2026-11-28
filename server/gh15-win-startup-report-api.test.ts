// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// GH15 Windows startup + scheduled report qualification (TRIAGE #15, SCOPE-1023 T1).
// gh15-unattended-reporting-api.test.ts covers a report the scheduler fires while the server keeps running.
// The reported case is different: Murage is closed when the report comes due and starts again later, for
// example at Windows sign-in. Here the isolated server is stopped (on Windows through its graceful IPC close)
// before a one-time Full access report is due. It then starts again on the same profile while the
// desktop's own start-up watcher (electron/boot-progress-watch.mjs) observes it. The new process must listen
// with its start-up note gone, and its scheduler must run the overdue report without an owner answer,
// write the report (native Windows PowerShell on win32) after the protocol allow, and deliver it.
// Synthetic ACP engine only; no live data, no billable model.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import { launchVerificationServer } from '../scripts/control-murage.ts';
import { raiseLevel } from './testing/raise-level.ts';
import { BOOT_PROGRESS_FILE, readBootProgress, watchBootProgress } from '../electron/boot-progress-watch.mjs';

// Room for one request and a graceful Windows close (up to its 8 s grace) before the report is due.
const DUE_IN_MS = 20_000;

it('GH15 Windows: a report due while Murage was closed runs after start-up and is delivered, with no owner answer', async () => {
  const cli = join(process.cwd(), 'server/testing/fake-acp-cli.ts');
  const idle = pathToFileURL(join(process.cwd(), 'server/testing/idle-load-preload.mjs')).href;
  const call = { toolCallId:'gh15-report', kind:'edit', title:'Apply patch', rawInput:{patch:'*** Begin Patch\n*** Add File: outputs/gh15-report.md\n+GH15_SYNTHETIC_REPORT\n*** End Patch\n'},
    _meta:{'fuigo/tool':{version:1,namespace:'codex',name:'apply_patch',kind:'edit',read_only:false}} };
  // MURAGE_BOOT_PROGRESS: the start-up note a desktop-launched server writes (server/boot-progress.ts bootProgressWanted),
  // set before server/index.ts loads so boot-progress-start.ts sees it, on every start of this profile.
  const fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
    process.env.MURAGE_BOOT_PROGRESS = "1";
    await import(${JSON.stringify(idle)});
    globalThis[Symbol.for("murage.hostPower.testUnwrapped")] = true;
    const fs=await import('node:fs'); const path=await import('node:path');
    const file=path.join(process.env.MURAGE_DATA_DIR,'config.json'); const cfg=JSON.parse(fs.readFileSync(file,'utf8'));
    const reportCall=${JSON.stringify(call)};
    reportCall.rawInput.patch=reportCall.rawInput.patch.replace('outputs/gh15-report.md',path.join(process.env.MURAGE_DATA_DIR,'gh15-report.md'));
    cfg.instances.gh15={driver:'grokAgent',config:{cli:${JSON.stringify(cli)},fullAuto:false},environment:{PATH:path.dirname(process.execPath),FAKE_ACP_MODE:'permission',FAKE_ACP_MCP_READY:'1',FAKE_ACP_MCP_READY_METHOD:'_x.ai/mcp_initialized',FAKE_ACP_GH15_REPORT:'1',FAKE_ACP_PERMISSION_TOOLCALL:JSON.stringify(reportCall),FAKE_ACP_DUMP:path.join(process.env.MURAGE_DATA_DIR,'gh15-acp.json')}};
    fs.writeFileSync(file,JSON.stringify(cfg));
  ` });
  const dataDir = fixture.info.dataDir;
  const reportPath = join(dataDir, 'gh15-report.md');
  const seen: { pid: unknown; step?: string; seq?: number }[] = [];
  let watch: ReturnType<typeof watchBootProgress> | undefined;
  try {
    const api = async (method:string,path:string,body?:unknown) => {
      const secret = (await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as any).secret;
      const r=await fetch(`${fixture.info.url}${path}`,{method,headers:{'content-type':'application/json','x-murage-surface':'desktop','x-murage-surface-secret':secret},body:body===undefined?undefined:JSON.stringify(body)});
      return {status:r.status,body:await r.json() as any};
    };
    // The first start listened, so its note is already gone.
    expect(existsSync(join(dataDir, BOOT_PROGRESS_FILE))).toBe(false);
    const created = await api('POST','/api/bots',{name:'GH15 startup reporter',modelSelection:{instanceId:'gh15',model:'fake-model'}});
    expect(created.status).toBe(201); const bot=created.body.bot;
    expect((await api('PATCH',`/api/bots/${bot.id}`,{computer:'off',browser:false,composio:false})).status).toBe(200);
    const raised = await raiseLevel(api,bot.id,{fullAccess:true,acknowledgeFullAccess:true});
    expect(raised.status,JSON.stringify(raised.body)).toBe(200);
    const dueAt = Date.now() + DUE_IN_MS;
    const made = await api('POST','/api/routines',{name:'GH15 report due while closed',prompt:'Produce the synthetic GH15 report.',botId:bot.id,enabled:true,permissionMode:'full',schedule:{type:'once',at:dueAt}});
    expect(made.status,JSON.stringify(made.body)).toBe(201);
    const routineId = made.body.routine.id;

    // Murage closes before the report is due (Windows: the IPC close the desktop shell sends).
    const closing = fixture.child;
    await fixture.stop();
    expect({ code: closing.exitCode, signal: closing.signalCode }, 'Murage must close by itself (Windows: the IPC close), not be killed').toEqual({ code: 0, signal: null });
    const stoppedAt = Date.now();
    expect(stoppedAt, 'setup must stop the server before the report is due').toBeLessThan(dueAt - 1_000);
    expect(existsSync(reportPath)).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, dueAt - Date.now() + 1_500));

    // Start-up: the desktop's watcher reads the note of the child starting now, as electron/main.mjs does.
    watch = watchBootProgress({ dataDir, pid: () => fixture.child.pid, intervalMs: 50,
      read: (dir: string, options: { pid?: number }) => {
        const status = readBootProgress(dir, options);
        if (status) seen.push({ pid: status.pid, step: status.step, seq: status.seq });
        return status;
      } });
    const restartAt = Date.now();
    await fixture.restart();
    const bootPid = fixture.child.pid;
    expect(seen.some((note) => note.pid === bootPid), 'the starting child must publish its own start-up note before listen').toBe(true);
    expect(existsSync(join(dataDir, BOOT_PROGRESS_FILE)), 'the start-up note must be removed at listen').toBe(false);
    watch.tick();
    expect(watch.status()).toBeNull();

    let run: any;
    await expect.poll(async () => {
      const state = await api('GET','/api/routines');
      run = state.body.runs.find((r:any) => r.routineId === routineId);
      return run?.status;
    }, { timeout: 120_000 }).toBe('completed');
    expect((await api('GET','/api/routines')).body.runs.filter((r:any) => r.routineId === routineId), 'one overdue occurrence runs once').toHaveLength(1);
    expect(run.triggerSource).toBe('schedule');
    expect(run.manual).toBe(false);
    expect(run.scheduledFor).toBe(dueAt);
    expect(run.startedAt, 'the overdue report must run in the process that started after it was due').toBeGreaterThanOrEqual(restartAt);
    await expect.poll(async () => {
      const state = await api('GET','/api/routines');
      run = state.body.runs.find((r:any) => r.routineId === routineId);
      return run?.delivery?.state;
    }, { timeout: 30_000 }).toBe('sent');
    const messages = (await api('GET',`/api/threads/${run.threadId}/messages?limit=100`)).body.messages;
    expect(messages.filter((m:any) => m.kind==='options' && m.card?.requestId && m.card.answered===undefined)).toEqual([]);
    const decision = JSON.parse(readFileSync(join(dataDir,'gh15-acp.json'),'utf8')).decision;
    expect(decision.outcome).toMatchObject({outcome:'selected',optionId:expect.stringMatching(/allow/)});
    expect(existsSync(reportPath), 'an allow decision after start-up must produce the report file').toBe(true);
    expect(readFileSync(reportPath,'utf8')).toBe('GH15_SYNTHETIC_REPORT\n');
    expect(messages.some((m:any) => m.role==='bot' && m.text?.includes('Report written: GH15_SYNTHETIC_REPORT'))).toBe(true);
    if (process.env.SC_ISSUES_EVIDENCE) {
      mkdirSync(process.env.SC_ISSUES_EVIDENCE,{recursive:true});
      writeFileSync(join(process.env.SC_ISSUES_EVIDENCE,'gh15-startup-scheduled-fixture.json'),JSON.stringify({platform:process.platform,reportWriter:process.platform==='win32'?'native Windows PowerShell':'node:fs',dueAt,stoppedAt,restartAt,bootNotes:seen.filter((note)=>note.pid===bootPid),run,messages,decision},null,2));
    }
  } catch (error) {
    if (process.env.SC_ISSUES_EVIDENCE) {
      mkdirSync(process.env.SC_ISSUES_EVIDENCE,{recursive:true});
      writeFileSync(join(process.env.SC_ISSUES_EVIDENCE,'gh15-startup-scheduled-failure.log'),readFileSync(fixture.info.logPath));
    }
    throw error;
  } finally {
    watch?.stop();
    await fixture.close();
  }
}, 300_000);
