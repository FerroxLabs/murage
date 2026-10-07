// Copyright 2026 Ferrox Labs
// Adapted from Hermes Agent gateway/platforms/whatsapp_common.py format_message (MIT, Nous Research);
// table handling follows OpenClaw's convertMarkdownTables "code" mode (MIT, OpenClaw Foundation).
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Markdown to WhatsApp text (design 6). Pure. Order matters and follows Hermes:
// sanitise, protect fences, tables to a code block, protect inline code, italics
// before bold, bold, strike, headers, links, restore.

const INVISIBLE = /[​⁠⁣﻿]/g;
const ODD_SPACE = /[  ᠎ -   　]/g;

/** Strips zero-width characters and folds odd unicode spaces to a plain space. NUL is removed so input cannot forge our placeholders. */
export function sanitizeOutbound(text: string): string {
  return text.replace(/\u0000/g, "").replace(INVISIBLE, "").replace(ODD_SPACE, " ");
}

const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_RULE = /^\s*\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)*\|?\s*$/;

/** Wraps pipe tables in a fenced block so WhatsApp shows them monospaced. */
function tablesToFences(text: string, save: (block: string) => string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    if (TABLE_ROW.test(lines[i]) && i + 1 < lines.length && TABLE_RULE.test(lines[i + 1]) && lines[i + 1].includes("|")) {
      let end = i + 2;
      while (end < lines.length && TABLE_ROW.test(lines[end])) end++;
      out.push(save("```\n" + lines.slice(i, end).join("\n") + "\n```"));
      i = end;
    } else {
      out.push(lines[i]);
      i++;
    }
  }
  return out.join("\n");
}

export function formatForWhatsApp(content: string): string {
  if (!content) return content;
  const sanitized = sanitizeOutbound(content);

  const fences: string[] = [];
  const saveFence = (block: string): string => `\u0000FENCE${fences.push(block) - 1}\u0000`;
  let result = sanitized.replace(/```[\s\S]*?```/g, saveFence);
  result = tablesToFences(result, saveFence);

  const codes: string[] = [];
  result = result.replace(/`[^`\n]+`/g, (match) => `\u0000CODE${codes.push(match) - 1}\u0000`);

  // Italic first so **bold** is not turned into italics by accident.
  result = result.replace(/(?<!\*)\*(?!\s|\*)([^*\n]*?\S[^*\n]*?)\*(?!\*)/g, "_$1_");
  result = result.replace(/\*\*(.+?)\*\*/g, "*$1*");
  result = result.replace(/__(.+?)__/g, "*$1*");
  result = result.replace(/~~(.+?)~~/g, "~$1~");

  // Headers become a bold line; asterisks already produced by the bold step are not doubled.
  result = result.replace(/^#{1,6}\s+(.+)$/gm, (_match, heading: string) => {
    let inner = heading.trim();
    while (inner.length > 1 && inner.startsWith("*") && inner.endsWith("*")) inner = inner.slice(1, -1).trim();
    return `*${inner}*`;
  });

  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)");

  // Restore codes, then fences (a table fence may sit inside nothing else, but order mirrors Hermes).
  fences.forEach((fence, index) => { result = result.split(`\u0000FENCE${index}\u0000`).join(fence); });
  codes.forEach((code, index) => { result = result.split(`\u0000CODE${index}\u0000`).join(code); });
  return result;
}
