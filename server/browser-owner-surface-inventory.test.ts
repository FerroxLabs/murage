// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Every direct surface check in server/index.ts, classified for the owner's browser on a Cloud home (DESIGN section 3.5).
//
// On a home `requestSurface()` answers "desktop" for the owner's browser (it acts like the owner's phone), so each direct
// `requestSurface(...)` or `isDesktopApp(...)` use needs a stated answer. This test reads index.ts and fails when a comparison
// appears that is not in the list below, or when a listed one is gone, so a new check cannot arrive without someone deciding
// what the owner's browser gets. Anchors are line independent: the nearest route string, route pattern or function name above
// the comparison, plus its ordinal among the comparisons that share them.

import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const CLASSES: Readonly<Record<string, string>> = {
  "scoping": "what an owner reads (the phone reads the same)",
  "admits": "the owner browser acts as the owner here, as the phone does; the route table sets its tier",
  "table": "the handler admits; the route table (browser-owner-policy.ts) refuses or raises it first",
  "refused": "isDesktopApp is false for an owner browser: refused as the design lists it",
  "narrowing": "widening refused, narrowing or Revoke passes",
  "code": "admits only behind a fresh emailed code for exactly this act",
  "companion": "passes through companionAuthorized or paired, as the phone does",
  "computer-flag": "what counts as on the computer is isDesktopApp",
  "phone-view": "answered as the phone view",
  "folder": "working-folder change: no standing folder trust unless isDesktopApp",
  "question": "answered as owner; a folderTrust answer is gated by folderTrustBrowserGate first",
  "label": "only labels where the answer came from",
  "phone-surface": "an owner browser is answered as the phone",
  "config": "/api/config answer: surface for a chat-only browser is no longer desktop",
};

