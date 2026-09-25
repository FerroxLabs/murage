#!/usr/bin/env node
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Lint announcements.yml: node lint.mjs [path/to/announcements.yml]
//
// Runs on every pull request in FerroxLabs/murage-announcements. Fails on
// anything the app would drop and on anything the copy rules forbid, and
// writes a readable preview of each notice to the job summary.
import { appendFileSync } from "node:fs";
import { buildFeed, isMain } from "./build.mjs";

/** The preview a reviewer reads before approving. */
export function preview(feed) {
  const lines = ["## Announcements preview", "", `${feed.items.length} notice(s), ${Buffer.byteLength(JSON.stringify(feed))} bytes of 65536.`, ""];
  for (const item of feed.items) {
    lines.push(`### ${item.title}`, "", `\`${item.id}\` · ${item.kind} · ${item.layout} · ${item.accent}${item.image ? ` · ${item.image.split("/").pop()}` : ""}`, "");
    lines.push(...item.body.split("\n").map((line) => `> ${line}`), "");
    if (item.link) lines.push(`Button: **${item.link.label}** opens ${item.link.url}`, "");
    if (item.action) lines.push(`Button: **${item.action.label}** goes to ${item.action.target}`, "");
    const who = [item.appVersions && `versions ${item.appVersions}`, item.platforms && item.platforms.join(", "), item.startsAt && `from ${item.startsAt}`, item.endsAt && `until ${item.endsAt}`].filter(Boolean);
    lines.push(`Shown to: ${who.length ? who.join("; ") : "everyone"}`, "");
  }
  return lines.join("\n");
}

export function lint(path) {
  const result = buildFeed(path, { issuedAt: new Date().toISOString() });
  return { ...result, summary: result.ok ? preview(result.feed) : null };
}

if (isMain(import.meta.url)) {
  const path = process.argv[2] ?? "announcements.yml";
  const result = lint(path);
  for (const warning of result.warnings) console.warn(`warning: ${warning}`);
  if (!result.ok) {
    for (const error of result.errors) console.error(`error: ${error}`);
    process.exitCode = 1;
  } else {
    console.log(`${path}: ${result.feed.items.length} notice(s) pass.`);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, result.summary + "\n");
  }
}
