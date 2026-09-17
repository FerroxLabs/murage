// Packaged main imports this bundled policy adapter; no new HTTP endpoint.
import {buildNotification} from "./notify.ts";
import {applyNotificationPreferences} from "../shared/notification-preferences.ts";
type Identity={botId:string;threadId:string;requestId:string;messageId:string;requestTurnId?:string;title:string;body:string};
type Bot={id:string;name:string;threadId:string;tasks?:{threadId:string}[];notifications?:boolean};
type CardMessage={id:string;kind?:string;role?:string;from?:{botId?:string};card?:{requestId?:string;answered?:unknown;dismissed?:boolean;expired?:boolean;title?:string;subtitle?:string}};
export function currentApprovalNotification(payload:Identity,bot:Bot|undefined,messages:CardMessage[],preferences:unknown,now=new Date()){
 if(!bot||bot.id!==payload.botId||!Array.isArray(messages))return null;
 const found=messages.filter(message=>message.id===payload.messageId);if(found.length!==1)return null;
 const message=found[0],card=message.card;
 if(message.kind!=="options"||message.role!=="bot"||!card||card.requestId!==payload.requestId||card.answered!==undefined&&card.answered!==null||card.dismissed||card.expired)return null;
 if(bot.threadId!==payload.threadId&&!bot.tasks?.some(task=>task.threadId===payload.threadId)&&message.from?.botId!==bot.id)return null;
 const notification=buildNotification("approval",bot,payload.threadId,card.subtitle??card.title??"",{requestId:payload.requestId,messageId:payload.messageId,...(payload.requestTurnId?{requestTurnId:payload.requestTurnId}:{})});
 if(!notification)return null;
 const allowed=applyNotificationPreferences(notification,preferences,now);if(!allowed)return null;
 return{botId:payload.botId,threadId:payload.threadId,requestId:payload.requestId,messageId:payload.messageId,...(payload.requestTurnId?{requestTurnId:payload.requestTurnId}:{}),title:allowed.title,body:allowed.body};
}