/** [anchor, comparison, ordinal, class], all with whitespace removed. */
const INVENTORY: ReadonlyArray<readonly [string, string, number, string]> = [
  ["/api/connector-incidents", "requestSurface(req.headers,url.searchParams)!==\"desktop\"", 1, "scoping"],
  ["/^\\/api\\/connector-incidents\\/([0-9a-f-]{36})$/", "requestSurface(req.headers,url.searchParams)!==\"desktop\"", 1, "scoping"],
  ["functionrosterAudience", "requestSurface(req.headers,url.searchParams)===\"desktop\"", 1, "scoping"],
  ["functionmayReadThread", "requestSurface(req.headers,url.searchParams)===\"desktop\"", 1, "scoping"],
  ["functionmayApprove", "requestSurface(req.headers,url.searchParams)===\"desktop\"", 1, "admits"],
  ["functionrequestOrigin", "requestSurface(req.headers,url.searchParams)===\"desktop\"", 1, "admits"],
  ["/api/", "requestSurface(req.headers,url.searchParams)===\"desktop\"", 1, "scoping"],
  ["constdesktopCaller=", "requestSurface(req.headers,url.searchParams)===\"desktop\"", 1, "admits"],
  ["/api/sentinel/summary", "requestSurface(req.headers,url.searchParams)", 1, "scoping"],
  ["if(path===CLAUDE_CODE_IMPORT_PATH&&method===\"POST\"){", "requestSurface(req.headers,url.searchParams)!==\"desktop\"", 1, "refused"],
  ["/api/setup/backup", "requestSurface(req.headers,url.searchParams)!==\"desktop\"", 1, "admits"],
  ["/api/backup-failure-notice", "requestSurface(req.headers,url.searchParams)!==\"desktop\"", 1, "admits"],
  ["/api/backup-waiting", "requestSurface(req.headers,url.searchParams)!==\"desktop\"", 1, "admits"],
  ["/api/backup-restart", "requestSurface(req.headers,url.searchParams)!==\"desktop\"", 1, "admits"],
  ["/^\\/api\\/artifacts\\/([a-f0-9-]{36})(?:\\/(?:native|preview|download))?$", "requestSurface(req.headers,url.searchParams)===\"desktop\"", 1, "admits"],
  ["ath,url,headers:req.headers,desktop:", "requestSurface(req.headers,url.searchParams)===\"desktop\"", 1, "admits"],
  ["/api/presence", "requestSurface(req.headers,url.searchParams)!==\"desktop\"", 1, "admits"],
  ["/api/phones/minted", "requestSurface(req.headers,url.searchParams)===\"desktop\"", 1, "scoping"],
  ["&&sentinelOwner({cloudHome,surface:", "requestSurface(req.headers,url.searchParams)", 1, "scoping"],
  ["/api/thread-snoozes", "requestSurface(req.headers,url.searchParams)===\"desktop\"", 1, "admits"],
  ["/api/desktop/tray", "requestSurface(req.headers,url.searchParams)!==\"desktop\"", 1, "table"],
  ["/^\\/api\\/threads\\/([\\w-]+)\\/browser-setup\\/([\\w-]+)$/", "isDesktopApp(req.headers,url.searchParams)", 1, "refused"],
  ["/api/browser-extension/clients", "isDesktopApp(req.headers,url.searchParams)", 1, "refused"],
  ["if(mode===\"full\"){", "isDesktopApp(req.headers,url.searchParams)", 1, "refused"],
  ["if(mode!==\"full\"&&!", "isDesktopApp(req.headers,url.searchParams)", 1, "narrowing"],
  ["/^\\/api\\/bots\\/([^/]+)\\/browser-extension\\/check$/", "isDesktopApp(req.headers,url.searchParams)", 1, "refused"],
  ["/^\\/api\\/bots\\/([^/]+)\\/browser-extension\\/sites$/", "isDesktopApp(req.headers,url.searchParams)", 1, "narrowing"],
  ["/^\\/api\\/bots\\/([^/]+)\\/browser-extension$/", "isDesktopApp(req.headers,url.searchParams)", 1, "code"],
  ["/api/browser/linux-sandbox/enable", "isDesktopApp(req.headers,url.searchParams)", 1, "refused"],
  ["/api/browser/linux-sandbox/enable", "isDesktopApp(req.headers,url.searchParams)", 2, "scoping"],
  ["/^\\/api\\/bots\\/([^/]+)\\/browser-choice\\/(preview|preflight|retry|cance", "isDesktopApp(req.headers,url.searchParams)", 1, "refused"],
  ["/^\\/api\\/bots\\/([^/]+)\\/browser(\\/frame)?$/", "isDesktopApp(req.headers,url.searchParams)", 1, "companion"],
  ["/^\\/api\\/bots\\/([\\w-]+)\\/watch-files$/", "requestSurface(req.headers,url.searchParams)!==\"desktop\"", 1, "table"],
  ["/^\\/api\\/bots\\/([\\w-]+)\\/watch-proposal$/", "requestSurface(req.headers,url.searchParams)!==\"desktop\"", 1, "table"],
  ["/api/routines", "requestSurface(req.headers,url.searchParams)!==\"desktop\"", 1, "scoping"],
  ["/api/routines", "requestSurface(req.headers,url.searchParams)!==\"desktop\"", 2, "admits"],
  ["uestId,answer:body.answer,onComputer:", "requestSurface(req.headers,url.searchParams)===\"desktop\"", 1, "computer-flag"],
  ["/^\\/api\\/routines\\/([\\w-]+)\\/run$/", "requestSurface(req.headers,url.searchParams)!==\"desktop\"", 1, "scoping"],
  ["chatsReader:chatsReader(req.headers,url.searchParams),", "requestSurface(req.headers,url.searchParams)!==\"desktop\"", 1, "scoping"],
  ["scoped:requestSurface(req.headers,url.searchParams)!==\"d", "requestSurface(req.headers,url.searchParams)!==\"desktop\"", 1, "scoping"],
  ["/api/mcp-grants", "requestSurface(req.headers,url.searchParams)===\"desktop\"", 1, "scoping"],
  ["constscoped=", "requestSurface(req.headers,url.searchParams)!==\"desktop\"", 1, "scoping"],
  ["/api/attachments", "requestSurface(req.headers,url.searchParams)!==\"desktop\"", 1, "admits"],
  ["}", "requestSurface(req.headers,url.searchParams)!==\"desktop\"", 1, "admits"],
  ["/api/storage/attachments/remove", "requestSurface(req.headers,url.searchParams)!==\"desktop\"", 1, "table"],
  ["/^\\/api\\/attachments\\/([\\w.-]+)$/", "requestSurface(req.headers,url.searchParams)===\"desktop\"", 1, "scoping"],
  ["\"x-content-type-options\":\"nosniff\",", "requestSurface(req.headers,url.searchParams)!==\"desktop\"", 1, "scoping"],
  ["/api/search", "requestSurface(req.headers,url.searchParams)===\"desktop\"", 1, "scoping"],
  ["/api/search", "isDesktopApp(req.headers,url.searchParams)", 1, "phone-view"],
  ["/api/house-rules", "requestSurface(req.headers,url.searchParams)!==\"desktop\"", 1, "admits"],
  ["/api/about-me", "requestSurface(req.headers,url.searchParams)!==\"desktop\"", 1, "admits"],
  ["/api/terms", "requestSurface(req.headers,url.searchParams)===\"desktop\"", 1, "admits"],
  ["/api/whats-new", "requestSurface(req.headers,url.searchParams)!==\"desktop\"", 1, "admits"],
  ["/api/announcements", "requestSurface(req.headers,url.searchParams)!==\"desktop\"", 1, "admits"],
  ["/^\\/api\\/bots\\/([\\w-]+)\\/shapes$/", "requestSurface(req.headers,url.searchParams)!==\"desktop\"", 1, "admits"],
  ["/^\\/api\\/bots\\/([\\w-]+)\\/shapes$/", "requestSurface(req.headers,url.searchParams)!==\"desktop\"", 2, "admits"],
  ["/api/skills", "requestSurface(req.headers,url.searchParams)!==\"desktop\"", 1, "admits"],
  ["rememberPickedFolder(projectCwd,", "isDesktopApp(req.headers,url.searchParams)", 1, "folder"],
  ["rememberPickedFolder(checked.cwd,", "isDesktopApp(req.headers,url.searchParams)", 1, "folder"],
  ["rememberPickedFolder(checked.cwd,", "isDesktopApp(req.headers,url.searchParams)", 2, "folder"],
  ["/^\\/api\\/groups\\/([\\w-]+)\\/read$/", "requestSurface(req.headers,url.searchParams)!==\"desktop\"", 1, "scoping"],
  ["/api/sidebar-sections", "requestSurface(req.headers,url.searchParams)", 1, "admits"],
  ["constproven=", "requestSurface(req.headers,url.searchParams)===\"desktop\"", 1, "admits"],
  ["/^\\/api\\/bots\\/([\\w-]+)\\/read$/", "requestSurface(req.headers,url.searchParams)!==\"desktop\"", 1, "scoping"],
  ["/^\\/api\\/bots\\/([\\w-]+)\\/threads\\/follow-model$/", "requestSurface(req.headers,url.searchParams)!==\"desktop\"", 1, "admits"],
  ["/^\\/api\\/bots\\/([\\w-]+)\\/limit-backup$/", "requestSurface(req.headers,url.searchParams)!==\"desktop\"", 1, "admits"],
  ["/^\\/api\\/bots\\/([\\w-]+)\\/permissions\\/refresh$/", "requestSurface(req.headers,url.searchParams)!==\"desktop\"", 1, "table"],
  ["/^\\/api\\/bots\\/([\\w-]+)$/", "requestSurface(req.headers,url.searchParams)===\"desktop\"", 1, "scoping"],
  ["if(preserveTaskSettings&&", "requestSurface(req.headers,url.searchParams)!==\"desktop\"", 1, "admits"],
  ["if(cfg.features?.phoneTools!==true||", "requestSurface(req.headers,url.searchParams)!==\"desktop\"", 1, "table"],
  ["rememberPickedFolder(checked.cwd,", "isDesktopApp(req.headers,url.searchParams)", 3, "folder"],
  ["ss=fullAccessChange(body,existingBot,", "requestSurface(req.headers,url.searchParams)===\"desktop\"", 1, "admits"],
  ["sOptions=fullAccessOptionsChange(body,", "requestSurface(req.headers,url.searchParams)===\"desktop\"", 1, "admits"],
  ["imageChoice=imageApprovalChange(body,", "requestSurface(req.headers,url.searchParams)===\"desktop\"", 1, "admits"],
  ["/^\\/api\\/bots\\/([\\w-]+)\\/assistant-profile$/", "requestSurface(req.headers,url.searchParams)!==\"desktop\"", 1, "admits"],
  ["/^\\/api\\/bots\\/([\\w-]+)\\/skills\\/library$/", "requestSurface(req.headers,url.searchParams)!==\"desktop\"", 1, "admits"],
  ["/^\\/api\\/bots\\/([\\w-]+)\\/skills\\/([a-z0-9-]+)\\/(history|rollback)$/", "requestSurface(req.headers,url.searchParams)!==\"desktop\"", 1, "table"],
  ["/^\\/api\\/bots\\/([\\w-]+)\\/engine-commands$/", "requestSurface(req.headers,url.searchParams)!==\"desktop\"", 1, "scoping"],
  ["/^\\/api\\/bots\\/([\\w-]+)\\/engine-commands$/", "requestSurface(req.headers,url.searchParams)===\"desktop\"", 1, "table"],
  ["constonComputer=", "isDesktopApp(req.headers,url.searchParams)", 1, "code"],
  ["here.attempt(`${threadId}:${requestId}`,", "requestSurface(req.headers,url.searchParams)===\"desktop\"", 1, "label"],
  ["onReply(threadId,requestId,body,skip,", "requestSurface(req.headers,url.searchParams)===\"desktop\"", 1, "question"],
  ["/^\\/api\\/bots\\/([\\w-]+)\\/message-allow$/", "isDesktopApp(req.headers,url.searchParams)", 1, "narrowing"],
  // 1.0.19 routes. The outside-surface reads and the move-in and phone-call owner routes have no owner-browser rule in browser-owner-policy.ts, so the table refuses them first; first run (/api/setup/) is plain there.
  ["/api/desktop/attention", "requestSurface(req.headers,url.searchParams)!==\"desktop\"", 1, "table"],
  ["/api/desktop/attention/held/ack", "requestSurface(req.headers,url.searchParams)!==\"desktop\"", 1, "table"],
  ["/api/desktop/attention/card", "requestSurface(req.headers,url.searchParams)!==\"desktop\"", 1, "table"],
  ["/api/phone-calls", "requestSurface(req.headers,url.searchParams)===\"desktop\"", 1, "table"],
  ["/api/setup/card", "requestSurface(req.headers,url.searchParams)!==\"desktop\"", 1, "admits"],
  ["/api/move-in/found", "requestSurface(req.headers,url.searchParams)!==\"desktop\"", 1, "table"],
  ["/api/move-in/grok", "requestSurface(req.headers,url.searchParams)!==\"desktop\"", 1, "table"],
  ["/api/setup/hire", "requestSurface(req.headers,url.searchParams)!==\"desktop\"", 1, "admits"],
  ["/api/chats", "isDesktopApp(req.headers,url.searchParams)", 1, "companion"],
  ["/^\\/api\\/(bots|groups)\\/([\\w-]+)\\/tasks(?:\\/([\\w-]+))?$/", "requestSurface(req.headers,url.searchParams)===\"desktop\"", 1, "scoping"],
  ["/^\\/api\\/bots\\/([\\w-]+)\\/tasks$/", "requestSurface(req.headers,url.searchParams)===\"desktop\"", 1, "admits"],
  ["rememberPickedFolder(startFolder,", "isDesktopApp(req.headers,url.searchParams)", 1, "folder"],
  ["constdesktopSurface=", "requestSurface(req.headers,url.searchParams)===\"desktop\"", 1, "admits"],
  ["d=true;rememberPickedFolder(checked.cwd,", "isDesktopApp(req.headers,url.searchParams)", 1, "folder"],
  ["/^\\/api\\/bots\\/([\\w-]+)\\/local-computer\\/keepalive$/", "requestSurface(req.headers,url.searchParams)!==\"desktop\"", 1, "table"],
  ["/api/desktop-secret", "requestSurface(req.headers,url.searchParams)!==\"desktop\"", 1, "refused"],
  ["method,path,query:url.searchParams,body:emailBody,", "requestSurface(req.headers,url.searchParams)===\"desktop\"", 1, "phone-surface"],
  // Restore writes keep the browser's refusal in the route table before this owner-surface projection.
  ["ethod,path,body:restoreBody,surface:", "requestSurface(req.headers,url.searchParams)===\"desktop\"", 1, "table"],
  ["/api/cli-test", "requestSurface(req.headers,url.searchParams)!==\"desktop\"", 1, "table"],
  ["/api/setup/routine", "requestSurface(req.headers,url.searchParams)!==\"desktop\"", 1, "admits"],
  ["/api/hermes/profiles", "requestSurface(req.headers,url.searchParams)!==\"desktop\"", 1, "table"],
  ["/^\\/api\\/instances\\/([\\w.-]+)\\/claude-update$/", "requestSurface(req.headers,url.searchParams)!==\"desktop\"", 1, "table"],
  ["/^\\/api\\/instances\\/([\\w.-]+)$/", "requestSurface(req.headers,url.searchParams)!==\"desktop\"", 1, "table"],
  ["/api/mcp/inspect", "requestSurface(req.headers,url.searchParams)!==\"desktop\"", 1, "table"],
  ["/api/config", "requestSurface(req.headers,url.searchParams)", 1, "config"],
  ["/api/publish/netlify/check", "requestSurface(req.headers,url.searchParams)!==\"desktop\"", 1, "admits"],
  ["/^\\/api\\/bots\\/([\\w-]+)\\/published-sites(?:\\/([\\w-]+)\\/(take-down))?$/", "isDesktopApp(req.headers,url.searchParams)", 1, "code"],
  ["/^\\/api\\/bots\\/([\\w-]+)\\/computer\\/(provision|join|sleep|exec|screensh", "requestSurface(req.headers,url.searchParams)!==\"desktop\"", 1, "companion"],
  ["case\"exec\":{", "requestSurface(req.headers,url.searchParams)!==\"desktop\"", 1, "table"],
  ["/api/no-limits/terms", "requestSurface(req.headers,url.searchParams)!==\"desktop\"", 1, "admits"],
  ["/api/help/search", "requestSurface(req.headers,url.searchParams)===\"desktop\"", 1, "scoping"],
  ["if(method===\"DELETE\"&&url.searchParams.has(\"key\")){", "requestSurface(req.headers,url.searchParams)!==\"desktop\"", 1, "table"],
];

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8").split("\n");
const squash = (text: string) => text.replace(/\s+/g, "");
const isComment = (line: string) => { const t = line.trim(); return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*"); };
const EXPR = /(?:requestSurface|isDesktopApp)\([^)]*\)(?:\s*(?:===|!==)\s*"desktop")?/g;

