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

Memory is verified for ordinary interactive use. Sustained high-throughput ingestion and continuous-search saturation tuning remain deferred; it is not a promise of unlimited recall capacity or perfect model answers.

### Fuigo memory ownership

Murage owns persistent memory for Fuigo turns and always launches its private ACP process with `--no-memory`. Murage memory being off does not activate a second engine store. This does not change standalone Fuigo defaults, edit user configuration, delete existing memories, or disable ordinary conversation history.
