// Data-only policy replay in a fresh fixture, never the user's app.
import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const root=mkdtempSync(join(tmpdir(),'gnl-adapter-')),home=join(root,'home'),data=join(root,'data');
mkdirSync(home);mkdirSync(data);writeFileSync(join(data,'config.json'),'{}');
Object.assign(process.env,{HOME:home,USERPROFILE:home,MURAGE_DATA_DIR:data,NODE_ENV:'test'});
const {productionAdapter}=await import('./production.mjs');
const adapter=await productionAdapter({dataDir:data,home,platform:process.platform});
after(async()=>{await adapter.close();rmSync(root,{recursive:true,force:true});});
const row=(patch={})=>({id:'saved',tool:'Bash',fullToolInput:{command:'printf fixture'},label:{independent:true,kind:'permission-rule',actor:'owner',denySource:'deny-browser-never'},denySnapshot:{evidence:[{kind:'deny',class:'stored',ruleId:'deny-browser-never',span:'printf fixture'}]},...patch});
test('stored-deny adapter rejects missing or mismatched saved rules and proves installation and execution',async()=>{
 for(const denySnapshot of [undefined,{evidence:[]},{evidence:[{kind:'deny',class:'stored',ruleId:'different-rule',span:'printf fixture'}]}])
  await assert.rejects(()=>adapter.decide(row({denySnapshot})),/saved|rule|evidence/i);
 const got=await adapter.decide(row());
 assert.equal(got.kind,'run');assert.equal(got.actionExecuted,true);
 assert.equal(got.permissionRuleWitness?.ruleInstalled,true);assert.equal(got.permissionRuleWitness?.source,'deny-browser-never');assert.equal(got.permissionRuleWitness?.actionExecuted,true);
});
test('disabled capabilities install the actual setting and bypass permission admission at every level',async()=>{
 for(const feature of ['browser','host-computer','app-integration','channel-messages'])for(const level of ['ask','auto','full','unlimited']){
  const got=await adapter.decide(row({level,label:{independent:true,kind:'feature-off',actor:'owner',feature}}));
  assert.equal(got.kind,'off',feature+level);assert.equal(got.cards??0,0);assert.equal(got.actionExecuted,false);
  assert.equal(got.featureOff?.feature,feature);assert.equal(got.featureOff?.settingInstalled,true);
  assert.equal(got.featureOff?.actionNotRunProven,true);assert.equal(got.featureOff?.continued,true);
  assert.equal(got.featureOff?.ownerLines.length,1);assert.match(got.featureOff.ownerLines[0],/off.*Settings/);
 }
});
