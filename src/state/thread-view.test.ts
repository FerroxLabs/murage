import { expect, it } from "vitest";
import { viewedTaskBot,withThreadUnread,initialState,reducer,pendingThreadActionBlocked,type Bot } from "./store";

const bot={id:"bot",threadId:"a",name:"Bot",title:"",description:"",notifications:false,color:"blue",busy:true,unread:true,modelSelection:{instanceId:"default",model:"default"},messages:[],tasks:[
  {threadId:"a",title:"A",createdAt:1,modelSelection:{instanceId:"one",model:"one",effort:"high"},autoApprove:false,busy:false,unread:false},
  {threadId:"b",title:"B",createdAt:2,modelSelection:{instanceId:"two",model:"two"},autoApprove:true,busy:true,unread:true},
]} as Bot;
it("projects the visible thread without changing bot defaults or sibling activity",()=>{
  expect(viewedTaskBot(bot)).toMatchObject({modelSelection:{instanceId:"one",effort:"high"},autoApprove:false,busy:false,unread:false});
  expect(viewedTaskBot({...bot,threadId:"b"})).toMatchObject({modelSelection:{instanceId:"two"},autoApprove:true,busy:true,unread:true});
  expect(bot.modelSelection.instanceId).toBe("default");expect(bot.busy).toBe(true);
});
it("clears only the read thread and keeps offscreen unread state",()=>{
  expect(withThreadUnread(bot,"a",false).unread).toBe(true);
  expect(withThreadUnread(bot,"b",false).unread).toBe(false);
  const state=reducer({...initialState,bots:[bot]},{type:"select",id:bot.id,threadId:"a"});
  expect(state.bots[0].tasks?.find(task=>task.threadId==="b")?.unread).toBe(true);
});
it("does not retarget a displayed transcript from a metadata-only sibling update",()=>{
  const state=reducer({...initialState,bots:[bot]},{type:"botPatched",bot:{...bot,threadId:"b",messages:undefined}});
  expect(state.bots[0].threadId).toBe("a");
  expect(state.bots[0].messages).toEqual([]);
});

const oldApproval = { id:"old-approval", role:"bot", kind:"options", at:1, card:{requestId:"old-request",tool:"Bash",options:["Allow","Deny"]} } as Bot["messages"][number];
const survivor = { id:"survivor",role:"bot",kind:"text",text:"Surviving transcript",at:2 } as Bot["messages"][number];
const deletionState = () => ({...initialState,selectedId:"bot",bots:[{...bot,messages:[oldApproval],activeLeafId:oldApproval.id}]});
const replacement = (messages?: Bot["messages"]) => ({...bot,threadId:"b",tasks:bot.tasks!.filter(task=>task.threadId!=="a"),messages,activeLeafId:survivor.id});

it("clears a deleted transcript immediately until the authoritative replacement arrives",()=>{
  const waiting=reducer(deletionState(),{type:"botPatched",bot:replacement()});
  expect(waiting.bots[0]).toMatchObject({threadId:"b",messages:[],activeLeafId:null,awaitingThreadSnapshot:true});
  expect(pendingThreadActionBlocked(waiting,{type:"send",botId:"bot",threadId:"b",text:"unsafe while loading"})).toBe(true);
  expect(pendingThreadActionBlocked(waiting,{type:"decideRequest",threadId:"a",requestId:"old-request",behavior:"allow"})).toBe(true);
  expect(pendingThreadActionBlocked(waiting,{type:"answerQuestion",threadId:"b",requestId:"new-request",behavior:"skip"})).toBe(true);
  const restored=reducer(waiting,{type:"botPatched",bot:replacement([survivor])});
  expect(restored.bots[0]).toMatchObject({threadId:"b",messages:[survivor],awaitingThreadSnapshot:false});
  expect(pendingThreadActionBlocked(restored,{type:"send",botId:"bot",threadId:"b",text:"safe after loading"})).toBe(false);
});

it("preserves intervening replacement patches and ignores duplicate snapshots",()=>{
  let state=reducer(deletionState(),{type:"botPatched",bot:replacement()});
  state=reducer(state,{type:"messagePatched",threadId:"b",message:{...survivor,text:"Newer live text"}});
  state=reducer(state,{type:"botPatched",bot:replacement([survivor])});
  expect(state.bots[0].messages[0]?.text).toBe("Newer live text");
  state=reducer(state,{type:"botPatched",bot:replacement([survivor])});
  expect(state.bots[0].messages[0]?.text).toBe("Newer live text");
});

it("accepts full-first deletion but a late replacement cannot undo explicit navigation",()=>{
  const full=reducer(deletionState(),{type:"botPatched",bot:replacement([survivor])});
  expect(full.bots[0].messages).toEqual([survivor]);
  const third={...bot,threadId:"c",messages:[{...survivor,id:"third",text:"Third thread"}],tasks:[...replacement().tasks!,{threadId:"c",title:"C",createdAt:3}]} as Bot;
  const navigated=reducer(full,{type:"taskSwitched",bot:third});
  const late=reducer(navigated,{type:"botPatched",bot:{...replacement([survivor]),tasks:third.tasks}});
  expect(late.bots[0]).toMatchObject({threadId:"c",messages:third.messages});
});
