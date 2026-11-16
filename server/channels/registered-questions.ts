// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash } from 'node:crypto';
import { openApprovals, readApproval, answerApproval } from '../decision/index.ts';
import { questionsForCard, type QuestionSpec } from '../../shared/questions.ts';
import { parseAnswers, validateAnswers, toMessageText, QUESTION_NOTES } from '../question-normalize.ts';
import type { Store } from '../store.ts';
import type { TelegramApproval, TelegramQuestionReply } from '../telegram-approvals.ts';

function questionsForAction(action:Readonly<Record<string,unknown>>):QuestionSpec[]{
  return questionsForCard({requestId:String(action.requestId),
    subtitle:typeof action.question==='string'?action.question:'',
    options:action.options as string[],questions:action.questions as QuestionSpec[]|undefined});
}

/** Registered questions have a text row, not a permission card. Enumerate the
 * durable record and retain its exact identity through the channel offer. */
export function registeredChannelQuestions(store:Store,bot:{id:string;name:string;threadId:string;modelSelection:unknown}):TelegramApproval[]{
  return openApprovals(bot.threadId).flatMap(record=>{
    if(record.why!=='question'||record.botId!==bot.id||!store.messageById(bot.threadId,record.chatMessageId,{buildIndex:false}))return [];
    const questions=questionsForAction(record.action);
    if(!questions.length||questions.some(question=>question.secret))return [];
    return [{id:record.chatMessageId,approvalId:record.ref.approvalId,requestRef:record.requestId,actionHash:record.actionHash,
      fingerprint:createHash('sha256').update(JSON.stringify([bot.id,bot.threadId,bot.modelSelection,record.chatMessageId,record.action])).digest('hex'),
      summary:`${bot.name} has a question`,questions}];
  });
}
export async function answerRegisteredChannelQuestion(threadId:string,botId:string,offer:TelegramApproval,reply:TelegramQuestionReply):Promise<{ok:true}|{ok:false;error:string}>{
  const record=offer.approvalId&&readApproval(offer.approvalId);
  if(!record||record.state!=='open'||record.why!=='question'||record.threadId!==threadId||record.botId!==botId||record.chatMessageId!==offer.id||record.requestId!==offer.requestRef||record.actionHash!==offer.actionHash)return {ok:false,error:'This question is no longer open.'};
  const questions=questionsForAction(record.action);
  if(!questions.length||questions.some(question=>question.secret)||record.action.folderTrust&&process.env.MURAGE_CLOUD_ROLE==='home')return {ok:false,error:'Answer this question in Murage.'};
  if(reply.behavior==='skip')await answerApproval(record.ref,{behavior:'deny',message:QUESTION_NOTES.skipped});
  else{
    const parsed=parseAnswers(reply.answers),checked=parsed.ok?validateAnswers(questions,parsed.answers):parsed;
    if(!checked.ok)return {ok:false,error:checked.error};
    await answerApproval(record.ref,{behavior:'answer',message:toMessageText(questions,checked.answers),answers:checked.answers});
  }
  const settled=readApproval(record.ref.approvalId);
  return settled?.state==='answered'&&settled.delivery==='accepted'?{ok:true}:{ok:false,error:'Your bot stopped waiting for this answer.'};
}
