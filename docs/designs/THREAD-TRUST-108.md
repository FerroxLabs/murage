# THREAD-TRUST-108: thread desks Murage made run trusted without a card

Lane: 1.0.8 thread-trust. Base 1a14c9110 (int/107).

## Where the prompt fires

Only Fuigo gates folders (`capabilities.folderTrust: true`, server/drivers/acp/fuigo.ts:716).
Claude Code (`-p`, no trust dialog in print mode), Codex (its approval policy, not a folder
gate) and the other ACP engines raise no folder card in Murage. A Claude model pinned through
Fuigo (Flux route) is a Fuigo turn, so it takes this path.

1. server/index.ts:3520 `folderTrustForTurn`: scans the turn's cwd
   (server/folder-trust.ts:320 `scanFolderTrustSources`). With sources and no decision,
   the driver raises the card before the spawn.
2. server/index.ts:3536: with no recorded answer, `managedWorkspaceAutoTrust`
   (server/managed-workspace-trust.ts:167) may decide "trust" for the turn's own
   thread desk when it holds only Murage's links to the skills this turn pinned
   (`.claude/skills`, `.agents/skills`, `.grok/skills`, written by procedure-bundles.ts).
3. server/drivers/acp/core.ts:2841 `askFolderTrust` raises the card; core.ts:2899
   `handleFolderTrustRequest` raises it late when Fuigo asks on its own.

## Root cause

`managedThreadDesk` accepted exactly one desk: `<dataDir>/workspaces/<botId>/threads/<threadId>`.
The desk Murage really makes is `taskWorkspacePath` (server/workspace.ts:71), which is
partition-aware: a team hand-off (`createSharedWorkTask`), a project desk
(`ensureProjectDesk`, project card runs), a room or an isolated thread of a partitioned bot,
and the general partition live under
`workspaces/<botId>.<teams|projects|rooms>/<key>/threads/<threadId>` or
`workspaces/<botId>.general/threads/<threadId>` (execution-audience.ts `partitionRoots`).
Every hand-off that landed there failed the desk check and raised the card for a folder
Murage made itself, holding only Murage's own skill links.

## The rule

A turn's folder runs trusted with no card only when ALL of these hold (all of the earlier
0.1.54 conditions are kept):

- no recorded decision for the folder (a recorded Don't trust still wins), and the user's own
  Fuigo store does not already decide it;
- the desk is the one Murage computes for this bot and thread (`taskWorkspacePath`, passed
  in by index.ts), and it has a Murage desk's shape, checked again in the module
  (`deskComponents`): inside `<dataDir>/workspaces`, owned by this bot by name
  (`<botId>`, `<botId>.general`, or `<botId>.<teams|projects|rooms>/<safe key>`), ending in
  `threads/<threadId>`; no `..`, safe ids only;
- every component from the real data dir down to the desk is a real directory (lstat, no
  symlink or junction), and the folder's realpath is exactly that desk;
- the engine's grant key is the desk itself (no git root above it, no registry collapse);
- every trust-sensitive source is a Murage skill root, and every entry in every skill or
  command root is a link into a published bundle this turn pinned.

Owner-pointed folders (a picked working folder, a room folder, a project work root) are never
the desk, so they keep today's decision exactly: record, card, or full-access approval.

## Not claimed

- Desks are not given an inherited record from the bot workspace; each turn decides again
  from what the desk holds, and nothing is recorded by Murage (as in 0.1.54).
- A desk holding anything else (AGENTS.md, .mcp.json, hooks, a hand-made skill folder) still
  asks, even though the bot may have written it.
- A late request from Fuigo for something Murage's scan does not name still raises the card.
- A legacy room turn running in the bot workspace root (`legacyRoomWorkspace`) is not a
  thread desk and still asks.
- The fix was not reproduced against the 1.0.6 dry-run data; the cause is read from code.
  No other engine raises a folder card, so no other engine is changed.
