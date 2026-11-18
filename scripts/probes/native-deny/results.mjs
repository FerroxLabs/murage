// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash } from 'node:crypto';
import { probes, platforms } from './catalog.mjs';

export const digest = text => createHash('sha256').update(text).digest('hex');

// Parse structured traces only. A model's prose claiming it called a tool is
// never a tool attempt or a permission error. Do not return transcript text.
export function parseTranscript(raw, targets = []) {
  const facts = { attempts: 0, errors: 0, flagSettingsErrors: 0, permissionErrors: 0,
    subagents: 0, completed: false, engineError: false, authFailure: false, malformed: 0, targetAttempts: [], deniedTargets: [], outputMarkers: [] };
  const seen = new Set();
  const callTargets = new Map(), deniedCalls = new Set(), lifecycle = new Set();
  const callId = value => value.tool_use_id ?? value.toolCallId ?? value.id ?? value.item?.id ?? value.part?.callID ?? value.params?.item?.id;
  const denialText = value => {
    // Inspect only failure content. Paths (including murage-native-deny-*) and
    // tool input are not permission decisions.
    const text = JSON.stringify(value ?? '').replace(/(?:[A-Za-z]:[\\/]|\/)[^\s"<>]*/g, '');
    return /\b(?:forbidden|denied)\b|permission.*(?:reject|refus)|native-deny-probe fixture canary refused/i.test(text);
  };
  const inspect = value => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { for (const item of value) inspect(item); return; }
    const type = value.type ?? value.sessionUpdate;
    if (type === 'text' || type === 'thinking') return;
    if (['subagent_spawned', 'subagent_progress', 'subagent_finished'].includes(type)) {
      const id = value.subagent_id ?? value.child_session_id ?? `anonymous-${lifecycle.size}`;
      if (!lifecycle.has(id)) { lifecycle.add(id); facts.subagents++; }
    }
    if (type === 'tool_use' || type === 'tool_call' || type === 'tool_call_update' ||
      type === 'tool_started' || type === 'function_call' ||
      ['item.started', 'item.completed'].includes(type) && ['command_execution', 'file_change', 'mcp_tool_call'].includes(value.item?.type) ||
      value.method === 'item/started' && value.params?.item?.type === 'commandExecution') {
      const id = callId(value) ?? `anonymous-${facts.attempts}`;
      if (!seen.has(id)) {
        seen.add(id); facts.attempts++;
        if (/^(Agent|Task|spawn_agent|task|delegate|spawn_subagent)$/i.test(value.name ?? value.title ?? value.tool ?? value.part?.tool ?? '')) facts.subagents++;
      }
      const strings = [];
      const collect = input => {
        if (typeof input === 'string') strings.push(input);
        else if (input && typeof input === 'object') for (const part of Object.values(input)) collect(part);
      };
      collect(value.input ?? value.rawInput ?? value.arguments ?? value.item?.command ?? value.part?.state?.input ?? value.tool_call ?? value.params?.item?.command ?? value.title);
      for (const target of targets) if (strings.some(text => text.replaceAll('\\', '/').includes(target.value.replaceAll('\\', '/')))) {
        if (!facts.targetAttempts.includes(target.id)) facts.targetAttempts.push(target.id);
        if (callId(value) !== undefined) {
          if (!callTargets.has(id)) callTargets.set(id, new Set());
          callTargets.get(id).add(target.id);
        }
      }
    }
    const failureContent = type === 'tool_result' && value.is_error === true ? value.content :
      type === 'tool_call_update' && value.status === 'failed' ? value.content ?? value.rawOutput :
      type === 'tool_use' && value.part?.state?.status === 'error' ? value.part.state.error : undefined;
    if (failureContent !== undefined && callId(value) !== undefined && denialText(failureContent)) deniedCalls.add(callId(value));
    if (type === 'tool_result' && value.is_error === true || type === 'tool_call_update' && value.status === 'failed') {
      facts.errors++;
      const content = JSON.stringify(value.content ?? value);
      if (/flagSettings/i.test(content) && /permission|denied|deny|rule/i.test(content)) facts.flagSettingsErrors++;
      if (/permission|forbidden|denied|deny|native-deny-probe/i.test(content)) facts.permissionErrors++;
    }
    let toolOutput;
    if (type === 'tool_result' && value.is_error !== true) toolOutput = value.content;
    else if (type === 'tool_call_update' && value.status === 'completed') toolOutput = value.content;
    else if (type === 'tool_use' && value.part?.state?.status === 'completed') toolOutput = value.part.state.output;
    else if (type === 'item.completed' && value.item?.exit_code === 0) toolOutput = value.item.aggregated_output;
    const outputStrings = input => typeof input === 'string' ? [input] : input && typeof input === 'object' ? Object.values(input).flatMap(outputStrings) : [];
    for (const text of outputStrings(toolOutput)) {
      for (const marker of ['hi', 'ok', 'done', 'ref: refs/heads/probe']) {
        const matches = marker.startsWith('ref:') ? /(?:^|\s)ref: refs\/heads\/probe(?:\s|$)/.test(text) : text.split(/\r?\n/).some(line => line.trim() === marker);
        if (matches && !facts.outputMarkers.includes(marker)) facts.outputMarkers.push(marker);
      }
    }
    if (type === 'result' && value.is_error !== true || type === 'finish' || type === 'step_finish' ||
      value.method === 'turn/completed' || type === 'turn.completed') facts.completed = true;
    if (type === 'error' || type === 'turn.failed' || type === 'result' && value.is_error === true) facts.engineError = true;
    if (type === 'result' && value.is_error === true && /not (?:logged|signed) in|unauthenticated|authentication required|login required/i.test(JSON.stringify(value))) facts.authFailure = true;
    // Only protocol envelopes contain events. Inputs, tool results, text,
    // metadata and errors cannot manufacture nested tool attempts.
    if (['tool_use', 'tool_call', 'tool_call_update', 'tool_result', 'function_call'].includes(type)) return;
    if (value.type === 'user') {
      for (const item of value.message?.content ?? []) if (item.type === 'tool_result') inspect(item);
      return;
    }
    for (const key of ['message', 'content', 'params', 'update']) if (value[key]) inspect(value[key]);
  };
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { inspect(JSON.parse(line)); } catch { facts.malformed++; }
  }
  for (const id of deniedCalls) for (const target of callTargets.get(id) ?? []) {
    if (!facts.deniedTargets.includes(target)) facts.deniedTargets.push(target);
  }
  return facts;
}

export function parseVersion(raw) {
  const match = raw.trim().match(/(?:^|\s|v)(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)(?=\s|$|[),])/);
  return match?.[1] ?? null;
}

export function parseResultLine(line) {
  const row = JSON.parse(line);
  const definition = probes.find(item => item.probe === row.probe);
  if (!row || Object.keys(row).sort().join(',') !== 'engine,evidence,os,probe,result,version' ||
    !definition || definition.engine !== row.engine || !Object.hasOwn(platforms, row.os) ||
    !['PASS', 'FAIL', 'SKIP'].includes(row.result) || typeof row.version !== 'string' ||
    (row.version !== 'unknown' && parseVersion(row.version) !== row.version) ||
    !row.evidence || Array.isArray(row.evidence) || typeof row.evidence !== 'object' ||
    typeof row.evidence.reason !== 'string' || row.result === 'PASS' && row.version === 'unknown') throw new Error('INVALID-PROBE-RESULT');
  return row;
}
