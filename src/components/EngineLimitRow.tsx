// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { engineLimitNotice } from '../../shared/web-read-routing';
export function EngineLimitRow({ text, settings = false, botName }: { text: string; settings?: boolean; botName?: string }) {
  return <div className="flex justify-start"><div role="status" data-testid="engine-limit-note" className="min-w-0 max-w-full rounded-2xl border border-hairline/40 bg-panel px-3 py-1.5 text-[13px] text-ink-secondary [overflow-wrap:anywhere]">
    {settings && <div className="font-medium">Long web pages</div>}{botName && <span>{botName}: </span>}{text}
  </div></div>;
}
/** Calls retain persistent notices from the call's own frozen transcript. */
export function CallEngineLimits({ messages, room = false }: { messages: Array<{ id: string; kind: string; tool?: { name: string }; from?: { name?: string; botId?: string } }>; room?: boolean }) {
  return <>{messages.map(message => {
    const limit = message.kind === 'activity' ? engineLimitNotice(message.tool?.name) : undefined;
    return limit ? <EngineLimitRow key={message.id} text={limit.text} botName={room ? message.from?.name ?? 'This bot' : undefined} /> : null;
  })}</>;
}
