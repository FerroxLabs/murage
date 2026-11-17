// SPDX-License-Identifier: AGPL-3.0-or-later
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {mutantKilled} from './mutant-verdict.mjs';

// Owners: MAIN defines the mutation; tafix-r4a pins the consumer assertion.
export function intendedAssertionKilled(green,red,restored,{root,file,testFile=file,assertion,assertions=[assertion]}) {
 if(!mutantKilled(green,red,restored)||[green,red,restored].some(run=>run.signal||run.error))return false;
 const ids=run=>run.details.tests.map(test=>JSON.stringify([test.file,test.id])).sort();
 if(JSON.stringify(ids(green))!==JSON.stringify(ids(red))||JSON.stringify(ids(green))!==JSON.stringify(ids(restored)))return false;
 const states=new Map(green.details.tests.map(test=>[JSON.stringify([test.file,test.id]),test.state]));
 if(red.details.tests.some(test=>{const state=states.get(JSON.stringify([test.file,test.id]));return state==='passed'?!['passed','failed'].includes(test.state):state!==test.state;}))return false;
 const pins=assertions.map(pin=>typeof pin==='string'?{file,assertion:pin}:pin);
 if(!pins.length||pins.some(pin=>!pin||typeof pin.assertion!=='string'||!pin.assertion||(pin.message!==undefined&&(typeof pin.message!=='string'||!pin.message))))return false;
 const sources=pins.map(pin=>({...pin,path:join(root,pin.file),source:readFileSync(join(root,pin.file),'utf8')}));
 if(sources.some(pin=>!pin.source.includes(pin.assertion)))return false;
 return red.details.tests.filter(test=>test.state==='failed').every(test=>test.file===join(root,testFile)&&test.errors.every(error=>{
  const frame=error.stack?.split('\n').find(line=>/^\s*at\s/.test(line)&&!/(?:\/node_modules\/(?:@vitest\/expect|chai)\/|^\s*at Reflect\.get \(<anonymous>\)$|^\s*at Proxy\.__VITEST_POLL_CHAIN__ \(.*\/node_modules\/vitest\/dist\/chunks\/)/.test(line));
  return sources.some(({path,source,assertion,message})=>{
   if(message&&!error.message?.includes(message))return false;
   if(!frame?.includes(path+':'))return false;
   const location=frame.slice(frame.indexOf(path)+path.length).match(/^:(\d+):(\d+)/);
   if(!location)return false;
   const [,line,column]=location.map(Number),lines=source.split('\n');
   const offset=lines.slice(0,line-1).reduce((size,text)=>size+text.length+1,0)+column-1;
   for(let at=source.indexOf(assertion);at>=0;at=source.indexOf(assertion,at+1))if(at<=offset&&offset<at+assertion.length)return true;
   return false;
  });
 }));
}
