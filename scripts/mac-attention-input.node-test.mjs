import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
const source=readFileSync(new URL('./mac-attention-qualification.mjs',import.meta.url),'utf8');
const jxa=readFileSync(new URL('./mac-attention-ax.jxa',import.meta.url),'utf8');
const check=(ok,label)=>{if(!ok)throw Error(label);};
const expected='B35_NATIVE_PHASE:banner-46c70df10127cef6';
function helper(options={}){
 const node=(role,title,children=[])=>({AXRole:role,AXTitle:title,AXDescription:'',AXValue:'',AXChildren:children,AXEnabled:true});
 const field=node('AXTextArea','Message B35'),button=node('AXButton','Send message'),app=node('AXApplication','Murage',[field,button]);button.AXEnabled=options.buttonEnabled??true;
 let clock=0,set=false,reads=0;const events=[],dollar=x=>x;
 Object.assign(dollar,{AXIsProcessTrusted:()=>true,AXUIElementCreateApplication:()=>app,AXUIElementCreateSystemWide:()=>({}),AXUIElementSetMessagingTimeout:()=>0,
  AXUIElementCopyAttributeValue:(e,k,r)=>{if(set&&e===field&&k==='AXValue'){if(options.readError)return -25204;r[0]=++reads<=(options.delayReads??0)?'':Object.hasOwn(options,'readback')?options.readback:field.AXValue;return 0;}if(!Object.hasOwn(e,k))return -25205;r[0]=e[k];return 0;},
  AXUIElementCopyActionNames:(_e,r)=>{r[0]=['AXPress'];return 0;},AXUIElementIsAttributeSettable:(_e,_k,r)=>{r[0]=options.settable??true;return options.settableCode??0;},
  AXUIElementSetAttributeValue:(e,k,v)=>{events.push({kind:'set',value:v});set=true;e[k]=v;return options.setCode??0;},AXUIElementPerformAction:()=>{events.push({kind:'press'});return 0;}});
 const run=runInNewContext(jxa+';run',{Application:()=>({processes:{whose:()=>[{}]},keystroke:()=>assert.fail('no keyboard fallback')}),ObjC:{import(){},bindFunction(){},deepUnwrap:x=>x},$:dollar,Ref:()=>[],Date:{now:()=>clock},delay:()=>{clock+=1000;}});
 return{events,query:c=>JSON.parse(run([JSON.stringify({pid:123,roles:['AXTextArea','AXTextField'],label:'Message B35',...c})]))};
}
test('composer exact AXValue setter waits for full readback and refuses incomplete input without click',()=>{
 for(const options of [{},{delayReads:2}]){const h=helper(options),r=h.query({op:'type',text:expected});assert.equal(r.ok,true);assert.equal(r.observed.readback,expected);assert.equal(h.events.filter(e=>e.kind==='set').length,1);}
 for(const options of [{readback:expected.slice(4)},{readback:''},{readback:null},{settable:false},{settableCode:-25205},{setCode:-25204},{readError:true}]){const h=helper(options),r=h.query({op:'type',text:expected});assert.equal(r.ok,false,JSON.stringify(options));assert.ok(r.observed);assert.equal(h.events.filter(e=>e.kind==='press').length,0);}
 const h=helper({buttonEnabled:false});assert.equal(h.query({op:'press',roles:['AXButton'],label:'Send message',requireEnabled:true}).ok,false);assert.equal(h.events.length,0);
});
test('Send enabled readback refuses before native click and rechecks at AX action',async()=>{
 const fn=/async function press\(pid,label,roles=\['AXButton'\],extra=\{\}\)\{[\s\S]*?\n\}/.exec(source)[0],calls=[];
 const press=runInNewContext('('+fn+')',{until:async cb=>cb(),ax:(_pid,c)=>{calls.push(c.op);return c.op==='count'?{ok:true,count:1}:{ok:true,enabled:false};},record(){},check});
 await assert.rejects(press(123,'Send message'),/SEND_ENABLED/);assert.deepEqual(calls,['count','state']);assert.ok(source.includes("label==='Send message'?{requireEnabled:true}"));
});
test('one full accepted trigger passes; none waits and truncated or duplicate messages refuse',()=>{
 const fn=/function receivedTrigger\(before,after,expected\)\{[\s\S]*?\n\}/.exec(source)[0],received=runInNewContext('('+fn+')',{check});
 const old={id:'old',kind:'text',role:'user',text:'old'},fresh={id:'new',kind:'text',role:'user',text:expected};
 assert.equal(received([old],[old],expected),null);assert.deepEqual(received([old],[old,fresh],expected),fresh);
 for(const rows of [[{...fresh,text:expected.slice(4)}],[fresh,{...fresh,id:'duplicate'}]])assert.throws(()=>received([old],rows,expected),/EXACT_RECEIVED_TRIGGER/);
 const regexText=source.split('const match=')[1].split('.exec(promptText(prompt))')[0],peer=runInNewContext(regexText);assert.equal(peer.exec(expected)[1],'banner');assert.equal(peer.exec(expected.slice(4)),null);assert.ok(source.includes('B35_PHASE_MISSING'));assert.ok(source.includes('Math.max(0,startedDeadline-Date.now())'));
});
test('trigger never sends after setter refusal and preserves exact received evidence before started wait',async()=>{
 const fn=/async function trigger\(s,kind\)\{[\s\S]*?\n\}/.exec(source)[0],messages=/function triggerMessages\(value\)\{[^\n]*\}/.exec(source)[0],received=/function receivedTrigger\(before,after,expected\)\{[\s\S]*?\n\}/.exec(source)[0];
 for(const typed of [false,true]){let requests=0;const calls=[],s={pid:123,runId:'46c70df10127cef6',control:'/owned',bots:{banner:{id:'b',threadId:'t',name:'B35'}}};
 const trigger=runInNewContext(messages+';'+received+';('+fn+')',{check,notice:()=>({text:''}),selectBot:async(_s,k)=>calls.push('select-'+k),api:async()=>({messages:++requests===1?[]:[{id:'new',kind:'text',role:'user',text:expected}]}),ax:()=>({ok:typed}),record:label=>calls.push(label),press:async()=>calls.push('send'),until:async(cb,_ms,label)=>{calls.push(label);const result=await cb();check(result,label);return result;},existsSync:()=>true,path:{join:(...x)=>x.join('/')},writeFileSync:()=>calls.push('release'),pending:async()=>({id:'pending'}),triggerFailureEvidence:async()=>calls.push('diagnostics')});
 if(!typed){await assert.rejects(trigger(s,'banner'),/COMPOSER_banner/);assert.ok(!calls.includes('send'));assert.ok(calls.includes('diagnostics'));}else{await trigger(s,'banner');assert.equal(calls.filter(x=>x==='send').length,1);assert.ok(calls.indexOf('received-trigger')<calls.indexOf('SYNTHETIC_STARTED_banner'));}
 }
});
