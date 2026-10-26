// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The words on a channel approval's buttons and on its result line. They come from this fixed,
// reviewed table and never from a language pack: the tap is decided by the button's action
// (`:a` approve once, `:t` allow for this task, `:d` deny, or the Slack/Discord action id), so a
// pack that swapped "Approve" and "Deny" would make a person press the wrong one. Each label is
// looked up by that same action, so the word on a button always names what the button does.
// The sentence around the buttons still reads from the packs (channelReply).
import { channelReplyLanguage } from "./reply-text.ts";

export type ApprovalAction = "approveOnce" | "allowTask" | "deny";
type Labels = { button: Record<ApprovalAction, string>; result: Record<ApprovalAction | "approvedOnce", string> };

export const APPROVAL_LABELS: Readonly<Record<string, Labels>> = {
  en: { button: { approveOnce: "Approve once", allowTask: "Allow for this task", deny: "Deny" }, result: { approvedOnce: "Approved once.", approveOnce: "Allowed once.", allowTask: "Allowed for this task.", deny: "Denied." } },
  de: { button: { approveOnce: "Einmalig freigeben", allowTask: "Für diese Aufgabe erlauben", deny: "Ablehnen" }, result: { approvedOnce: "Einmalig freigegeben.", approveOnce: "Einmalig erlaubt.", allowTask: "Für diese Aufgabe erlaubt.", deny: "Abgelehnt." } },
  es: { button: { approveOnce: "Aprobar una vez", allowTask: "Permitir en esta tarea", deny: "Denegar" }, result: { approvedOnce: "Aprobado una vez.", approveOnce: "Permitido una vez.", allowTask: "Permitido en esta tarea.", deny: "Denegado." } },
  fr: { button: { approveOnce: "Approuver une fois", allowTask: "Autoriser pour cette tâche", deny: "Refuser" }, result: { approvedOnce: "Approuvé une fois.", approveOnce: "Autorisé une fois.", allowTask: "Autorisé pour cette tâche.", deny: "Refusé." } },
  hi: { button: { approveOnce: "एक बार स्वीकृत करें", allowTask: "इस कार्य के लिए अनुमति दें", deny: "अस्वीकार करें" }, result: { approvedOnce: "एक बार स्वीकृत किया गया।", approveOnce: "एक बार अनुमति दी गई।", allowTask: "इस कार्य के लिए अनुमति दी गई।", deny: "अस्वीकार किया गया।" } },
  ja: { button: { approveOnce: "1 回だけ承認", allowTask: "このタスクで許可", deny: "拒否" }, result: { approvedOnce: "1 回だけ承認しました。", approveOnce: "1 回だけ許可しました。", allowTask: "このタスクで許可しました。", deny: "拒否しました。" } },
  "pt-br": { button: { approveOnce: "Aprovar uma vez", allowTask: "Permitir nesta tarefa", deny: "Negar" }, result: { approvedOnce: "Aprovado uma vez.", approveOnce: "Permitido uma vez.", allowTask: "Permitido nesta tarefa.", deny: "Negado." } },
  zh: { button: { approveOnce: "批准一次", allowTask: "本任务内允许", deny: "拒绝" }, result: { approvedOnce: "已批准一次。", approveOnce: "已允许一次。", allowTask: "已在本任务内允许。", deny: "已拒绝。" } },
};

function labels(code = channelReplyLanguage()): Labels {
  const base = code === "pt" ? "pt-br" : code;
  return Object.hasOwn(APPROVAL_LABELS, base) ? APPROVAL_LABELS[base]! : APPROVAL_LABELS.en!;
}

/** The word on the button that performs `action`. */
export const approvalButtonLabel = (action: ApprovalAction, code?: string): string => labels(code).button[action];

/** The result line after `action` was carried out ("approvedOnce" is the permission-card wording of approve once). */
export const approvalResultLabel = (action: ApprovalAction | "approvedOnce", code?: string): string => labels(code).result[action];
