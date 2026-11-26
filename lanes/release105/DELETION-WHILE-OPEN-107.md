# Deleting a conversation's engine files while the owner's own CLI is open (1.0.7)

Sean, 10-25/26: Claude Code, Grok and Fuigo CLIs are open all day. Every deletion's engine copies stay owed for good, and a banner
on every chat says so ("X is open. Murage finishes removing ... once X is closed", "Trying again... Still working").

## What blocks the removal today (verified in code)
The gate is the WHOLE engine home, not the files. `planEngineHistory` (engine-history-run.ts ~98) skips a home outright when
`engineState(engine, home)` is not "closed", and `executeEnginePlans` (engine-exec.ts ~1594) refuses the home at T0, before every
step and after the last. `ConversationDeletions.foreignHomes` skips such a home before it is planned (and on every sixth try the
whole attempt finds it open again). "Open" means any process whose environment or install path resolves to that home: Sean's
`claude --resume`, its tool shells and searches (his log: holders `2.1.303`, `2.1.308`, `zsh` by "install path" / "package in
arguments"). None of those processes has the deleted conversation's files open: Murage runs every conversation in its own thread
folder, so its Claude project folder (`projects/<thread key>/`), its session side files and its Fuigo/Grok `sessions/<key>/` folder
belong to that conversation alone. Only the SHARED files (Claude's `history.jsonl`, Fuigo/Grok's `logs/unified.jsonl` and
`sessions/session_search.sqlite`, Codex's `history.jsonl`, `session_index.jsonl` and state DB) are written by the running CLI.

## The rule
When a home is open ONLY by programs Murage did not start (`foreignEngineHolders`, the existing classification; Murage's own
instances on it are held as today), Murage runs an open-home pass:
1. Plan with no database opened at all (`withDb` is not called: no SQLite read can touch the engine's -wal or -shm), exactly the
   existing ownership rules (association fingerprints, lossy-key conflicts, slug references, Codex rollout evidence).
2. Execute only the conversation-owned removals: `remove` (single files and listed folders), `rmdirIfEmpty`,
   `removeUnlessReferenced`, `unlinkIfLinkTo`. Every other step (`rewrite` of a shared file, `sqlDelete`, `ownerCheck`,
   `checkpoint`, `ftsOptimize`, `vacuumIfFree`) is not run and stays owed for the closed-engine pass, unchanged.
3. The per-file hold replaces the home gate for those steps, and nothing else is relaxed:
   - macOS, Linux: the target is first renamed aside to Murage's private name (nobody can open it by name after that), then
     `noWriters` must show, by file identity in every process's open files, that no process has any of its files open for writing
     (an unreadable process of this user counts as a writer; Linux's kernel lease answer as today). Then the association
     fingerprint is read again on the aside and must match the plan, then it is removed. Any doubt puts it back and leaves it owed.
   - Windows: each file is opened share-none before it is marked for delete, so a file the CLI has open cannot be taken at all
     (sharing violation = "held", left owed). Nothing on Windows deletes an open file.
4. Extra fail-closed checks for the open pass only: a foreign holder whose command line names one of the conversation's session ids
   (`claude --resume <id>`, `fuigo -r <id>`), or whose working folder is the conversation's own thread folder when it can be read,
   leaves the whole home to the closed pass. A home that is synced, scoped (Codex/Grok private scope), or that any unfinished redo
   journal names is not given an open pass.
5. Afterwards the home stays owed only for the shared-file steps. The closed-engine pass is unchanged and runs whenever the engine
   is closed (the existing 10-minute looks), so the privacy guarantee does not change: everything is still removed; what the
   per-file hold and the proof below allow now is removed now.

## Owner-facing words (UX, same lane)
- No banner over any chat for owed engine copies, and no "Try again now" / "Trying again... Still working". The retry is silent.
- One quiet line in Settings > Engines while anything is owed, for example "Murage is still removing 6 deleted conversations
  from Claude Code, Grok and Fuigo. It does this by itself while they are closed." It names nothing else and offers no action.
- A line is surfaced on a chat again only when something needs Sean (none of today's codes do).
- `home not read` is logged once per home when another program starts holding it, then at most hourly while it changes.

## Not changed
The closed-engine pass, its gate, the hold, CAS and redo journal, the shared-file rewrites and every SQLite step.

## Grok design r1 (REVISE, every finding taken; this section supersedes steps 1, 2 and 4 above where they differ)
- Steps the open pass runs: `remove` and `rmdirIfEmpty` only (engine-exec.ts OPEN_PASS_STEPS). `removeUnlessReferenced` (it takes
  Claude's shared history lock), `unlinkIfLinkTo` and every link are left for the closed pass: `removeGuarded`'s link branch and any
  folder tree that holds a link throw "held" in an open pass, the folder is put back, and the home stays owed.
- Codex is not given an open pass (OPEN_PASS_ENGINES: claude, fuigo, grok). Planning never opens SQLite (`withDb` returns null).
- A partial open pass keeps the record owed; it is cleared only after a closed-engine plan with no content steps.
- `not-seen` never starts an open pass.
- The proof (engine-closed.ts holdersClearOf, reading through engine-fs.ts exclOps procCwd, procFiles, lsofFiles), required for EVERY process on the home, not only the five the log keeps:
  `foreignEngineHolders` returns `pids`, every process that is the engine on that home (Murage's own and others', and any whose
  home cannot be told) and every descendant of each (its shells and tool runs). Each must have a readable working folder outside
  every target and no open file, read or write, on any target. Targets: each step's path and its aside name, and the conversation's
  thread folders. Linux reads `/proc/<pid>/cwd` and every `/proc/<pid>/fd/<n>`; macOS runs one `lsof -n -P -w -F pfn -p <pids>` and
  requires a `cwd` record for every pid. Any unreadable process, an lsof failure or a missing record is no proof: nothing of that
  home is removed while it is open.
- Ids first: the open pass runs as two jobs. The plan job returns the plans and the ids it found; the service saves them in the
  pending record; then the execute job checks journal, holders, command lines and the proof again and runs. A transcript removed
  first can no longer take with it the only place the closed pass learns a side file's session id from.

## Windows proof (built, 10-26)
Windows now gets the open pass on the same terms as macOS and Linux, through two halves:
1. Working folder (new): addon call `cwdOf(pid)` (native/engine-exclusion/exclusion.c) reads RTL_USER_PROCESS_PARAMETERS
   .CurrentDirectory.DosPath from the process's PEB (OpenProcess QUERY_LIMITED_INFORMATION | VM_READ, NtQueryInformationProcess,
   ReadProcessMemory; Reserved2[5] in <winternl.h>'s layout, the same on 32- and 64-bit builds). null on any failure, a 32-bit process on
   64-bit Windows, another user's or a protected process. holdersClearOf's Windows branch requires, for EVERY pid foreignEngineHolders
   returns: a readable cwd, absolute (drive or UNC, `\\?\` stripped), whose real path resolves (long names, subst, junctions), and
   neither form inside any target or its real path, compared case folded both ways. Anything else: no proof, closed pass only.
   Grok final r1 (APPROVE, Medium + Low taken): the real paths of every cwd and every target must be on a drive of this computer
   (driveInfo Fixed or Removable): a share, `\\localhost\C$\...` or a mapped drive can name the same folder another way, so it is
   no proof; a target whose real path (or its folder's) cannot be resolved is no proof either.
   cwdOf is optional at load (an older addon build only means no open pass on Windows) and required in a Windows package
   (scripts/engine-exclusion-resource.mjs WINDOWS_ADDON_FUNCTIONS).
2. Open files: no snapshot list is used. Every removal of the open pass takes each file with a share-none handle before marking it
   for delete (engine-exec.ts markDeleteEach, unchanged). Windows refuses that open while ANY process (not only the holders) has the
   file open for reading or writing, whatever share mode that process asked for (Node and Bun open with FILE_SHARE_DELETE; a
   share-none request still conflicts with their read or write access). Refused = "held", the home stays owed. This is atomic at the
   moment of removal, so it is stronger than a Restart Manager (RmGetList) or handle-table snapshot, which can go stale before the
   delete; Restart Manager also does not report working folders. A folder that is some process's working folder cannot be renamed or
   removed on Windows at all (the cwd handle does not share delete), so a CLI that moves into the thread folder after the check is
   still refused.
Real-addon tests: server/engine-open-proof-win-107.test.ts (Windows CI): a started process's cwd is read and judged inside/outside,
a gone process is unreadable, and a file a Node process holds open for reading cannot be taken share-none.
Not covered (fails closed, closed pass only): 32-bit engine processes on 64-bit Windows, processes of another user or elevated
above Murage, and handles opened with attribute-only access (they cannot read or write content).