function anchorOfLine(line: string): string | null {
  const literal = /"(\/api\/[^"]*)"/.exec(line);
  if (literal) return literal[1]!;
  if (line.includes("path.match(") || line.includes(".exec(path)")) {
    const pattern = /\/\^.*?\$\//.exec(line);
    if (pattern) return pattern[0].slice(0, 70);
  }
  const fn = /^(?:async )?function (\w+)/.exec(line);
  return fn ? `function ${fn[1]}` : null;
}
function anchorFor(index: number): string | null {
  for (let j = index - 1; j > Math.max(index - 14, -1); j--) {
    const t = source[j]!.trim();
    if (isComment(t)) continue;
    const anchor = anchorOfLine(t);
    if (anchor) return anchor;
  }
  return null;
}
function found(): Array<{ line: number; key: string; ordinal: number }> {
  const seen = new Map<string, number>();
  const out: Array<{ line: number; key: string; ordinal: number }> = [];
  source.forEach((line, index) => {
    if (isComment(line)) return;
    for (const match of line.matchAll(EXPR)) {
      const hit = match[0];
      let anchor = anchorFor(index);
      if (anchor === null) {
        const prefix = line.split(hit)[0]!.trim();
        if (squash(prefix).length >= 12) anchor = prefix.slice(-40);
        else {
          let j = index - 1;
          while (j > 0 && (!source[j]!.trim() || isComment(source[j]!))) j--;
          anchor = source[j]!.trim().slice(0, 60);
        }
      }
      const key = `${squash(anchor)}\u0000${squash(hit)}`;
      const ordinal = (seen.get(key) ?? 0) + 1;
      seen.set(key, ordinal);
      out.push({ line: index + 1, key, ordinal });
    }
  });
  return out;
}

