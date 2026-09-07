# Murage memory

This describes the memory candidate in this source tree. It is not a release notice. Current acceptance, native-engine and packaging gates are recorded in `.planning/STATE.md` and `.planning/memory-evidence/`.

## Owner controls

Open **More → Team map → Manage memory** for workspace management. Bot settings also expose a bot-filtered view. These controls require the local desktop authority proof; remote sessions cannot inspect or administer workspace memory through the owner API.

Search by audience and status, then inspect a record to see its exact version and source excerpts. Approve candidates explicitly. Corrections create new versions. Sharing creates a separate approved copy for the selected audience. Pin important constraints manually; pinned records are not silently truncated to fit a prompt. Unpin before archiving. Archived records retain their sources and remain available to historical retrieval. Forgetting invalidates dependent records and future recall; text already delivered to an external provider cannot be withdrawn.

**Review as skill** starts the existing `/learn` workflow for an eligible bot that already has access to the source. It does not activate a skill. The existing review card still controls installation, and staging/approval revalidate the exact memory source ticket. That explicit owner action can use the selected bot's model.

## Modes and local model

| Mode | Behavior |
|---|---|
| Off | No new capture or service-provided recall; retained data stays on disk. |
| Capture only | Capture and local processing run; memory is not injected into turns. |
| Capture and recall | Capture, processing, scoped bundles and memory tools are enabled. |
| Paused | Retain data and incoming source capture; stop the worker and injection. |

Mode and exclusion restrictions invalidate prepared access. Excluding a conversation retires its existing eligible sources. Removing that exclusion does not silently restore retired history.

The local embedding model is pinned by `shared/memory-model-manifest.json`. The owner can request its download from the Local model section. Size and SHA-256 checks precede use; inference never silently downloads assets. Missing or unusable embeddings are reported as degraded lexical recall. Required pinned constraints still require valid authoritative sources; failure or overflow blocks dispatch.

Optional extraction is off by default. Only a configured instance exposing a tool-free capped extractor is selectable. The current adapter is OpenAI-compatible. Requests have no tools or retries, one extraction runs at a time, and input/output reservations are durable. Limits are six calls/minute, 100,000 conservatively estimated input tokens/day and 20,000 output tokens/day, with at most 2,000 output tokens per call. Extraction creates review candidates, not authoritative facts.

## Existing notebooks

Use **Import existing notes** to preview selected bot notebooks/topic files or a team brief. Imports retain reviewed bytes, path/hash provenance and an unverified-import label. Bot imports start private. Symlinks, changed review policy and forgotten hashes are rejected. Atomic retry avoids duplicate imports. Original Markdown files remain intact; the new service does not resume legacy private notebook injection into rooms.

## Storage and scope

`messages.db` contains authoritative sources, versions, jobs, records, evidence, disclosures and deletion history. `memory-index.db` is derived and rebuildable. One owned worker performs local indexing and embedding work. Scopes cover bots, conversations, rooms, teams, projects, workspace knowledge and preferences; sharing requires owner authority.

These are application access boundaries. They do not sandbox a hostile process running as the same OS user. An engine's independent filesystem access remains governed by its existing tools and permissions.

## Recovery and rollback

Preserve the original installation and a verified backup before any separately authorized live rollout. The current memory candidate has not been authorized to migrate the running private.7 profile.

Use the existing installation backup, inspection, restore-review and rollback flow with a compatible candidate binary. Backups retain authoritative memory and deletion history; derived indexes can be rebuilt. Restoring into an existing installation merges its destination deletion ledger before activation. A new installation cannot know deletions absent from its backup and requires owner review. Restored memory remains paused until reviewed.

Feature rollback means selecting Off or Paused with the compatible binary. Do not open a migrated memory database with private.7, remove recovery markers, or delete retained recovery copies to bypass review. See [memory verification](verification/memory.md) for evidence boundaries and fixture commands.


## Intel macOS

Intel Macs use keyword retrieval in this release because the pinned native semantic runtime does not provide an Intel macOS binding. Owner review, corrections, sharing, pins, forgetting and source recovery remain available. Unavailable semantic-model downloads are refused on Intel Macs; no semantic inference is claimed there. Apple Silicon, Windows x64 and Linux x64 retain the native local-model path.
