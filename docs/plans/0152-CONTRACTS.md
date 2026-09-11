# Murage 0.1.52 frozen shared contracts (K0)

Written by lane K0 on `lane/0152-K0`. Every 0.1.52 lane follows these shapes. If a lane truly has to change one, it records why in its report and in its commit message. Line references are approximate; search for the named symbol.

## Shared types

| File | Exports | Consumers |
|---|---|---|
| `shared/workspace-files.ts` | `OUTPUT_NAMESPACE`, `WORKSPACE_FILES_ROUTES`, bounds (`WORKSPACE_LIST_PAGE_SIZE` 200, `WORKSPACE_SEARCH_MAX_ENTRIES` 2,000, `WORKSPACE_SEARCH_MAX_DEPTH` 8, `WORKSPACE_TEXT_MAX_BYTES` 2 MiB), `WorkspaceScopeRef`, opaque `FileRevision`, `WorkspaceRootInfo`, `WorkspaceEntry`, list/search request and response (`cursor`, `incomplete`), `WorkspaceReadResult`/`ReadResult` (`revision`, `encoding`, `bom`, `newline`), `WorkspaceWriteRequest`/`WriteRequest` (`baseRevision`, `requestId`, `content`, `bom`), `SaveReceipt`, save-version request and response, `WORKSPACE_FILE_ERROR_STATUS` (code → HTTP status), and the guards `isWorkspaceScopeRef`, `isFileRevision`, `isWorkspaceRelativePath`, `isOutputNamespacePath`, `isWorkspaceFileErrorCode` | R3-T1, R3-T2, F4-T1..T4, F4-T7 |
| `shared/output-publication.ts` | `LocalOutputReceipt` (`producer`: `shell-output`, `image-operation` or `assistant-image`; `stage`: `retained`, `attached`, `registered` or `failed`), `OUTPUT_PUBLICATION_LIMITS` (25 MiB per file, 20 files per turn, 1 host card per turn), `OUTPUT_STAGE_TRANSITIONS`/`canAdvanceOutputStage`, and the guards | R3-T3, R3-T4 (C2), F5-T5 |
| `shared/media-assets.ts` | `MediaAsset` (exactly as in the media design), `MediaAssetRef`, `MEDIA_ROUTES`, `MediaResolveResponse`, capability constants (`MEDIA_CAPABILITY_QUERY_PARAM` `cap`, `MEDIA_CAPABILITY_TTL_MS` 10 min, token shape `mc1.<claims>.<hmac>`), `MEDIA_BYTES_RESPONSE_HEADERS`, `redactMediaCapability`, `MEDIA_PLAYABLE_MIMES` (U-28), `ImageReferenceSource` (attachment, artifact+sha256, or workspace-relative), `ResolvedImageReference {id, sha256, mime, bytes}`, `IMAGE_REFERENCE_LIMITS` (4 references, 10 MiB each, 20 MiB total), `isImageReferenceSource` | F5-T1..T5 |
| `shared/artifacts.ts` | `Artifact.producer?: OutputProducer`. The field is absent for manual or tool registration and for older rows. | R3-T2, R3-T3 |
| `server/contracts.ts` | `ProviderStopResult` (`{closeConfirmed:true}` or `{closeConfirmed:false, reason:"timeout"\|"stop-failed"}`). `interruptTurn` now returns `Promise<void \| ProviderStopResult>`. Optional `awaitTurnTeardown?(threadId, turnId)`. `stopCloseConfirmed(result)` returns `undefined` for legacy `void`. | R1-T2 (ACP core, Pi), R1-T8 |
| `electron/main-trust.mjs` | `isOwnedMainSender(event, {window, origin})` checks the same webContents, top frame, non-detached frame and exact origin, and fails closed. `mainRendererOrigin({packaged, serverPort, devUrl})`. | R2-T1, S1-T3, F4-T5 |
| `shared/questions.ts` (K0 amendment, ASK2) | `QuestionOption {label, description?}`, `QuestionSpec {id, question, header?, options[], multiSelect, allowOther, secret?}`, `QuestionAnswer {id, selected[], other?}`, `QUESTION_LIMITS` (4 questions, 10 options, 2,000-char free text), `QUESTION_TIMEOUT_MS` (30 min), `isQuestionCard`, `questionsForCard`, `questionFromChoices`, `answerComplete`, `answersAsMessage` | ASK2 (Claude), later question lanes (Codex, Fuigo/ACP, Pi, Telegram) |

