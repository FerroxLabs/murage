# Memory in Murage

Murage includes managed memory: durable records, source history, scoped retrieval and owner controls. A new installation starts in Capture and recall; an installation that already has a memory setting keeps it. It belongs to the application rather than to a particular engine.

## Enable it

Open **More → Team map → Manage memory**. A bot's settings also provide a filtered memory view. Workspace administration is available to the local desktop owner; a remote session does not gain those controls.

| Mode | What happens |
|---|---|
| Off | No new capture or Murage-provided recall. Retained data stays on disk. |
| Capture only | Capture and local processing run, but memory is not added to agent turns. |
| Capture and recall (default on a new installation) | Capture, processing, scoped context and supported memory tools are enabled. |
| Paused | Retain data and incoming source capture; stop the worker and injection. |

Start with the conversations and audiences you want to retain. Excluding a conversation retires its eligible sources; removing that exclusion does not silently bring retired history back.

## Choose local retrieval

Keyword retrieval searches the local index. On Apple Silicon, Windows x64 and Linux x64, you can also download the pinned local embedding model from **Local model** to enable semantic retrieval. Murage checks its size and hashes before use; inference does not silently download model files.

Intel Macs use keyword retrieval in this release. The pinned semantic runtime does not ship an Intel Mac binding, so unsupported downloads are refused. Review, corrections, sharing, pins, forgetting and source recovery remain available.

Missing or unusable embeddings are reported as degraded keyword recall. An invalid or oversized required pin can block dispatch rather than silently lose an important owner constraint.

## Review what is remembered

Search by audience and status, then **Inspect memory** to see its text, exact version and source excerpts.

- **Approve** a candidate after reviewing it.
- **Correct** a record to create a new version.
- **Pin** an important constraint. Unpin it before archiving.
- **Share** by creating an approved copy for the selected audience.
- **Archive** material you no longer want active. Sources remain available for historical retrieval.
- **Forget** a source or record to invalidate dependent material and exclude it from future recall.

Scopes cover bots, conversations, rooms, teams, projects, workspace knowledge and selected preferences. A folder path or matching name is not automatically permission to access another audience. Sharing requires an owner decision; separate installations do not automatically synchronize memory.

**Review as skill** starts the existing `/learn` review workflow for an eligible bot with access to the source. It does not automatically install a skill. This explicit action can use the selected bot's model.

## Import existing notes

Use **Import existing notes** to preview selected bot notebooks, topic files or a team brief. Confirm the reviewed contents before importing. Bot imports begin private and are labelled as unverified imports; original Markdown files remain intact. Changed files and disallowed links are rejected instead of importing different contents from the preview.

## Local storage and provider processing

Authoritative records and source history live in the installation's SQLite database; the search index is derived and rebuildable. Local indexing and embeddings do not require a paid extraction model.

Optional model-based extraction is **off by default**. It requires an explicitly selected eligible API instance and runs with bounded requests and no tools. It produces candidates for review, not automatically authoritative facts.

When recalled context is sent to a hosted engine, that provider processes it. Optional hosted extraction also sends its selected input to the configured provider. **Forgetting cannot retract content already delivered to an external provider.** Model usage remains subject to your account and provider charges.

Memory scope controls govern Murage's own disclosure. They do not sandbox an independently running process with filesystem access under your operating-system account, and they do not grant an agent new tool permissions.

## Backups and recovery

Use Murage's installation backup and reviewed restore flow. Backups retain authoritative memory and deletion history; indexes can be rebuilt. Restoring into an existing installation merges its destination deletion ledger before activation. A fresh installation cannot infer deletions absent from its backup and requires owner review. Restored memory remains paused until reviewed.

Preserve a verified backup before migration or recovery. Do not open a migrated memory database with an older incompatible build or delete recovery markers to bypass review. For a reversible feature change, select Off or Paused in the compatible version.

### Going back to 0.1.53 after the memory upgrade

The first start of 0.1.54 or later upgrades the memory tables inside `messages.db` (schema v1 to v2). Before it does, it writes a consistent copy of the untouched v1 file to `messages.pre-memory-v2.db` next to `messages.db` (mode 0600). If that copy cannot be written, the upgrade does not run and startup stops with `MEMORY_SCHEMA_SNAPSHOT_FAILED: <reason>`; free the space or fix the permission and start again. The copy is left out of installation backups and is never deleted automatically; remove it yourself once you are sure you will not go back.

