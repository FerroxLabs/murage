# Murage 0.1.52 release notes draft (Q1-T4)

Status: **draft, written from the merged commits only.** Not a public
announcement and not a qualified installer. Regenerate the "What ships" section
after every further lane merge (see "How to refresh this draft" at the end).

- Shipped baseline: 0.1.51 at `acaee1dbfb5551ae41d5f0d24c6bf3a314e5a282`.
- Integration head this draft was written from: `37c2822d` on
  `release/v0.1.52` (168 commits since the baseline, 120 non-merge —
  `git rev-list --count --no-merges acaee1db..37c2822d`; an earlier
  revision of this draft said 110), plus this lane's locale regeneration
  on top. The branch has moved since (`cae69216` at the RED2C edit: 185
  commits, 134 non-merge); sections 1 and 3 still describe `37c2822d`
  until the refresh in section 5 is re-run.
- Version: `package.json` is `0.1.52` (the only surface
  `scripts/release-guard.mjs version` reads; it prints `0.1.52`). The
  companion, docs and control-plane manifests carry their own independent
  versions and are unchanged.
- Bundled engine: `scripts/prepare-fuigo.mjs` pins `FUIGO_VERSION = "1.0.13"` (FUIGO13; was 1.0.12 at LFU2, 1.0.11 at LFU).
- Already shipped in 0.1.51, not a 0.1.52 change: `15c3cbd6` "fix(packaging):
  sign Windows recovery helper" is the parent of the `acaee1db` baseline
  (`git merge-base --is-ancestor 15c3cbd6 acaee1db` is true). It must not
  appear in the 0.1.52 notes.
- Every lane branch except `lane/0152-LINUXFIX` is an ancestor of
  `release/v0.1.52` (checked with `git branch --merged release/v0.1.52`).

Framing rule for the published notes: every entry says what the user gets
(added, enhanced, hardened, tightened). No entry is called a bug fix. Every
entry below is backed by a commit named in the ledger (section 3); nothing is
inferred from the plan.

---

## 1. Draft release body (for the murage-releases draft)

Paste-ready once the candidate is frozen. The headers below (Added /
Enhanced / Hardened / Quality) are the announcement framing Sean uses; they
are not the `.github/release.yml` categories (New features / Fixes /
Documentation / Other changes), which GitHub applies to the auto-generated PR
list separately.

### Murage 0.1.52

This release gives every bot a workspace you can see and edit beside the
chat, lets a bot ask you a real question and get a real answer, brings local
models into the product as a first-class setup, and adds inline images, audio
and video that never leave your machine unverified. Underneath it, the engine
runtime, the desktop process, the companion and the hosted broker each
close a set of audited gaps, and all seven language packs are complete.

**Added**

- **A workspace pane beside the chat.** A resizable Workspace rail on the
  right of the conversation (chat keeps at least 360 px, rail at least 320 px,
  width remembered), a covering overlay with Back to chat on narrow screens,
  and an Expand mode. The rail lists the selected conversation's files, opens
  them in tabs named by scope and relative path, and previews Markdown
  (rendered or Source), protected HTML in a sandboxed frame, plain text,
  images, and a truthful open/download fallback for everything else. A single
  click reuses one clean preview tab; Keep open and Edit make a tab
  persistent; a dirty tab is never replaced and asks before it closes.
  Actions: Save, Save a copy, Save this version, Download, Open in app, Show
  in folder, Open in Files.
- **A Markdown editor that only writes on Save.** Rich editing runs on Tiptap
  3.31.3 and opens a file in rich mode only when the pinned parser is proven
  to round-trip that file byte for byte; anything else opens in Source mode
  on the exact text. Reloads never become edits. Saves are conditioned on the
  revision you opened: a file a bot changed underneath you becomes a conflict
  that shows both texts with Use the disk version / Keep my version, and a
  save while a bot turn holds that folder is refused with a plain message
  and nothing written. The revision you replace is kept as a saved version in
  Files first, so nothing is overwritten unless it was retained. Unsaved
  typing survives a crash: drafts live in the renderer (50 drafts, 10 MiB),
  are labelled separately from "File saved", and a recovered draft found
  after you started typing is held until you choose.
- **Files shows the workspace, not only saved copies.** Files now carries
  both halves: the conversation's working folder as it is on disk right now
  (lazy folders, breadcrumbs, name search with an honest "incomplete" state,
  200 entries per page) and the saved versions that never change. Every row
  is labelled "Workspace file" or "Saved copy". Legacy conversations pinned
  to no workspace and remote runs say exactly that instead of listing your
  home folder. Open in app and Show in folder hand one live file to the OS
  through an owner-bound, extension-allowlisted bridge that re-checks the
  file's identity immediately before the call.
- **Bot outputs are saved automatically.** A file a bot writes into the
  managed `outputs/` folder of its task workspace during a turn (regular
  files up to 25 MiB, at most 20 per turn) becomes a verified saved version
  in Files with producer and run provenance and one host-authored card in the
  chat, with no `register_artifact` call. A failed or cancelled turn leaves
  the receipts retained and registers nothing. Generated images are receipted
  before they are attached, so an interrupted publication resumes on restart
  from the retained bytes with zero provider calls and no duplicate message.
- **A question card, end to end.** When Claude Code, Codex, Fuigo, an ACP
  agent or Pi asks you a question (AskUserQuestion, requestUserInput,
  ask_user_question, elicitation, select/input/editor), Murage now shows a
  card with the questions, options, descriptions, multi-select, Other and
  free text, fully keyboard-driven (1-9, Tab, Enter, Esc), and sends the
  engine exactly the answer shape it documents. A question is never
  auto-approved, never remembered as "Always allow" and never auto-reviewed;
  skipping it is delivered at once instead of leaving the engine waiting.
  The engine waits 30 minutes; after that the card stays as Expired with
  "Send as a message" so a late answer still reaches the bot. Cards persist
  across restarts. A URL elicitation is shown as a link you open; Murage
  never fetches it for you.