## Routes (all wired in `server/index.ts`; modules own the behaviour)

| Route | Module entry point | Authority | K0 answer |
|---|---|---|---|
| `/api/workspace-files` and `/api/workspace-files/*` | `workspaceFilesRoute(request, deps)` in `server/workspace-files.ts` | Desktop proof. The entry is in `DESKTOP_AUTHORITY_ROUTES` (GET/POST), and the module hides every non-desktop call (404). | desktop 501 `{code:"not-implemented"}` |
| `/api/media`, `/api/media/resolve`, other `/api/media/*` | `mediaAssetsRoute(request, deps)` in `server/media-assets.ts` | Desktop proof (`DESKTOP_AUTHORITY_ROUTES`) | desktop 501 |
| `/api/media/bytes/<assetId>?cap=` (GET/HEAD, single range) | same | U-03 capability, deliberately exempt from the desktop header, which media elements cannot send. Until F5-T1 issues capabilities, non-desktop callers get 404. | desktop 501 |
| `POST /api/internal/resolve-image-reference` | `resolveImageReferenceRoute(request, claim, deps)` | Active `agents` internal capability. Identity (`botId`/`threadId`/`generation`) comes from the claim, never from the body. | 501; GET 405 |

**Added by F4-T5** (no existing shape changed): `WORKSPACE_FILES_ROUTES.native` — `GET /api/workspace-files/native?botId&threadId&path` → `WorkspaceNativeFile {scope, relativePath, root, revision, bytes, identity}`. The editor design lists native open/reveal as a workspace-files operation with an owner-bound capability, and the Electron main process needs an authorized file identity it can revalidate; the K0 table had no route for it. Desktop-only like the rest of the prefix, same root/link/hard-link/private-file policy as `read`, no bytes and no size limit. Only `electron/workspace-file-actions.mjs` consumes it; the renderer never sees `root` or `identity`.

Modules return `DelegatedResult {status, headers?, body?, bytes?, stream?}`, and `sendDelegated` writes it (`server/route-delegation.ts`). `deps` is `{dataDir, database, store, artifactScopes}` (`featureRouteDeps` in index.ts). Adding a dependency is a one-line change to that object. The routing lines stay as they are.

## Hooks (`server/output-publication.ts`, created once as `outputPublisher`)

- `beforeDispatch({botId, threadId, runId: dispatchClaimId, workspaceRoot: cwd, managed})` runs synchronously at dispatch, after the workspace claim and before the provider sees the prompt. `managed` is true only for the Murage-managed dedicated task workspace (not a custom folder, not a cloud run). It must not throw.
- `publishTerminalOutputs(event)` runs once per `turn.completed` in the main event fold, right after terminal-message marking. It sits **outside** the direct-run lease-release block, so R1-T2 and R3-T3 edit different hunks. It should not reject; index.ts logs a redacted message if it does.

## Schema (`server/artifacts.ts` `initializeArtifacts`, idempotent, frozen)

- `artifacts` gains nullable `producer TEXT` and `publication_id TEXT`, added with guarded `ALTER TABLE`. The existing `run_id TEXT NOT NULL` stays the run column, with `''` meaning unknown. The INSERT now names its columns.
- New `output_publications(id PK, producer, bot_id, thread_id, run_id, path_token, sha256, mime, bytes, stage, artifact_id?, attachment_id?, message_id?, error_category?, created_at, updated_at, UNIQUE(producer,bot_id,thread_id,run_id,path_token,sha256))` with indexes on `(bot_id,thread_id,run_id)` and `(stage,updated_at)`. Stage and producer values are validated in code with the shared guards (no SQL CHECK), so the enums can grow in a later release without a table rebuild.
- **No lane edits the schema after K0.**

## Rules

