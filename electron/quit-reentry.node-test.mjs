import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import test from "node:test";

const source=readFileSync(new URL("./main.mjs",import.meta.url),"utf8");
const handler=source.slice(source.indexOf('app.on("before-quit", (e) => {'));
function fixture(cleanup){
  let trigger;const events=[],queue=[];
  const scope={app:{on:(_event,callback)=>{trigger=callback;},quit:()=>events.push("quit")},backgroundLifecycle:null,cuaCleanedUp:false,desktopCleanup:null,cleanupDesktopForExit:cleanup,setImmediate:callback=>queue.push(callback),slog:()=>{},desktopCleanupStage:"owned harness",dialog:{showErrorBox:()=>events.push("incomplete")}};
  new Function(...Object.keys(scope),handler)(...Object.values(scope));
  return {events,queue,trigger:()=>trigger({preventDefault:()=>events.push("prevented")})};
}
test("successful cleanup queues quit after the prevented native invocation unwinds",async()=>{
  const f=fixture(()=>Promise.resolve());f.trigger();await Promise.resolve();await Promise.resolve();
  assert.deepEqual(f.events,["prevented"]);assert.equal(f.queue.length,1);
  f.queue[0]();assert.deepEqual(f.events,["prevented","quit"]);
});
test("failed cleanup does not schedule or force a quit",async()=>{
  const f=fixture(()=>Promise.reject(Error("writer still active")));f.trigger();await Promise.resolve();await Promise.resolve();
  assert.equal(f.queue.length,0);assert.deepEqual(f.events,["prevented","incomplete"]);
});
