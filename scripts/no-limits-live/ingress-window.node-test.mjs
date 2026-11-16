import {test} from 'node:test';
import assert from 'node:assert/strict';
import {captureIngressWindow} from './ingress-window.mjs';
function fixture(){
 const bot={id:'fixture',threadId:'a'},tasks=[{threadId:'a'},{threadId:'b'}],reads=[];
 const client={messageWindows:new Map(),api:async()=>({bot:{tasks}}),beginMessageWindow:async id=>{reads.push(id);return {afterId:`before-${id}`};}};
 return {bot,tasks,reads,client};
}
test('incoming reuse selects the target task cursor and retains the observe window object',async()=>{
 const f=fixture(),ingress=await captureIngressWindow(f.client,f.bot),reference=ingress.window;
 await ingress.select('b');assert.equal(ingress.window,reference);assert.equal(reference.afterId,'before-b');assert.equal(f.bot.threadId,'b');assert.equal(f.client.messageWindows.get('b'),reference);assert.equal(f.client.messageWindows.get('a').afterId,'before-a');assert.deepEqual(f.reads,['a','b']);
});
test('new incoming tasks use an empty boundary without dropping an existing task cursor',async()=>{
 const f=fixture(),ingress=await captureIngressWindow(f.client,f.bot);f.tasks.push({threadId:'new'});
 await ingress.select('new');assert.equal(ingress.window.afterId,null);assert.equal(f.bot.threadId,'new');
 await ingress.select('b');assert.equal(ingress.window.afterId,'before-b');
});
test('an unrelated thread cannot replace a captured ingress boundary',async()=>{
 const f=fixture(),ingress=await captureIngressWindow(f.client,f.bot);
 await assert.rejects(()=>ingress.select('foreign'),/not owned/);assert.equal(f.bot.threadId,'a');assert.equal(ingress.window.afterId,'before-a');
});
