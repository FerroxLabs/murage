import { expect, it } from "vitest";
import { ThreadSettingsWrites } from "./thread-settings-writes";

it("waits for settings on the target thread without blocking a sibling",async()=>{
  const writes=new ThreadSettingsWrites();let finish!:()=>void,started!:()=>void;
  const began=new Promise<void>(resolve=>{started=resolve;});
  const saved=writes.write("a",()=>new Promise<void>(resolve=>{finish=resolve;started();}),async()=>{});
  let ready=false;const waiting=writes.ready("a").then(()=>{ready=true;});
  await began;
  await writes.ready("b");expect(ready).toBe(false);finish();await saved;await waiting;expect(ready).toBe(true);
});
it("refuses the waiting send on failure but permits a later retry after authoritative reconciliation",async()=>{
  const writes=new ThreadSettingsWrites();let fail!:(error:Error)=>void;
  const saved=writes.write("a",()=>new Promise<void>((_,reject)=>{fail=reject;}),async()=>{});
  const waiting=expect(writes.ready("a")).rejects.toThrow("refused");
  await Promise.resolve();await Promise.resolve();fail(new Error("refused"));
  await expect(saved).rejects.toThrow("refused");await waiting;await expect(writes.ready("a")).resolves.toBeUndefined();
});
it("retains the guard when reconciliation fails and recovers through a newer explicit save",async()=>{
  const writes=new ThreadSettingsWrites();
  await expect(writes.write("a",async()=>{throw Error("save refused");},async()=>{throw Error("unreachable");})).rejects.toThrow("unreachable");
  await expect(writes.ready("a")).rejects.toThrow("unreachable");
  await writes.write("a",async()=>{},async()=>{});await writes.ready("a");
});
