// SPDX-License-Identifier: AGPL-3.0-or-later
import test from "node:test";
import assert from "node:assert/strict";
import { watchInboxChanges } from "./inbox-watch.mjs";

const encoder=new TextEncoder();
const frame=(payload,seq=1)=>`id: s:${seq}\ndata: ${JSON.stringify({...payload,seq})}\n\n`;
const settle=()=>new Promise(resolve=>setImmediate(resolve));

/** A fake event stream: each element of `chunks` is one network read. */
function harness({ready=()=>true,chunks=[]}={}){
  const waits=[],changes=[],requests=[];let release=null;
  const options={ready,url:()=>"http://127.0.0.1:1/api/events?screens=off",headers:()=>({"x-murage-surface":"desktop"}),
    fetch:async(url,init)=>{requests.push({url,init});return {ok:true,body:(async function*(){for(const chunk of chunks)yield encoder.encode(chunk);await new Promise(resolve=>{release=resolve;init.signal.addEventListener("abort",resolve);});})()};},
    setTimeout:(fn,ms)=>{waits.push(ms);setImmediate(fn);return {unref(){}};},clearTimeout:()=>{}};
  return {options,waits,changes,requests,end:()=>release?.()};
}

test("reports a change on connect and for each inbox.changed frame, split across reads",async()=>{
  const whole=frame({kind:"message",text:"hi"},1)+frame({kind:"inbox.changed",pollScale:2},2)+frame({kind:"inbox.changed",pollScale:1},3);
  const h=harness({chunks:[whole.slice(0,30),whole.slice(30,95),whole.slice(95)]});
  const stop=watchInboxChanges(change=>h.changes.push(change),h.options);
  for(let i=0;i<10;i++)await settle();
  assert.deepEqual(h.changes,[{},{scale:2},{scale:1}]);
  assert.equal(h.requests[0].init.headers["x-murage-surface"],"desktop");
  stop();
});

test("a notice that arrives in the same read as a frame over 1 MB is not dropped",async()=>{
  const big=frame({kind:"message",text:"x".repeat(1_200_000)},2);
  const h=harness({chunks:[frame({kind:"inbox.changed",pollScale:1},1)+big]});
  const stop=watchInboxChanges(change=>h.changes.push(change),h.options);
  for(let i=0;i<10;i++)await settle();
  assert.deepEqual(h.changes,[{},{scale:1}]);
  stop();
});

test("waiting for the server to come up does not back off to a minute",async()=>{
  let ready=false;const h=harness({ready:()=>ready});
  const stop=watchInboxChanges(change=>h.changes.push(change),h.options);
  for(let round=0;round<4;round++){await settle();const pending=h.waits.length;assert.ok(pending>round,"it waits between checks");const last=h.waits.at(-1);assert.ok(last<=5000,`a not-ready wait was ${last} ms`);}
  stop();
});

test("stop ends the stream and no further change is reported",async()=>{
  const h=harness({chunks:[]});
  const stop=watchInboxChanges(change=>h.changes.push(change),h.options);
  for(let i=0;i<5;i++)await settle();
  assert.deepEqual(h.changes,[{}]);
  stop();for(let i=0;i<5;i++)await settle();
  assert.deepEqual(h.changes,[{}]);
});