- **OUTPUT_NAMESPACE (U-02).** Only `outputs/` directly beneath a Murage-managed dedicated task workspace qualifies (`ensureTaskWorkspace`/per-bot default; never a custom cwd, project or HOME). Take a snapshot of `(name,size,mtime,dev/ino)` in `beforeDispatch`, and diff it on `turn.completed ok:true`. Only regular files of at most 25 MiB qualify, at most 20 per turn, with one host card per turn. Cancelled or failed turns leave receipts `retained` and do not auto-register them. Files outside the namespace stay discoverable without invented authorship.
- **Media capability (U-03, U-04).** Use a short-lived HMAC over asset + revision + surface `desktop`, with a 10-minute TTL, sent as `?cap=` on the loopback byte route. Redact it in logs with `redactMediaCapability`. Send `Referrer-Policy: no-referrer`. The reusable desktop secret never appears in a URL. All new routes are desktop-only in 0.1.52, and the companion allowlist stays default-deny (pinned by `companion/test/routes.test.ts`).
- **Image references.** Resolve every reference to pinned bytes before approval or billing. One failed reference fails the whole request, with no silent subset, no provider fallback and no numeric seed substitution.
- **Close-confirmed stop (A2).** A requested kill or an acknowledged cancel is not closure. Keep resource ownership until `closeConfirmed:true`, and retain it on timeout.
- **i18n (U-25).** Add English strings to `src/locales/en.json` only, under a key prefix for your area. Do not edit other locales or `source-hashes.json`; Q1-T4 regenerates them. An `i18n:check` failure caused only by that is expected.
- **Dependencies.** Tiptap `@tiptap/{core,pm,react,starter-kit,markdown,extension-table,extension-task-list,extension-list}` is pinned exactly to `3.31.3` in K0 (React peer `^17 || ^18 || ^19`). No other lane changes `pnpm-lock.yaml` except Q1-T3, and Q1-T3 runs alone.

## Amendment A1 — agent questions (ASK1 + ASK2, `0152-ASK-USER-RESEARCH.md` §4)

Additive only; every field is optional and older consumers keep working.