A 0.1.53 build refuses to start on an upgraded `messages.db`. To reinstall 0.1.53 and keep everything you did since the upgrade, run the downgrade step with Murage fully quit (it takes the same exclusive lease as the app and refuses while Murage is open):

```sh
# macOS
ELECTRON_RUN_AS_NODE=1 /Applications/Murage.app/Contents/MacOS/Murage \
  /Applications/Murage.app/Contents/Resources/server/installation-recovery.js \
  memory-downgrade --data-dir ~/.murage
# any platform with Node 22+: node <Resources>/server/installation-recovery.js memory-downgrade --data-dir <data dir>
```

It prints `{"ok":true,"operation":"memory-downgrade","status":"downgraded","from":2,"to":1}` (or `"already-v1"`). Chats and memory rows stay; only the v2 learning details and the learning policy settings are dropped, and the next 0.1.54 start upgrades again. Restoring `messages.pre-memory-v2.db` over `messages.db` by hand is the alternative, but it loses everything after the upgrade; if you do that, delete `messages.db-wal`, `messages.db-shm` and `memory-index.db` first so nothing stale is replayed (the index is rebuilt).

### Upgrading to 0.1.62 (memory schema v2 to v4)

Going from 0.1.61 to 0.1.62 upgrades the memory tables in `messages.db` straight from v2 to v4 in one step, after one full copy: `messages.pre-memory-v3.db` (a v2 file, so a 0.1.61 reinstall can use it). No second copy is taken. A development build that stopped at v3 gets `messages.pre-memory-v4.db` instead.

- **Disk space is checked first.** Murage needs the size of the copy plus about 10% (at least 64 MB) of working room. If the disk is short, nothing is written, `messages.db` stays at v2, and a start-up screen says how much to free; free it and open Murage again.
- **A full disk part way through** removes the partial copy and leaves `messages.db` at v2 (the upgrade is a single transaction). The copy is written as `<name>.partial` and renamed only when whole, so a copy cut short by a quit or crash is never mistaken for a finished one.
- **It can take a minute on a large history.** While it runs Murage shows "Upgrading your memory" with progress read from the growing copy, and the start-up wait is extended for as long as the upgrade reports it is running (capped at 30 minutes). Closing that screen quits Murage and stops the upgrade; nothing is changed and the next start begins it again. If the 30 minutes run out, Murage stops the upgrade the same way and says it could not finish.
- **0.1.61 and earlier cannot open a v4 file.** They stop on `MEMORY_SCHEMA_UNSUPPORTED` and show the generic "Murage couldn't finish starting" recovery page. To go back, reinstall 0.1.62 or later, quit Murage, and run `memory-downgrade --data-dir <data dir> --to 2` (the command above), then install 0.1.61. Restoring `messages.pre-memory-v3.db` by hand also works but loses everything since the upgrade. Before you start 0.1.61, move `messages.pre-memory-v3.db` (and any `messages.pre-memory-v3.db.partial`) out of the data folder: 0.1.61 does not know those names, and its backups pause with `BACKUP_UNCLASSIFIED_COMPONENT` until they are gone. The same applies if 0.1.62 could not finish the upgrade and you go back to 0.1.61.
- **A file from a newer Murage** (a memory format above 4) is refused with `MEMORY_SCHEMA_NEWER`: install the latest version, or run the newer version's `memory-downgrade --to 4` first.
- Once you are happy with 0.1.62, you can delete `messages.pre-memory-v3.db` (and `messages.pre-memory-v2.db` / `messages.pre-memory-v4.db` if present) from the data folder. They are never deleted automatically and are left out of backups.

Memory is verified for ordinary interactive use. Sustained high-throughput ingestion and continuous-search saturation tuning remain deferred; it is not a promise of unlimited recall capacity or perfect model answers.

### Fuigo memory ownership

Murage owns persistent memory for Fuigo turns and always launches its private ACP process with `--no-memory`. Murage memory being off does not activate a second engine store. This does not change standalone Fuigo defaults, edit user configuration, delete existing memories, or disable ordinary conversation history.
