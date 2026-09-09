import { expect, it } from "vitest";
import { viewedTaskBot,withThreadUnread,initialState,reducer,type Bot } from "./store";

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
