import "../shared/win-hide-child-process.mjs";
// Packaged main imports this bundled policy adapter; no new HTTP endpoint.
import type {ApprovalRecordView} from "./decision/index.ts";
/** Supplied by S4 on the authenticated canonical message read. This module is
 * bundled into Electron too: it must never open a local server registry/DB. */
export type ApprovalNotificationRecord=Pick<ApprovalRecordView,'ref'|'state'|'botId'|'threadId'|'chatMessageId'|'requestId'|'actionHash'>;
import {buildNotification} from "./notify.ts";
import {applyNotificationPreferences} from "../shared/notification-preferences.ts";
type Identity={approvalId?:string;requestRef?:string;actionHash?:string;botId:string;threadId:string;requestId:string;messageId:string;requestTurnId?:string;title:string;body:string};
type Bot={id:string;name:string;threadId:string;tasks?:{threadId:string}[];notifications?:boolean};
type CardMessage={approvalRecord?:ApprovalNotificationRecord;id:string;kind?:string;role?:string;from?:{botId?:string};card?:{approvalId?:string;requestRef?:string;actionHash?:string;requestId?:string;answered?:unknown;dismissed?:boolean;expired?:boolean;title?:string;subtitle?:string;pushBody?:string}};
export function currentApprovalNotification(payload:Identity,bot:Bot|undefined,messages:CardMessage[],preferences:unknown,now=new Date()){
 if(!bot||bot.id!==payload.botId||!Array.isArray(messages))return null;
 const found=messages.filter(message=>message.id===payload.messageId);if(found.length!==1)return null;
 const message=found[0],card=message.card;
 if(!payload.approvalId||!payload.requestRef||!payload.actionHash||card?.approvalId!==payload.approvalId||card.requestRef!==payload.requestRef||card.actionHash!==payload.actionHash)return null;
 const record=message.approvalRecord;
 if(!record||record.ref.approvalId!==payload.approvalId||record.state!=='open'||record.botId!==payload.botId||record.threadId!==payload.threadId||record.chatMessageId!==payload.messageId||record.requestId!==payload.requestRef||record.actionHash!==payload.actionHash)return null;
 if(message.kind!=="options"||message.role!=="bot"||!card||card.requestId!==payload.requestId||card.answered!==undefined&&card.answered!==null||card.dismissed||card.expired)return null;
 if(bot.threadId!==payload.threadId&&!bot.tasks?.some(task=>task.threadId===payload.threadId)&&message.from?.botId!==bot.id)return null;
 const notification=buildNotification("approval",bot,payload.threadId,card.pushBody??card.subtitle??card.title??"",{requestId:payload.requestId,messageId:payload.messageId,...(payload.requestTurnId?{requestTurnId:payload.requestTurnId}:{})});
 if(!notification)return null;
 const allowed=applyNotificationPreferences(notification,preferences,now);if(!allowed)return null;
 return{approvalId:payload.approvalId,requestRef:payload.requestRef,actionHash:payload.actionHash,botId:payload.botId,threadId:payload.threadId,requestId:payload.requestId,messageId:payload.messageId,...(payload.requestTurnId?{requestTurnId:payload.requestTurnId}:{}),title:allowed.title,body:allowed.body};
}