describe("owner browser: every direct surface check is classified", () => {
  const listed = new Map<string, string>(INVENTORY.map(([anchor, hit, ordinal, cls]) => [`${anchor}\u0000${hit}#${ordinal}`, cls]));
  const actual = found();

  test("no comparison is missing from the list", () => {
    const missing = actual.filter(item => !listed.has(`${item.key}#${item.ordinal}`)).map(item => `index.ts:${item.line} ${item.key.replace("\u0000", "  ")} #${item.ordinal}`);
    expect(missing, "a new requestSurface(...) or isDesktopApp(...) check needs a stated answer for the owner browser: add it to INVENTORY with its class").toEqual([]);
  });
  test("no listed comparison is stale", () => {
    const present = new Set(actual.map(item => `${item.key}#${item.ordinal}`));
    expect([...listed.keys()].filter(key => !present.has(key)).map(key => key.replace("\u0000", "  "))).toEqual([]);
  });
  test("every class is a known one", () => {
    expect(INVENTORY.filter(([, , , cls]) => !(cls in CLASSES)).map(row => row[0])).toEqual([]);
  });
  test("the list covers the whole file (114 checks at the time of writing)", () => {
    expect(actual.length).toBe(INVENTORY.length);
  });
});

describe("owner browser: folder trust writers", () => {
  test("every rememberPickedFolder caller asks isDesktopApp, never a bare surface check or a literal", () => {
    const calls = source.map((line, index) => ({ line, index })).filter(({ line }) => /rememberPickedFolder\(/.test(line) && !/function rememberPickedFolder/.test(line) && !isComment(line));
    expect(calls.length).toBeGreaterThanOrEqual(6);
    for (const { line, index } of calls) expect(line, `index.ts:${index + 1}`).toMatch(/rememberPickedFolder\([^;]*isDesktopApp\(req\.headers\s*,\s*url\.searchParams\)/);
  });
  test("a folder-trust question is gated before questionReply on both respond routes (one site, inside respondToCard)", () => {
    const text = source.join("\n");
    expect((text.match(/folderTrustBrowserGate\(req,/g) ?? []).length).toBe(1);
    const fn = text.slice(text.indexOf("async function respondToCard("));
    expect(fn.indexOf("folderTrustBrowserGate(req,")).toBeGreaterThan(-1);
    expect(fn.indexOf("folderTrustBrowserGate(req,")).toBeLessThan(fn.indexOf("questionReply(threadId"));
  });
});
