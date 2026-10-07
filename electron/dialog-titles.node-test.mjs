// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 0.1.60 testers: native question boxes on Windows and Linux were titled
// "murage" in lower case (the app's package name), and the Mac "Restart into
// Backup mode?" box had no Return button. Every message box names Murage, and
// the Backup mode box answers Return with the choice the owner just made.
import assert from "node:assert/strict";
import test from "node:test";
import {readFileSync} from "node:fs";

const sources=["main.mjs","installation-recovery-window.mjs"].map(name=>[name,readFileSync(new URL(`./${name}`,import.meta.url),"utf8")]);

/** The options object literal of each dialog.showMessageBox(parent, {...}) call. */
function messageBoxOptions(source){
 const found=[];let at=0;
 while((at=source.indexOf("dialog.showMessageBox(",at))>=0){
  const open=at+"dialog.showMessageBox(".length;let depth=1,index=open,start=-1;
  // Walk the call's arguments to its closing parenthesis, skipping strings.
  while(depth>0&&index<source.length){
   const c=source[index];
   if(c==="\""||c==="'"||c==="`"){index+=1;while(source[index]!==c){if(source[index]==="\\")index+=1;index+=1;}}
   else if(c==="("||c==="{"||c==="["){if(c==="{"&&depth===1&&start<0)start=index;depth+=1;}
   else if(c===")"||c==="}"||c==="]")depth-=1;
   index+=1;
  }
  found.push(start<0?null:source.slice(start,index-1));at=index;
 }
 return found;
}

test("every native message box is titled Murage, or names its own title",()=>{
 let literal=0;
 for(const[name,source]of sources){
  for(const options of messageBoxOptions(source)){
   if(options===null)continue; // an options variable built with its own title (checked below)
   literal+=1;
   assert.match(options,/\btitle\s*:/,`${name}: ${options.slice(0,120)}`);
  }
 }
 assert.ok(literal>=9,`found ${literal} message boxes`);
 const main=sources[0][1];
 assert.match(main,/const options=\{type:"info",title:"Murage stays available"/);
});

test("Return confirms Restart into Backup mode",()=>{
 const box=messageBoxOptions(sources[0][1]).find(options=>options?.includes("\"Restart into Backup mode\""));
 assert.ok(box);
 assert.match(box,/buttons:\["Cancel","Restart into Backup mode"\], defaultId:1, cancelId:0/);
});