- **`RuntimeEvent` `request.opened`** gains `questions?: QuestionSpec[]` next to the existing `questionTool?: true` (ASK1). `summary` stays the first question's text and `choices` its option labels, so voice (`CallView`/`GroupCallView`) and older clients degrade gracefully.
- **`ProviderAdapter.respondToRequest`** decision gains `answers?: QuestionAnswer[]`. `message` stays the same answer as plain text for drivers that read one string. A `deny` on a question is an honest "no answer" (skipped), never a refusal — the broker used to reject it, which left the engine waiting out its whole timeout.
- **`OptionCardData`** (`server/store.ts` and the renderer's mirror in `src/state/store.tsx`) gains `questions`, `answers`, `expired`, `sentAsMessage`, `unattended`. Cards persist in `messages.db`, so a question survives a reload; a boot sweep marks anything still open as Expired.
- **Routes.** `POST /api/bots/:id/respond` and `POST /api/threads/:id/respond` accept `answers` (validated against the persisted card) and `behavior:"skip"`, plus `{behavior:"answer", answers, sentAsMessage:true}` to record an expired question's late answer after it went out through the ordinary composer route. A question is never answered with `allow`.
- **`DecisionKind`** gains `question-expired` and `question-skipped`. An answer itself is conversation, not authorization, and is never logged; a secret question's answer is never written to the transcript or the log.
- **Normalizer.** `server/question-normalize.ts` owns every engine mapping (`fromClaude`, `fromMuragebox`, `toClaudeAnswers`, `toMessageText`, `validateAnswers`, `parseAnswers`, `answersFromMessage`, `recordableAnswers`, `QUESTION_NOTES`). Engine input becomes a card only once it is bounded and well formed. Later question lanes add `from*`/`to*` pairs here rather than in a driver.

## Merge-order hotspots (lane map §2)

| File | Owners (region) | Risk | Order / mitigation |
|---|---|---|---|
| `server/index.ts` | K0 stubs · R1-T2 (interruptDirectThread, terminal lease block) · R3-T3 (hook body, `artifactScopes` runId, register) · R1-T6 (approval join) · R3-T4 and F5-T4 (image MCP route) · R2-T3 (provider replace, conditional) | H | K0 → R1-T2 → R1-T6 → R3-T3 → R3-T4 → F5-T4. R3-T3 fills the module, not the call sites. |
| `server/index.test.ts` | R3-T3 (register case) · F1-T3, R3-T4, F5-T4 (image MCP scenario) | H | One owner at a time for the image scenario: F1-T3 → R3-T4 → F5-T4. Others add new `it()` blocks. |
| `electron/main.mjs` | R2-T2 · R2-T1 · R2-T4 · R2-T5 · R2-T3 · S1-T2 · S1-T3 (sweep) · F4-T5 | H | S1-T3 runs after R2 and S1-T2 merge, and F4-T5 after S1-T3. Everyone else uses `main-trust.mjs`. |
| `electron/preload.cjs` | S1-T3 · F4-T5 | M | F4-T5 after S1-T3 |
| `server/artifacts.ts` | K0 DDL · R3-T1 (export validators) · R3-T3 (register runId/producer) · F4-T1 (save-version) · F5-T1 (read) | M | All DDL is in K0 |
| `server/image-operations.ts` (+test) | R3-T4 · F5-T4 · F1-T4 | H (test) | R3-T4 → F5-T4 → F1-T4 |
| `server/image-generation.ts` | F1 lane · F5-T4 (only if needed) | L | single F1 lane |
| `server/drivers/agents-proxy.ts` | R3-T3 · F5-T4 | L | — |
| `src/components/ChatView.tsx` | R0-T1 · F5-T2 · U0-T1 · F4-T3 · F5-T3 | H | R0-T1 → F5-T2 → U0-T1 → F4-T3 |
| `src/components/ChatMarkdown.tsx` | U0-T3 · F4-T6 · F5-T2 · F5-T3 | M | U0-T3 → F5-T2 → F4-T6 → F5-T3 |
| `src/components/Files.tsx` | F5-T2 · R3-T2 · F4-T3 | H | F5-T2 → R3-T2 → F4-T3 |
| `src/components/AttachmentPreview.tsx` | F5-T2 · F5-T3 | M | serial in the media lanes |
| `src/state/store.tsx` | F4-T3 (+ R3-T2) | L | — |
| `server/drivers/acp/core.ts` | R1-T2 · R1-T8 · R1-T4 | H | same lane, serial |
| `server/drivers/pi.ts` | R1-T2 · R1-T5 · R1-T6 | L | merge R1-T5 and R1-T6 first |
| `server/drivers/claude.ts` | R1-T1 · R1-T4 | M | R1-T4 after R1-T1 |
| `server/procs.ts` | R1-T2 · R1-T8 | M | same lane |
| `server/contracts.ts` | K0 · R1-T2 | L | shape frozen here |
| `electron/secure-credential-state.mjs` | R2-T3 · R2-T5 | M | same lane |
| `electron/skill-recorder.mjs` | R2-T1 · R2-T4 | L | same lane |
| `companion/src/browser.ts`, `devices.ts` | S1-T4 · S1-T5 · S1-T7 | M | same lane |
| `installer/bin/murage.mjs` | F2-T1 · F2-T3 · F2-T4 | M | same lane |
| `cloudflare/composio-broker/src/index.ts` | F3-T1..T3 | M | same lane |
| `package.json` / `pnpm-lock.yaml` | K0 (Tiptap) · Q1-T3 · Q1-T4 · S1-T2 (optional script) | H (lockfile) | Tiptap lands in K0; Q1-T3 later and alone |
| `src/locales/*.json` + `source-hashes.json` | every UI task | H | English keys only, under a lane prefix; Q1-T4 regenerates once |
| `.github/workflows/ci.yml` | Q1-T1 · S1-T2 (optional) | L | — |

## F4-T1 notes (lane W_F4T1, no shared shape changed)

- **Routes served.** `GET read` (200 `WorkspaceReadResult`), `POST write` (200 `SaveReceipt`), `POST save-version` (201 `WorkspaceSaveVersionResponse`). A wrong method answers 400 `invalid-request` without reading a body; non-desktop callers still get the hidden 404.
- **Body bound.** `DelegatedRequest.readBody(maxBytes?)` gained an optional per-route bound (default unchanged at 1,000,000 bytes in `server/index.ts` `readBody`). `write` uses `WORKSPACE_WRITE_BODY_MAX_BYTES` (6 × 2 MiB + 64 KiB, because JSON escaping can grow text six-fold). `save-version` uses 64 KiB. Reason: the frozen 2 MiB text bound could not be saved through the old 1 MB body bound.
- **Bot-active hold.** `featureRouteDeps` gained `projectFolders: projectTurnLeases.folders`. Every local bot turn already holds a writer lease on its working folder. An overwrite takes a restore-mode lease on the workspace for its synchronous commit window: an overlapping bot turn answers 423 `bot-writing` (nothing written), and no bot turn can start inside the window. Without `projectFolders` an overwrite fails closed with `bot-writing`. `baseRevision: null` (Save a copy) is an exclusive create (`link`, never replaces) and is allowed while a bot works. External programs do not take Murage leases; the identity recheck just before `rename` narrows but cannot close that race.
- **`SaveReceipt.artifactId`.** Before every overwrite, the revision being replaced is kept as a saved version in Files through `registerArtifact` (idempotent, no producer/run). `artifactId` names that saved version. If it cannot be kept (507 `quota-exceeded`, or `write-failed`), nothing is overwritten. A save of the unchanged bytes rewrites nothing and returns the same revision with no `artifactId`. A create has no prior revision and no `artifactId`.
- **Scope of writes.** Only `.md`/`.markdown`, ≤ 2 MiB including the BOM, well-formed Unicode (a lone surrogate is refused rather than written as U+FFFD), in a root Files already authorizes for that exact conversation (a managed workspace dispatch has not pinned yet is `scope-unavailable`). Files and folders are never created implicitly; the existing file mode is preserved and a new file is 0600. Reads accept any strict UTF-8 regular file ≤ 2 MiB. Hard-linked files answer `not-regular-file` (discovery gives them no revision). A file that changes while it is read answers `revision-conflict` without `currentRevision`.

## U1-T1 — upstream attribution and final disposition ledger (lane W_U1)

`NOTICE` now carries the Apache-2.0 attribution for every OpenMausBot change adapted into 0.1.52, with the exact upstream commit for each. The SHAs come from the lane commit bodies on `release/v0.1.52` and from `0152-UPSTREAM-RESEARCH.md` / `0152-UPSTREAM-SECURITY.md`.

**Taken (9 pull requests, 8 Murage commits).** All eight are ancestors of `release/v0.1.52`.

| Upstream | Upstream commit | Murage commit | Murage area | Kind |
|---|---|---|---|---|
| #987 | merge `391f0b2b4c8778360191820b6604fe0d4cad217f` | `e0332d62` (S1-T1) | `server/redact.ts` | adapted from source |
| #986 | merge `7aa86499bca77253d971c52826956d8c1bb639d9` | `42358cc4` (S1-T2) | `electron/app-permissions.mjs`, `electron/main.mjs` | adapted from source |
| #1023 | `a4352595a9d4d8b8df0722c3f8a5b05b6d0c25cb` | `1f708d31` (U0-T3) | `src/components/ChatMarkdown.tsx` | adapted from source |
| #762 | merge `7b73664c0ce3c72b9803347926d8bd2ada2e5f1f` (production `03d9fb3f4942259ecac44d7d94571bb53260d894`) | `f2878c5f` (U0-T2) | `src/components/Sidebar.tsx`, `src/lib/sidebar-selection.ts` | adapted from source |
| #767 | merge `1df832d3dc256461a90041c89bd51fce9425a495` (production `2eb4c7c5d32c85d8e0ae3e43d7f7861e81c2977f`) | `f2878c5f` (U0-T2) | same | adapted from source |
| #758 | merge `86b19df10a0aaebdc66f9da41c46f42d26dd3843` (earlier duplicate production `70a29ffd89eb17a8444af0941213a992a078a1cc`) | `a73d3346` (F3-T4) | `src/components/PluginsPanel.tsx` | adapted from source |
| #979 | merge `b5a8a1bbf9517dba9b9ec07e6b5b23bf65d052a9` | `b3c87e68` (F4-T6) | `src/lib/code-block.ts`, `src/components/ChatMarkdown.tsx` | adapted from source |
| #988 | `1e6737b0db71f65ec22644756be9ac2b7bf3e20f` | `692c0c99` (R0-T2) | `server/routines.ts` | schedule-preservation slice only, written independently |
| #920 | merge `368f653fecce3930f9a374a80ec1b3b9a27245d3` | `4b350ff3` (R0-T3) | `server/screen-frame-gate.ts` | namespace handling only, written independently |

A scan of every commit in `acaee1db..release/v0.1.52` for `OpenMausBot`/`upstream` finds no other upstream adaptation in this release, so the NOTICE list is complete for 0.1.52. Two of the nine were written independently against the upstream behaviour rather than copied: the NOTICE says so per item instead of claiming a uniform code lineage.

**Reviewed and not selected (ledger preserved, nothing silently dropped).** #836 Codex native instruction separation (needs a supported protocol/resume decision) · #1038 resume recovery (absence of `init` is not proof of a replayable state) · #1031 / #1037 context and CLI configuration changes · #996 Qwen configured routes · #994 RTL · #978 raw Markdown toggle · #1027 table normalization · #733 interval schedule windows · #849 / #856 / #857 Podman ownership, sandbox and font work · the new inspector, Verify, room-management and mobile features · the delegation-completion half of #988. U1-T2 (oldest-first detached routine order, the FIFO half of #988) stays a product policy choice and is **not selected** for 0.1.52 per U-27; nothing in this release changes detached traversal order, and no Murage change may be described as fixing channel FIFO.

**Framing rule for release copy.** Murage's common ancestor with OpenMausBot is the 0.1.44 source (`6140532e`). 0.1.52 adapts the nine items above and nothing else. Do not describe any upstream release as imported, and do not present the release-mirror SHA (`436271a`) as application source — the 0.1.71 app source is `32b47b03f8a327ce081f3bd33c55cab061078268`.

## F5-T3 notes (lane W_F5T3, no shared shape changed)

- **Player identity.** The renderer never turns a transcript path into a URL. `src/lib/media-resolve.ts` asks `GET /api/workspace-files/root`, `GET /api/workspace-files/list` (one directory, up to 5 pages) and `POST /api/media/resolve` with `{ref:{source:"workspace", scope, relativePath, revision}}`, the revision being the one discovery issued. A path outside the reported root, a link, a directory, a non-media file, another conversation's scope or any refusal leaves the caller's existing affordance (file chip, Save a copy) unchanged; `availability` `missing`/`changed`/`denied`/`unsupported` on an audio/video asset shows that reason beside it. Answers are shared per `(botId, threadId, path)` for 60 s.
- **Scopes offered.** ChatView passes `{botId: bot.id, threadId: bot.threadId}`; GroupView passes `{botId: message.from.botId, threadId: group.threadId}` for a member's message (the room-task scope `resolveWorkspaceRoot` authorizes) and nothing for an unattributed one. A person's own `<attached-file>` path is outside every workspace and stays a chip: the frozen `MediaAssetRef` has no user-file source, by design. On the server side `artifactScopes()` (server/index.ts) emits, per conversation, the working-folder scope **and** an R3-T4 `managedOutput: true` scope for the generated-images root, plus thread-less `threadAvailable: false` retained-artifact rows; `locateWorkspace` in `server/media-assets.ts` reads only the working folder (F5-T4's skip), and `src/lib/media-resolve.harness.test.ts` mirrors all three scope kinds so the joined test fails if that skip is lost.
- **Save a copy.** Every download link a card shows — beside the live player, on the cannot-play card and after a failure — renews through the same one-refresh path when the capability has lapsed by the clock, so a card that stopped playing never hands out a link the harness refuses.
- **Capability life.** `MediaPlayerCard` keeps the URL it was given until the element fails; if the failure is a network error, or the clock says the capability is within 15 s of `expiresAt`, it asks `LocalMedia` for one refresh (cache dropped, the three questions again) and continues from the same position. A decode (3) or codec (4, with a live capability) failure, or a second failure after a refresh, is reported and Save a copy stays. `MEDIA_CAPABILITY_TTL_MS` is unchanged.
- **Playback policy.** `preload="metadata"`, no `autoplay`, `playsInline` video; one Murage player at a time (module-level floor in `MediaPlayer.tsx`, released on pause/ended/unmount); unmount pauses, removes `src` and calls `load()` so the byte stream is released. `canPlayType` gates the element (`""` → unplayable card); the U-28 container set is the hint table `mediaHintForPath` in `src/lib/composer-attachments.ts`. Per-platform codec claims are not made; they are the WIN/MAC gate.