- **Questions on Telegram.** The same card reaches the paired Telegram owner
  as its own message per question: numbered options with one inline button
  each, multi-select toggles with Submit, "Reply with text" for a free-text
  answer, and Skip. Answers go through the same validation as the desktop
  card; a stale, forged, foreign or expired tap does nothing. Secret
  questions stay in-app.
- **Local models, as a real setup.** Settings → Models gains a permanent
  Local models section that says which addresses automatic detection
  checked (Ollama, LM Studio, llama.cpp, vLLM, SGLang), lets you add, edit
  and remove your own servers (loopback, home network or tailnet over plain
  http; https otherwise; key write-only), and runs a seven-check tool-calling
  test per model with a one-sentence outcome ("Tools work — ready for
  agents", "Context too small for agents") and the checks behind a
  disclosure. Loaded context is read from the server; Ollama gets a "create a
  64K copy" action. Fuigo, Pi, OpenCode, Qwen Code, Hermes, Droid and Kimi
  are wired to a tested model; Codex and Claude Code rows appear only after
  their own surface test passes. The picker's Local rail shows "model ·
  server" and marks a model whose tool test failed. Live proof against a
  llama.cpp Qwen3.8-27B host: four engines completed real tool-using turns.
- **Inline images with a lightbox.** One accessible image surface for
  attachment galleries, Markdown images, screen frames and the Files saved-copy
  preview: a native modal dialog with focus trapping, Arrow/Home/End
  navigation inside the message's own set, alt text, reduced-motion support,
  contain-never-crop thumbnails, and Download of exactly the bytes shown.
  Remote Markdown images are an external card until you click Load (fetched
  with no referrer); local paths, `file://`, `blob:` and SVG are never
  requested.
- **Audio and video players for a conversation's own files.** A WAV, MP3,
  Ogg, M4A, MP4 or WebM path in a transcript becomes a player only after the
  harness confirms the conversation has a dedicated workspace, the exact
  relative path is a regular file inside it right now, and the bytes are a
  type this build streams. Playback goes through the authorized byte route
  with a short-lived capability; the path itself is never fetched. No
  autoplay, metadata preload, one player at a time, seeking through range
  requests, Save a copy on every card including the ones that cannot play.
  An expired capability is renewed in place mid-listen.
- **"Use as reference".** From the lightbox, add a conversation image
  (uploaded, generated or a saved PNG/JPEG/WebP up to 10 MiB) to the next
  message as an ordinary attached-image chip, so the bot can pass it to
  `generate_image`. Bots get a `resolve_image_reference` tool that pins
  uploaded, generated, saved or workspace images to exact bytes (up to four,
  20 MiB total) and discloses what it prepared before any approval.
- **Image edits on xAI and OpenRouter.** `grok-imagine-image-2.0` edits one
  to four reference images through xAI's JSON edit endpoint; OpenRouter
  `openai/gpt-image-2` sends references only when the pinned `openai`
  endpoint advertises a compatible range (checked within 15 s just before
  approval, fail closed, no fallback). Each provider's key is attached only
  to its own exact origin. Image settings now show each model's true edit
  capability and reason ("Creates and edits images", "Creates images only:
  …") and the reference limit it accepts.
- **Connected apps through FluxRouter.** Connected apps can now run through
  a FluxRouter account. The FluxRouter key is spent once, in the main
  process, to mint a broker token that never reaches an engine subprocess,
  so a shell command a model runs can never read your Gmail past per-bot
  policy. An existing install's Composio identity is adopted, not copied,
  through a three-leg claim (sign, redeem, confirm) so a stranded migration
  loses nothing; a personal account auto-claims, a shared team account moves
  only on an explicit button. FluxRouter claims are on for this release: the
  Worker has issued them since rollout step 5 and FluxRouter has redeemed them
  since step 6 (2026-09-11), and the committed Worker config ships
  `CLAIM_MODE` open with new-install registration closed (step 8, the day
  this release publishes). The release freeze sets the desktop's FluxRouter
  broker URL and legacy cut-off date.
- **Unattended `murage` for provisioning.** `--non-interactive` / `--yes` /
  `MURAGE_NON_INTERACTIVE` never prompts; anything missing is listed all at
  once and the run exits 2 having changed nothing. Secrets come from a file,
  stdin or the environment, never from argv (`--provider-key <value>` is
  refused by name). Every choice has a flag and an env form; exit codes are
  documented (0 secured, 1 cannot run here, 2 incomplete request, 3 not on
  the tailnet).
- **Save a code block.** Chat code blocks gain Save beside Wrap and Copy:
  exactly the bytes Copy would copy, a file name from the fence language
  (Dockerfile and Makefile keep their names; launcher extensions fall back to
  `snippet.txt`), no network request.
- **Engine lifecycle diagnostics.** ACP children (Fuigo included) record a
  bounded, secret-refusing `engine_lifecycle` trail (spawn, RPC, stop route,
  settle, close) with a per-process generation, written to the existing 0600
  native log, so an engine incident can be read from evidence.

**Enhanced**

- **A chat header that measures itself.** The header tries layouts
  richest-first until one fits with a usable name track: fold role, usage
  and Inspector into a keyboard-accessible More menu, trim chips to icons,
  take a deliberate two-row header, then relocate controls. Bot identity,
  Stop, the task/model context and Call never move. It reacts to the chat
  container, not the viewport, so an open sidebar folds it the same way.
  Proven at 320 to 1024 px, 200% text and long pseudo-locale labels. The
  folder chip opens the effective workspace and names the resolved location.
- **Sidebar rows stay clickable.** A bot row keeps its full hit area during
  rename, and the invisible disabled Archive control that swallowed clicks
  on the Chief, team leads and the last bot is gone; the More menu still
  explains why Archive is unavailable.
- **Long inline code and link labels wrap inside the bubble** instead of
  pushing a table or the transcript into a sideways scroll; fenced blocks
  keep their horizontal scroll and wrap toggle.
- **Local contention gets local advice.** A thread refused because another
  thread holds the same folder, computer or browser profile shows a
  "Waiting on another thread" card with wait/stop/retry guidance instead of
  the provider-settings card.
- **First Composio account gets a label.** Connect now opens the label form
  for the first account too, with Cancel and Escape, so an account is never
  created under a generated id.
- **Memory corrections reviewed precisely.** Approving an agent-proposed
  correction validates the exact target revision, supersedes only that
  record (kept as history) and, when the target is pinned, requires an
  explicit transfer-or-unpin choice with nothing preselected.
- **Routines keep a due run across an edit.** Renaming, changing
  instructions or the timeout of a routine after an occurrence became due no
  longer moves that occurrence into the future; a changed schedule still
  recalculates.
- **Screen frames settle under every tool spelling.** A screenshot reported
  as `computer__screenshot` (server-qualified, no `mcp__` prefix) now counts
  as screen work and settles its frame in the transcript.
- **Grok, OpenAI-compatible and MiniMax streams are judged honestly.** A
  stream completes only with `[DONE]` or a finish frame followed by clean
  EOF; an in-band error, a truncation or an empty reply fails the turn with
  its reason, and the text that did arrive is kept on the failed message
  rather than dropped.
- **Pi runs the model you picked.** A rejected or timed-out `set_model` (or
  session handshake) fails the turn before any prompt is written instead of
  silently running Pi's default; a bare model id fails before a child is
  spawned. Pi's host-computer asks carry the local-computer scope so they
  are never remembered as "Always allow" or auto-reviewed.
- **Fuigo bundle 1.0.13.** Every target tarball checked byte-identical to
  the upstream release-workflow artifact (run 34623419288, source 1f5f89ab;
  no GitHub release v1.0.13 exists — the workflow publishes npm only) and
  SHA-512/SHA-1 against npm integrity/shasum and the run's release
  manifest; `third_party/fuigo` provenance updated. 1.0.13 is the first
  published Fuigo whose folder-trust gate is live (1.0.11/1.0.12 binaries
  were dev-stamped and auto-trusted every folder): a hosted turn in a folder
  the user has not trusted in Fuigo runs without that folder's repo-local
  MCP/hooks/permission rules and, new in 1.0.13, its AGENTS.md/CLAUDE.md
  and project skills. It never blocks (no prompt on a piped stdio session).
  `auto` mode stops auto-running discarding git checkout/switch/stash and
  `rg --hostname-bin`; those now reach Murage's permission card. The
  1.0.12 `ask_user_question` gate and question card path are unchanged.
- **Folder trust is a question, not a silent loss (FUIGOTRUST1).** Left
  alone, 1.0.13's gate would have dropped every workspace's AGENTS.md,
  CLAUDE.md, .mcp.json, skills and hooks from every hosted Fuigo turn
  unless the person had run `fuigo --trust` in a terminal. Murage now asks
  once per folder: a folder chosen in a working-folder picker is trusted
  when it is chosen (the picker says so), and any other folder with those
  files — a bot-created folder, a clone, a subfolder with its own repo —
  raises a "Trust this folder?" card naming what it contains, before the
  engine starts; the answer is remembered per folder (Settings shows it,
  with Forget). Trust is passed to Fuigo as `--trust`, so the same turn
  reads the instructions; Don't trust runs the turn without them and the
  conversation shows what was left out; nobody answering in time ends the
  turn as a stopped turn. Auto mode never trusts a folder, and only the
  desktop or the paired Telegram channel can. Murage also advertises
  Fuigo's interactive trust capability and answers its request from the
  same decision. Proven against the bundled 1.0.13 binary on a local model:
  an AGENTS.md canary is absent untrusted and present the moment the card
  is answered Trust. Follow-ups (FUIGOTRUST2): folders your bots were
  already working in before this release are treated as trusted — you chose
  them in Murage — so the upgrade raises no card for them (Forget in the
  picker asks again); a folder you trusted in standalone Fuigo (`fuigo
  --trust`) is honoured as trusted here too, with no card and no "untrusted
  folder" notice, and the picker says which install trusts it; a card the
  engine raised on its own that the turn outran now says the turn ran
  without the folder's files instead of "stopped"; folder trust is
  recorded from a picker only on the desktop, including a team imported as
  a project; and a provider-routed turn that never started (card stopped or
  timed out) no longer leaves its temporary Fuigo home behind. Further
  follow-ups (FUIGOTRUST3): a bot working in a linked git worktree shares
  its trust with the main checkout, exactly as Fuigo keys it, so `fuigo
  --trust` on the main repo covers every worktree and a worktree picked in
  Murage is remembered for the whole repo; a folder Fuigo itself still asks
  about is never trusted on Murage's reading of Fuigo's store alone — your
  own answer, or the card, decides; a card the engine raised on its own
  under a turn that then failed says the turn failed, not "stopped"; and
  the picker note reads the Fuigo install of the bot it belongs to when
  several Fuigo instances run with different homes.
- **Images can be saved without touching the source.** Choosing the source
  file itself (or a hard/symlink alias) as the Save destination is a no-op
  rather than a truncation; every other destination is written to an
  exclusive sibling and published with one rename.
- **Installer ergonomics.** `setup` reruns keep every stored provider key and
  custom setting unless you replace one; the env file is published
  atomically with a `.previous` copy; secrets are read with no terminal echo
  and no readline history; `setup` and `start` refuse a Node below the
  payload's floor (24) before any side effect.
- **Companion registry that cannot lose a fleet.** An unreadable
  `devices.json` marks the registry unavailable (pairing answers 503, the
  bytes stay untouched) instead of being treated as an empty first run; a
  failed revoke write rolls memory back and answers a sanitized 500 with the
  streams untouched.
- **Docs and control-plane dependencies patched.** `next` 16.3.3 and
  `vitest` 4.1.11 in their own packages only; the desktop lockfile importer
  is byte-identical. `pnpm audit --prod` goes from 2 Critical / 4 High / 3
  Moderate to 0 / 4 / 1, with the remaining sharp and adm-zip advisories
  assessed as not reachable and recorded.

**Hardened**

- **Engine stdout is byte-bounded before it is parsed.** ACP, Claude, Codex
  and Pi frames are capped at 32 MiB; an oversized or never-ending frame
  fails only that turn with `frame_too_large`, is never truncated and
  parsed, and nothing after it can settle the turn as a success.
- **Claude never replays a turn after its prompt was written.** A relaunch
  happens only when the prompt write was refused and no output was seen; a
  written or in-flight prompt fails visibly. Tool use, tool results and
  reasoning now count as output.
- **Stop means the child is gone.** ACP and Pi confirm the child's close
  before a thread's folder, computer or browser lease is released; an
  unconfirmed stop keeps the run "stopping" with its leases held and a
  visible notice, so a same-folder replacement stays refused while the
  stopped engine is alive.
- **Existing engine configs are never rewritten blind.** A Qwen Code,
  OpenCode or Antigravity config that cannot be parsed (including valid JSONC
  the CLIs accept) is refused with repair guidance before any write; the
  file keeps its bytes and the turn fails before the CLI spawns.
- **VM / VPS held-control fails closed.** A timeout, non-2xx answer or
  malformed body from the control endpoint means "unknown", not "free", and
  the MCP bridge refuses tool calls with reconnect guidance.
- **Every privileged desktop IPC is bound to the owned main frame.** Secret
  issuance, screen capture, credentials, companion, updater, CUA, Android,
  speech, recorder, permissions and native actions refuse any other window,
  subframe or navigated-away origin before a listener runs; the main window
  cannot leave its renderer origin, and credential-free web links open in
  the default browser. The preload exposes the bridge only on the origin
  main passed at launch.
- **Main-app permission allowlist.** Notifications, clipboard, fullscreen
  and audio media are allowed for the owned main window's top frame; camera,
  devices, mixed media and foreign origins are denied; display capture stays
  intent-bound and one-shot. A disposable-profile smoke proves it on macOS in
  CI.
- **Recordings and saves land in the installation you are running.** Skill
  recordings and Save go to the active owned root (never `~/.murage` by
  fallback), are sender-authorized, and are refused during recovery, while
  closing or without ownership.
- **Speech and recorder helpers stay owned until they exit.** A failed
  stop-marker write keeps ownership and is retried on the next Stop, Start
  or Quit; Quit waits for the helpers (10 s deadline) and reports an
  incomplete stop instead of claiming clean cleanup. Nothing is killed by
  process name.
- **Provider credentials fence on an uncertain write.** A provider-bank
  replace whose acknowledgement is lost fences provider writes and new
  dispatch until a revision readback confirms the state; an unknown
  successor revision is never overwritten.
- **Bare xAI, Groq and Hugging Face keys are masked** in stored bot text,
  native logs and canonical events.
- **Companion streams end with their session.** A browser's event stream is
  bound to its session identity and closes on sign-out, eviction by a newer
  sign-in, or expiry, not only on device revoke. The SSE scrub fails closed:
  a payload that parses but cannot be scrubbed ends the stream rather than
  being forwarded raw. An explicit tailnet bind requires Tailscale's own
  confirmation of the address; a carrier-NAT or VPN address in the same
  range no longer satisfies it.
- **Installer runs the service as a named non-root account.** The systemd
  unit always carries User=, Group=, HOME and UMask=0077; setup as root
  requires `--service-user` and does that account's file work as that
  account, never as root by path (a planted symlink can no longer redirect a
  root write). The unit is staged privately with a digest-checked install
  command, and unit fields are escaped the way systemd parses them. Every
  `murage start` writes a fresh door-identity nonce; `setup` and `status`
  front a listener only after it proves that identity and version.
- **Composio broker (source only, not deployed).** Registration throttling
  keys on the edge source address (IPv6 by /64) instead of a
  client-controlled User-Agent; request bodies are streamed and cancelled at
  their caps before any charge; a failed account inventory refuses new links
  with 503 instead of linking blind; the call ceiling counts tool executions
  only. Control-plane connector-token issuance is fenced by the exact
  authorizing credential so a revocation or rotation in flight withholds the
  token.
- **Files discovery never lists Murage's own data folder** and re-checks the
  folder chain after describing each page, failing with `root-changed` if a
  folder was swapped for a link in the window.
- **Release publication holds until every asset digest is proven.** A
  missing GitHub digest after the bounded wait fails the proof step with a
  HOLD; the draft is left untouched and a rerun reuses the build artifacts
  without re-uploading.

**Quality**

- **All seven language packs complete.** German, Spanish, French, Hindi,
  Japanese, Brazilian Portuguese and Chinese carry all 525 English strings,
  drafted with the repository's Claude-CLI flow, reviewed, and recorded
  against the exact English source each translates, so `pnpm i18n:check` is
  green and a future English change flags the stale translation.
- **Baseline red suites repaired, not skipped.** `server/index.test.ts`
  (17 failures at the 0.1.51 baseline) is 237/237: four thread-era
  behaviours tightened so the suite's expectations hold (delete-guard
  order, read-state body validation, explicit channel-thread interrupt,
  package import rewriting persisted bots) and the rest re-aligned to
  recorded decisions. The Electron data-owner and
  memory-profile fixtures evaluate the real `main.mjs` slices again. A new
  `main-module-load` test proves the Electron main module still loads with
  every handler registered exactly once.
- **Concurrency proof runs the real scenario on every platform** (macOS host
  control, Linux supervised driver, Windows refusal before the engine starts).
- **Joined proofs.** Real-harness Playwright specs for the workspace editor
  (shell-written report → card → Open here → edit/save → competing bot write
  → restart), media publication (one generation, one asset, one saved
  result, recovery with zero provider calls), media players, the question
  card against the real Claude CLI, the responsive header, local models in
  the real renderer, sidebar hit areas, connected-apps alias, and code-block
  Save.
- **NOTICE lists every adapted upstream change** (#987, #986, #1023, #762,
  #767, #758, #979 adapted; #988 and #920 behaviour taken, written
  independently) with the exact upstream commits, per Apache-2.0 section 4.

**Still open in this release**

- The customer engine incidents (`-32603` and exit `1073807364`) are not
  closed by anything in this candidate. The lifecycle diagnostics above are
  the evidence path; a matching trace is still required to call them
  resolved.
- The `MEMORY_CONTEXT_REVOKED` harness incident (a turn cancelled before any
  engine starts when memory data is written between bundle build and
  dispatch, about one run in four on the shared build machine) is recorded
  in `docs/plans/0152-CONTRACTS.md` for the memory owner, not fixed.
- Not covered by the close-confirmed stop contract: Antigravity and
  BoxAgent (documented in `server/contracts.ts`).
- The five Linux-proof installer commits on `lane/0152-LINUXFIX` are not in
  this candidate (section 3).
- Native gates still open: real macOS helper exit and released mic/event
  tap (R2-T4), Finder open/reveal (F4-T5), a real CGNAT host with no
  Tailscale CLI (S1-T7), real systemd/Tailscale on Linux (F2), one live
  image edit per provider (F1-T5), packaged inference smoke (Q1-T3), signing
  and publication (Q1-T6).

---

## 2. Announcement voice sketch (for the update post, once frozen)

Not final copy. It exists so the post is written from the same ledger as the
draft body. Rewrite from the merged list at freeze time.

> 0.1.52 is the one where your bots stop working in the dark.
>
> Every bot now has a workspace you can open beside the chat. A report it
> writes shows up as a card the moment the turn ends, with no "please
> register this file" ceremony. Click Open here and you're reading it in a
> pane next to the conversation. Click Edit and you're in a Markdown editor
> that only writes when you press Save, tells you when the bot changed the
> file underneath you, and keeps the version you replaced.
>
> Bots can ask you questions now. Not "the user did not answer" while you
> were never asked. A real card, keyboard-driven, and the same card on
> Telegram with buttons. Skip it and the engine hears that immediately.
>
> Local models are a setting, not a treasure hunt. Settings → Models shows
> what it looked for, lets you add your own llama.cpp, Ollama, LM Studio,
> vLLM or SGLang server, and runs a seven-check tool test before any bot is
> allowed to pick the model. We ran four engines against a Qwen 27B on a
> home GPU box and every one of them completed a real tool-using turn.
>
> Images open in a proper lightbox. Audio and video play inline, from your
> own workspace, through a ten-minute capability that dies with the app.
> "Use as reference" drops any image into your next message so the bot can
> edit it, on OpenAI, xAI or OpenRouter, with each key going only to its own
> provider.
>
> Under the hood: engine output is byte-bounded before it's parsed, Claude
> never replays a turn you already saw output from, Stop waits for the
> child to actually die, and every privileged desktop call is bound to the
> app's own window. Seven languages, all 525 strings.
>
> It auto-updates. Open it and it's already there.

---

## 3. Merge ledger (drives sections 1 and 2)

Merged into `release/v0.1.52` at `37c2822d`. Every row is a non-merge commit
returned by `git log --no-merges --format='%h %s' acaee1db..release/v0.1.52`
(120 commits at `37c2822d`) plus this lane's own; nothing older than the `acaee1db`
baseline belongs here. Lane labels are the task ids in the commit subjects.

| Lane / task | Commit(s) | Kind | Draft entry |
|---|---|---|---|
| K0 contracts (U-02, U-03, U-04, A2, B6) | `4f7e28c2` | foundation | shared contracts, schema, trust helper, per-route authority |
| F4-T0 Tiptap pins (U-05) | `58750971` | dependency | editor dependencies pinned |
| Q1-T1 (D5) | `228d22c7` | test | concurrency proof per platform |
| F5-T1 (M1, U-03, U-04, U-28) + fix round | `24824218`, `a87969b2` | service | media resolver and capability byte route; stream slots, ranges |
| Q1-T4 | `7f8d8f29`, `0359d529`, `0341e7d8`, `120f0e24`, `809047f5` + this round | version, i18n, docs | 0.1.52; packs accepted, then drafted to 525/525; this draft |
| S1-T1 (#987) | `e0332d62` | hardened | bare xAI/Groq/HF keys masked |
| S1-T8 (A5, U-11) | `a388260e` | hardened | VM/VPS held control fails closed |
| S1-T2 (#986, B6) | `42358cc4` | hardened | main-app permission allowlist, credential-free external links, CI smoke |
| R1-T5 (A6) | `e7a25254` | enhanced | Pi fails before prompt on set_model / handshake failure |
| R0-T3 (#920) | `4b350ff3` | enhanced | `server__tool` spellings settle screen frames |
| R0-T2 (#988) | `692c0c99` | enhanced | routine metadata edit keeps a due run |
| R2-T2 (B2, B3) | `d6824d20` | hardened | Save never truncates its source; bound to owned root |
| S2-T1 (C1, U-16) | `db95dc66` | enhanced | correction-aware memory approval with pin choice |
| R2-T1 (B1) + fix | `28d2224b`, `d11d9b71` | hardened | recordings to the active owned root; main-module-load test |
| R1-T1 (A1, U-17) | `f645e5d9` | hardened | Claude never replays after prompt written |
| R2-T3 (B4, U-14) | `ef5f1d46` | hardened | provider-bank fence until revision readback |
| R1-T3 (A3) | `7da9e612` | enhanced | terminal SSE contract; partial output kept |
| R1-T6 (A7) | `29ed45a4` | enhanced | Pi host-control asks carry local-computer scope |
| R1-T7 (A8) | `e451f55e` | hardened | unparseable Qwen/OpenCode/agy configs refused, not rewritten |
| R2-T5 | `367dd014` | internal | skip unchanged optional Composio credential writes |
| R1-T2 (A2, U-18) | `ab670132` | hardened | leases held until ACP/Pi child close confirmed |
| F2-T5 (D2, U-22) | `876a4dc6` | hardened | control-plane token issuance fenced by credential |
| S1-T4 (CP1) | `c5bf1f5e` | hardened | browser SSE streams end with their session |
| R2-T4 (B5, U-15) | `defb45ad` | hardened | speech/recorder ownership until acknowledged exit |
| F3-T1 (D1, U-23) | `0bcb5973` | hardened (source only) | broker registration throttle on edge address |
| R1-T8 | `e1b68427` | added | engine lifecycle diagnostics schema v1 |
| S1-T5 (CP2, CP3, U-13) | `1f307876` | hardened | unreadable registry unavailable; revoke failures contained |
| F3-T2 (D3) | `4cb4b6d2` | hardened (source only) | broker bodies streamed at their caps |
| F2-T1 (I1, I4, I5, U-19) + fixes | `2fe86461`, `7b53fa45`, `450716df` | hardened | named non-root service account, private staging, unit escaping, sudo for root staging |
| S1-T6 (CP4) | `a2aa1406` | hardened | SSE scrub fails closed |
| S1-T7 (CP5, U-12) | `6b3bdac6` | hardened | explicit tailnet needs Tailscale confirmation |
| F3-T3 (D4) | `be62ca0c` | hardened (source only) | broker refuses links on unknown inventory |
| R0-T1 | `8560f938` | enhanced | wait/retry card for local contention |
| Q1-T2 (D6) | `bf592a25` | hardened | publication held until every digest proven |
| F1-T1, F1-T2, F1-T3 (U-08, U-09) + test | `458e67ae`, `9606a3b7` | added | per-provider edit routing, xAI edits, OpenRouter references |
| F2-T3 (I3) + fix | `1457acc8`, `f0676d66` | enhanced / hardened | rerun merges env file atomically; account's work as the account |
| U0-T2 (#762, #767) | `f2878c5f` | enhanced | sidebar hit areas |
| U0-T3 (#1023) | `1f708d31` | enhanced | inline code / link labels contained |
| R3-T1 + fixes | `473d6bc6`, `a6e81afa`, `959b118a` | added / hardened | lazy workspace listing/search; chain re-check; data folder never listed |
| R3-T3, R3-T4 (C2, U-02) | `bf64fa62` | added | managed `outputs/` published automatically; resumable image publication |
| Q1-T3 (U-24) | `401c159c` | enhanced | docs next 16.3.3, control-plane vitest 4.1.11 |
| F3-T4 (#758) | `a73d3346` | enhanced | first Composio account labelled |
| F2-T4 (I6, I7, U-20) | `218092f3` | hardened | node floor preflight; door identity proof |
| LFU Fuigo bump | `1370d9e3`, `51b66e12` | enhanced | Fuigo 1.0.11 verified pin; README proposal |
| LFU2 Fuigo bump | lane/0152-LFU2 | enhanced | Fuigo 1.0.12 verified pin from CI run 34588671916 (npm-only publish, no GitHub release) |
| FUIGO13 Fuigo bump | lane/0152-FUIGO13 | enhanced | Fuigo 1.0.13 verified pin from CI run 34623419288 (npm-only publish, no GitHub release); first release-stamped build, folder trust live |
| F2-T2 (I2, U-21) | `7b02e179` | hardened | secrets read with no echo, no history |
| F4-T2 (U-06) + fixes | `52a07f44`, `5b4e08dd`, `be79a7f7` | added | DocumentSession, fidelity gate, corpus; superseded reads; deferred reads |
| F4-T4 (U-07) + fixes | `12ae89fe`, `1ebd4159`, `5814aa9e`, `9171c623` | added | Tiptap editor, Source fallback, bounded drafts; conflict read failures; held crash drafts |
| ASK1 | `154a7dd9` | hardened | question tools never auto-approved, remembered or auto-reviewed |
| R1-T4 (A4) + fixture | `f0322b96`, `e160fe0b` | hardened | byte-bound engine stdout framing |
| F5-T2 (M2) + fix | `e0d538cb`, `415958d1` | added | image lightbox for every surface; StrictMode |
| F4-T1 | `bf04dcaa` | added | bounded read, revision-conditioned save, bot-active hold, save-version |
| merge repair | `0d981319` | internal | duplicate main-trust import after L05 merge |
| LOCAL-MODELS A, T, E1-E5, V1-V5 + fixes + proof | `889a29b9`, `9aef8e1d`, `0578bcbb`, `5aadc484`, `d117aa29`, `40bd4475`, `106d46b9`, `a3517de9` | added | user servers, tool test, engine wiring, Local models section, Local rail, llama.cpp id; Qwen auth type; renderer proof and fixes; K rule; picker empty row; live proof doc |
| S1-T3 (B6) | `d821ed06` | hardened | every privileged IPC bound to owned main frame |
| F4-T6 (#979) + test | `b3c87e68`, `e4ea7093` | added | Save a code block |
| ASK2 (ASK-USER step 2) + tests | `69d83539`, `64fba16f`, `49ea7766`, `502755f7` | added | question card for Claude end to end; dismiss and expiry; browser + live CLI proof |
| R3-T2 (F1) + fix | `f67fcb94`, `519ec402` | added | Files workspace view beside saved versions; fixture asks the server for the workspace |
| LFLAGS | `9ef277a9` | added | unattended `murage` |
| U1-T1 | `4ed15524` | docs | NOTICE attribution |
| F5-T4 (M4, IMG-SEED) + test | `21d32ec6`, `9b7ad593`, `be7882f5` | added | resolve_image_reference; "Use as reference"; seam expectation |
| F4-T5 + wiring | `fb56634e`, `cab06f8b` | added | owner-bound native open/reveal; Workspace view buttons |
| F5-T3 (M3) + fix + docs | `32d456e3`, `86da9337`, `0e6c1676`, `bb17e89c` | added | audio/video player cards; proofs; artifactScopes mirror; Save a copy renew |
| F1-T4 | `5ccfcfcc` | added | truthful per-model edit capability in settings |
| FLUXCOMPOSIO + fix | `31e98d45`, `e3868d32`, `e638cf48` | added | connected apps on FluxRouter with claim migration; verifier gaps; fixture stubs |
| U0-T1 | `af4a48d8` | enhanced | responsive chat header |
| ASK3 + docs | `28398199`, `21fa9cb0`, `9b6b4cf8`, `c3a47648`, `05c76009`, `eac9c390`, `9e5bdbf3` | added | Codex, Fuigo, ACP elicitation and Pi questions; Telegram questions; Fuigo MCP elicit bridge |
| RED1 (Q1) | `9ea574d6`, `944138c3`, `2965d1a2` | quality | four thread-era behaviours tightened; index.test.ts 237/237; Electron fixtures evaluate real main.mjs |
| F5-T5 (M5) | `6290cdb6` | quality | joined media publication proof |
| F4-T3 | `504e2095` | added | workspace pane with preview tabs and editing |
| F4-T7 + fixes | `a3edecf4`, `02abb31f`, `054c7073` | quality / enhanced | joined workspace-editor proof; lease marked dispatched only before sendTurn; conflict clears stale refusal |

Not merged when this draft was written (report their absence; do not describe
their scope as shipped): **`lane/0152-LINUXFIX`** — five installer commits
from the Linux proof (`4a1fb1d1` `tailscale up --reset` for rerun repair,
`ea140175` unit grants the data dir's parent, `62856577` `status
--service-user`, `0f947dc5` `start` waits for tailscaled after a boot,
`ab35e217` refused unattended run creates no data directory). When it merges,
add one "Installer, proven on Linux" entry under Enhanced from those commit
bodies and a row above.

---

## 4. Proposed README changes (do not apply in this lane)

`docs/releasing.md` requires a README review in both `FerroxLabs/murage` and
`FerroxLabs/murage-releases` before publication, with "Latest release" linked
to `/releases/latest` instead of a hardcoded version in the download heading.
The repository README (`README.md`) is still written against 0.1.47; 0.1.50
and 0.1.51 did not update it. Line numbers are from `README.md` at
`37c2822d`.

### 4a. `README.md` in `FerroxLabs/murage`

Version and pin rows:

| Line | Current | Proposed |
|---|---|---|
| 23 | `**[Murage 0.1.47 — stable release](.../releases/tag/v0.1.47)** · [Release notes](.../releases/latest)` | `**[Latest release](https://github.com/FerroxLabs/murage-releases/releases/latest)** · [Release notes](https://github.com/FerroxLabs/murage-releases/releases/latest)` (per `docs/releasing.md`; no version in the heading) |
| 34 | `**Fuigo 1.0.7 is bundled. ...` | `**Fuigo 1.0.13 is bundled. ...` (`scripts/prepare-fuigo.mjs` pins `FUIGO_VERSION = "1.0.13"` once FUIGO13 merges, and FUIGO13 applies this README edit itself — re-read the pin at freeze) |
| 144 | `**Fuigo 1.0.7 is Murage’s bundled agent harness**, ...` | `**Fuigo 1.0.13 is Murage’s bundled agent harness**, ...` (same pin check as line 34) |
| 107 | `**In 0.1.47, managed memory starts off.**` | `**Managed memory starts off.**` (still true; drop the version so the sentence does not age) |
| 170 | `Keyword retrieval and owner controls; no local semantic runtime in 0.1.47.` | `Keyword retrieval and owner controls; no local semantic runtime in this release.` |
| 17, 62 | `2,237 skills` | Already matches: `find skills-library -name SKILL.md \| wc -l` = 2237 at `37c2822d`. Keep. |
| 3, 40, 50, 66, 103, 120 | `*-0.1.47.png` screenshot and hero assets | The header (U0-T1), the workspace pane (F4-T3), Files (R3-T2), the lightbox (F5-T2) and Settings → Models (LOCAL-MODELS) all changed pictured surfaces. Capture new screenshots on the frozen candidate and rename with `0.1.52`; do not rename assets without new captures. |
| 168 | `Windows browser: The embedded browser is disabled because of an upstream Electron sandbox issue.` | Re-verify against the 0.1.52 Windows package before publication; no merged commit changes it. |

New content rows (each backed by a merged commit; keep the README's register
of "what you can do today" and do not promise gates that are still open):

| Where | Proposed |
|---|---|
| "Give your agents somewhere to work" (line 68), after the environments table | New paragraph: "Every bot has a **workspace** you can open beside the chat. Files a bot writes into its task's `outputs/` folder are saved to Files automatically and appear as a card in the conversation; open them in a pane next to the chat, edit Markdown with a save that respects the version you opened, and hand a file to your OS with Open in app or Show in folder." (`bf64fa62`, `504e2095`, `f67fcb94`, `fb56634e`/`cab06f8b`) |
| "Fuigo built in. Multi-vendor by design." (line 142), new paragraph after the multi-vendor paragraph | "**Local models are a setting.** Settings → Models shows the local servers Murage looked for, lets you add your own llama.cpp, Ollama, LM Studio, vLLM or SGLang server, and tests whether a model can call tools before any bot can pick it. Fuigo, Pi, OpenCode, Qwen Code, Hermes, Droid and Kimi use a tested model directly; compatible chat-only endpoints stay chat-only. [Local models](docs/custom-engines.md)." (`889a29b9`, `0578bcbb`, `9aef8e1d`) |
| "Stay in the conversation from Telegram" (line 126), Telegram table row | Extend: "Continue the Chief’s conversation, answer supported one-time approval requests, and **answer a bot's questions with buttons** from a paired private chat." (`05c76009`) |
| "Start with one useful task" (line 156), step 4 | Append one sentence: "When a bot needs a decision from you, it asks with a question card you can answer from the keyboard or from Telegram." (`69d83539`, `28398199`) |
| "Connect the tools your team uses" (line 148) | Add: "Connected apps can run through your FluxRouter account." FluxRouter claims are turned on for this release: the live Worker runs `CLAIM_MODE` open (rollout step 5) and FluxRouter claims are on (step 6, 2026-09-11), and the committed `cloudflare/composio-broker/wrangler.jsonc` now ships `CLAIM_MODE` open and `REGISTRATION_MODE` closed (`c6526839`, merged in `6d81d3d3`; the code is `31e98d45`). |
| "Before you choose a setup" table (line 164) | Add rows: **Markdown editor** — "Rich editing opens only for files the bundled parser reproduces byte for byte; other files open in Source mode. Files up to 2 MiB." (`52a07f44`, `bf04dcaa`) · **Media playback** — "Audio and video play from a conversation's own workspace files (WAV, MP3, Ogg, M4A, MP4, WebM by container; codec support follows the platform). No transcoding, no autoplay." (`32d456e3`, U-28) · **Image editing** — "OpenAI, xAI (`grok-imagine-image-2.0`) and OpenRouter (`openai/gpt-image-2`, pinned endpoint) accept reference images; Flux generates only. Live edit checks per provider remain a release gate." (`458e67ae`, F1-T5 open) · **Local models** — "Tool calling depends on the server and model; Murage's test says which engines a model is usable with." (`889a29b9`) |
| "Background work" row (line 171) | Keep "not an always-on hosted service" until the Linux installer proof (`lane/0152-LINUXFIX`) merges and the F2 gates close; the unattended installer (`9ef277a9`) does not change the boundary for desktop users. |

### 4b. README in `FerroxLabs/murage-releases` (separate repository, not in this tree)

- Download heading: "Latest release" linked to `/releases/latest`; no
  version number in the heading.
- Installer table identical to 4a (Apple Silicon DMG, Intel DMG, Windows
  setup, Ubuntu .deb and AppImage) with the stable download names the
  Release workflow asserts.
- Bundled engine line: Fuigo 1.0.13 (the pin FUIGO13 sets; re-read
  `FUIGO_VERSION` at freeze); no Node.js, npm, pnpm or separate Fuigo
  install required for desktop installers.
- Known platform limits copied verbatim from the 4a table after the 0.1.52
  re-verification, including the four new rows.
- Never describe the 0.1.52 draft as the latest public release until it is
  published (Q1-T6).

---

## 5. How to refresh this draft after further merges

1. `git log --no-merges --format='%h %s' acaee1db..release/v0.1.52` (use
   `rtk proxy git` if the wrapper truncates; the count at `37c2822d` is 120,
   at `cae69216` 134)
   and read each new commit body; add one entry per user-visible change to
   section 1 and one row to the section 3 table.
2. If a merged lane added English strings to `src/locales/en.json`, draft the
   seven packs with the documented flow (one call per locale; uses the local
   authenticated Claude CLI; about 2.5 minutes per locale for 380 strings):
   `node scripts/generate-locale.mjs de German`, and likewise `es Spanish`,
   `fr French`, `hi Hindi`, `ja Japanese`, `pt-br "Brazilian Portuguese"`,
   `zh "Simplified Chinese"`; then review every changed string and run
   `pnpm i18n:check`. The script refuses missing keys, invented keys, changed
   placeholders and prose, and refreshes only missing or stale keys. Use
   `--accept` only for a pack whose translations were already reviewed and
   committed without source hashes; it records hashes and translates
   nothing.
3. Re-run `node scripts/release-guard.mjs version` (must print `0.1.52`) and
   `pnpm exec vitest run scripts/release-guard.test.mjs scripts/release-workflows.test.mjs`.
4. Move `lane/0152-LINUXFIX` from "not merged" to the table when it lands;
   do not describe scope from the plan as shipped.
