import { randomUUID } from "node:crypto";
import { mkdtempSync,rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect,it,vi } from "vitest";
import { createBackupRestartAdmission } from "./backup-restart-admission.ts";
import { RoutineManager } from "./routines.ts";
it("claims idle state synchronously, is idempotent, and only its token releases",()=>{
  let busy=true,releases=0;const gate=createBackupRestartAdmission({isBusy:()=>busy,onRelease:()=>releases++}),token=randomUUID();
  expect(()=>gate.prepare(token)).toThrow("BACKUP_WORK_ACTIVE");expect(gate.held()).toBe(false);
  busy=false;expect(gate.prepare(token)).toEqual({prepared:true,token});expect(gate.prepare(token)).toEqual({prepared:true,token});
  expect(()=>gate.assertOpen()).toThrow();expect(()=>gate.cancel(randomUUID())).toThrow();expect(gate.held()).toBe(true);
  expect(gate.cancel(token)).toEqual({released:true});expect(gate.cancel(token)).toEqual({released:false});expect(releases).toBe(1);
});
it.each(["slack","discord"] as const)("holds %s channel receipts queued without dispatch and resumes after cancel",async platform=>{
  const root=mkdtempSync(join(tmpdir(),"murage-backup-channel-gate-"));const gate=createBackupRestartAdmission({isBusy:()=>false,onRelease:()=>{}}),token=randomUUID();gate.prepare(token);
  const startTurn=vi.fn(async()=>{gate.assertOpen();});
  const manager=new RoutineManager({file:join(root,"routines.json"),automaticPaused:()=>gate.held(),isChannelCurrent:()=>true,botState:()=>gate.held()?"busy":"ready",startTurn,createTask:()=>({threadId:"detached"}),channelThread:()=>({threadId:"chief-thread"})});
  try{
    const run=manager.enqueueWebhook({webhookId:`${platform}:binding`,webhookName:platform,deliveryId:"event",prompt:"held owner message",botId:"chief",runOn:"ember",receivedAt:Date.now(),channelOrigin:{platform,connectionId:"binding"}});
    await manager.tick();expect(startTurn).not.toHaveBeenCalled();expect(manager.listRuns().find(item=>item.id===run.id)?.status).toBe("queued");
    gate.cancel(token);await manager.tick();expect(startTurn).toHaveBeenCalledOnce();
  }finally{manager.stop();rmSync(root,{recursive:true,force:true});}
});
