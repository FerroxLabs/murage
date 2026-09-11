# 0.1.52 — Local models: live proof (lane LM2)

Spec: `.planning/0152-LOCAL-MODELS-SPEC.md` (sections V and Verification).
Acceptance bar (Sean): tool calling through the engines that already run tools,
against a real local server, with no custom tool loop in Murage — and screens a
first-time reviewer can follow without an explanation.

Evidence root (this Mac):
`/private/tmp/claude-501/-Volumes-Mando-WaylandBots/eb650c4a-1052-4528-b303-0f1e70bd2a23/scratchpad/evidence-LM2/`
— every path below is relative to it.

## 1. The server

SeanBeast (Windows, PowerShell over ssh), one background ssh session that both
ran the server and forwarded local port **9451** to its 127.0.0.1:8080:

```
llama-server.exe -m D:\Qwen\models\Qwen3.8-27B-UD-Q4_K_M.gguf -ngl 999 -fa on --jinja
  -c 65536 -b 1024 -ub 1024 --cache-type-k q8_0 --cache-type-v q8_0
  --reasoning-effort low --parallel 1 --no-mmap --host 127.0.0.1 --port 8080
```

- `llama-server.log` — the server's own log (`n_ctx_slot = 65536`, `model
  loaded`, `listening on http://127.0.0.1:8080`, then every slot's timings).
  The `--no-mmap is deprecated` warning and the `unused tensor` warnings are
  noise, as the lane notes said.
- `remote-llama-pid.txt` — the remote PID recorded at start: **10764**.
- `local-tunnel-pid.txt` — the local ssh PID: **76385**.

The server names the model it loaded by the path it was given, so
`GET /v1/models` on this machine reports the id
`D:\Qwen\models\Qwen3.8-27B-UD-Q4_K_M.gguf`. That id cannot be a `host::model`
picker id (the grammar refuses backslashes and colons), which is why, before
this lane, a running llama.cpp on Windows appeared with no models at all.
`llamaCppModelId` (`shared/local-models.ts`) now recovers the file's own name
(`Qwen3.8-27B-UD-Q4_K_M`); a single-model llama-server ignores the request's
`model` field, so the recovered name addresses the same model (router mode,
where that field selects, is left exactly as reported).

## 2. Isolated fixture

`scratchpad/start-fixture.sh`: the lane worktree's `server/index.ts` on ports
**9448/9449** with `HOME`, `XDG_*`, `TMPDIR` and `MURAGE_DATA_DIR` all inside
`scratchpad/fixture-LM2/`, and a `PATH` that adds a scratch install of the pi
CLI. Never `~/.murage`, never Sean's app. Engines on this Mac at proof time:
fuigo 1.0.9, opencode 1.15.11, qwen (Qwen Code) 0.15.6, pi 0.85.1 (scratch
install under `scratchpad/pi-cli`).

## 3. Add the server, run Test

Through the same routes the Settings section calls (`scratchpad/lm2.mjs`):

- `01-add-server.json` — `POST /api/local-models/servers` with
  `http://127.0.0.1:9451`, name `seanbeast` → 201. Detected kind `llamacpp`,
  label **llama.cpp on seanbeast**, status `running`, one model
  `Qwen3.8-27B-UD-Q4_K_M`, `contextWindow: 65536` from `/props`, engines listed
  for it.
- `02-tool-test.json` — `POST …/test` → outcome **`tools-work`**, 7/7 checks
  pass (chat.auto, chat.required, chat.stream, chat.roundtrip, chat.manyTools
  at 7,780 prompt tokens, messages.toolUse, responses.functionCall), surfaces
  chat + responses + messages all true, 18.7 s. Engines after the test add
  `codex` and `claudeAgent` (their surfaces were proven).

The same two steps done in the real renderer against this fixture are
`live/live-section-seanbeast-{390,1440}-{light,dark}.png`: the card says
"llama.cpp on seanbeast · http://127.0.0.1:9451/v1 · Running · 1 model ·
checked just now · added by you", "64K context loaded", "Usable by Fuigo, pi,
OpenCode, Qwen, Hermes, Droid, Kimi, Grok, Codex, Claude", "Tools work — ready
for agents", one primary action "Use with a bot", and the seven checks behind
"What the test checked".

## 4. Pick the model, run a tool-using turn on each engine

Four bots, each with `modelSelection.model = srv_af6e1e13b0c1::Qwen3.8-27B-UD-Q4_K_M`
on its engine. `live/live-picker-fuigo-seanbeast-{390,1440}-{light,dark}.png`
is the Fuigo bot's real picker: search "seanbeast", one row
"Qwen3.8-27B-UD-Q4_K_M · llama.cpp on seanbeast / Tools work · 64K context",
selected; the bot's chip reads the same words.

Prompt 1 (all four): *"Create a file called lm2-proof.txt in your working
folder whose only contents are the word TULIP, then tell me the absolute path
you wrote."* Prompt 2 (Fuigo, pi, OpenCode, on the final code): *"Read
lm2-proof.txt … append a second line with the word ROSE … reply with the
file's final contents."*

| Engine | Turn 1 | Turn 2 | File on disk at the end |
|---|---|---|---|
| Fuigo (`fuigoAgent`) | `write` tool ok → `TULIP` written, path reported (`transcripts/03-turn-fuigo.json`) | `read_file`, `od -c` (approval asked, allowed), `search_replace` (approval asked, allowed), `read_file` (`transcripts/04-turn2-fuigo.json`) | `TULIP\nROSE\n` |
| pi (`piAgent`) | `write` + `bash` ok (`03-turn-pi.json`) | `write`, `bash` ×2 (`04-turn2-pi.json`) | `TULIP\nROSE\n` |
| OpenCode (`opencodeGo`) | `write` ok (`03-turn-opencode.json`) | `edit`, `read` (`04-turn2-opencode.json`) | `TULIP\nROSE` |
| Qwen Code (`qwenAgent`) | **first attempt failed** (see §5), fixed, then `edit` permission asked → allowed → tool item completed, path reported (`03-turn-qwen.json`) | — | `TULIP` |

`transcripts/<threadId>.ndjson` are the raw provider event streams for the
four threads (`request.opened`/`request.resolved`/`item.completed` for the
tool calls, `turn.completed ok:true`). The files themselves are under
`scratchpad/fixture-LM2/workspaces/<botId>/threads/<threadId>/lm2-proof.txt`.

Every turn above went to `http://127.0.0.1:9451/v1` — the llama-server log's
slot timings line up with each one (e.g. task 1771, 15,798 tokens, during the
Pi turn) — and no cloud provider was called: the fixture has no provider key.

## 5. What the proof found and what was changed

1. **Qwen Code refused a local turn** with *"Authentication required: Use
   Qwen Code CLI to authenticate first."* (ACP `session/new`, error -32000)
   although `~/.qwen/settings.json` had the modelProviders row Murage wrote.
   qwen 0.15.6's `ensureAuthenticated` needs a *selected* auth type
   (`argv.authType || settings.security.auth.selectedType || getAuthTypeFromEnv()`),
   and a fresh install has none; an install signed in with Qwen OAuth would
   have gone to the cloud under the local model's name. Fix (commit
   `fix(qwen): select the openai auth type for a local-model turn`): a local
   pick now spawns with `--auth-type openai` and `OPENAI_BASE_URL` /
   `OPENAI_API_KEY` / `OPENAI_MODEL` pointed at the local host, exactly as a
   Flux turn already does; the ACP core passes the picker id to `spawnArgs` as
   an optional `ctx.requestedModel` because `turn.model` is already the bare
   alias. The changed expectation in `server/drivers/acp/qwen.test.ts` is
   stated in the commit. Re-run live: the turn above.
2. **Windows llama-server listed no models** (§1) — fixed in the V1–V5 commit.
3. **Pi's first attempt was cancelled 3 ms after `session.started`** with the
   activity *"error: MEMORY_CONTEXT_REVOKED"* (`transcripts/91b35214-….ndjson`,
   turn `705a4876`, `turn.completed ok:true stopReason:cancelled`). That is
   the memory subsystem's own guard (`server/memory/eligibility.ts`,
   `bundle.ts`): the memory policy revision or deletion epoch moved between
   dispatch preparation and the adapter call, so the dispatch was cancelled
   cleanly rather than sent with stale memory. What moved it is not pinned
   here — the Fuigo bot's turn had settled six seconds earlier and the
   fixture's `memory_meta` ends at `policy_revision 5`, but no log ties the
   two. The re-send 27 s later ran normally. Not a local-models failure and
   **not changed by this lane**; recorded here so nobody reads it as one, and
   so whoever owns memory dispatch can decide whether a first turn on a fresh
   bot right after another bot settles deserves a retry inside the guard.

## 6. Renderer proof (repeatable without SeanBeast)

`src/e2e/local-models.human.spec.ts` (`local-models.config.ts`), 10 tests,
passed 5/5 consecutive runs (~20 s each):

```
MURAGE_E2E_OUTPUT=<dir> MURAGE_E2E_PORT=9448 MURAGE_E2E_UI_PORT=9450 \
MURAGE_E2E_DATA_DIR=/Volumes/Mando/WaylandBots/murage-0152-lanes/.e2e/LM2 \
node node_modules/@playwright/test/cli.js test -c src/e2e/local-models.config.ts
```

It runs a fake llama-server in the spec (two models: one whose tools work,
one that answers in prose) against a real isolated server, and walks, at 390
px and 1440 px, light and dark:

- **V1** empty state: "No model server is running on this computer. Looked
  for Ollama at 127.0.0.1:11434, LM Studio at 127.0.0.1:1234, llama.cpp at
  127.0.0.1:8080, vLLM at 127.0.0.1:8000, … — nothing answered." and **Add a
  server** (`screens/*/local-models-1-empty-*.png`).
- **A1, keyboard only**: Tab to "Add a server", Enter; the address field is
  focused, the plain-address rule is under it; type, Tab, name, Enter
  (`local-models-2-add-form-*.png`).
- **V2** card: name, address, Running, "Running · 2 models · checked just now
  · added by you", "64K context loaded", both models, "Test <model>" as the one
  action, chat engines offered before a test and Codex/Claude not
  (`local-models-3-detected-*.png`).
- **T1, keyboard only**: Tab to "Test qwen3.8-27b", Enter → "Tools work —
  ready for agents", "Use with a bot", "Usable by … Codex, Claude"; the prose
  model → "This model answers but can't use tools (it came back as text)",
  "Try another model"; the disclosure opened with Enter shows the seven
  checks (`local-models-4-tested-*.png`).
- **A3**: "Remove lm2-fake? The engine entries Murage wrote for it are removed
  too. Bots pointed at its models will need another model." then the empty
  state again (`local-models-5-remove-*.png`).
- **V3**: with no server, the Local rail has one row — "No local server
  detected — add one in Settings → Models" — and Enter on it lands on the
  section with "Add a server" focused (`picker-1-no-local-server-*.png`).
  With the server tested: "qwen3.8-27b · llama.cpp on lm2-fake / Tools work ·
  64K context" and "chatty-7b · llama.cpp on lm2-fake / ⚠ Tools test failed —
  chat only, not usable for agent work" (`picker-2-local-rail-*.png`); Enter
  picks it and the chip says the same words (`picker-3-picked-*.png`); with the
  server removed under it the chip says "qwen3.8-27b · local server
  unavailable" and the rail's row is back (`picker-4-server-removed-*.png`).
- **V4**: the Engines row carries "Works with local models — manage them
  under Models → Local models · Open Local models", and that link lands on
  the section with "Add a server" focused (`engines-local-line-1440-*.png`).
- **V5** is the first-run line in `EngineSetup.tsx` reaching the same section;
  it is covered by `src/components/LocalModelsSettings.test.ts`.

Each `*.viewport.png` beside a screenshot is the same moment at the real
window size.

What those screens showed, and what changed for them, is in the commit
`test(local-models): walk the section, the rail and the engines line in the
real renderer, and fix what it showed`: 64K vs 66K, the repeated server name,
cloud custom rows under "Local models", the raw `srv_…::` id on an orphaned
chip, "Usable by …" under a failed test, and the section footer.

## 7. Cleanup

- `05-remote-before-stop.txt` — on SeanBeast, PID 10764 is `llama-server`
  (started 1:27:38 PM), GPU 17,838 / 24,463 MiB.
- `06-remote-after-stop.txt` — `Stop-Process -Id 10764 -Force` after checking
  the name; no `llama-server` process left; GPU **0 / 24,463 MiB**.
- The ssh session was that server's parent and exited with it; nothing was
  left listening on 9451 (`lsof -nP -iTCP:9451 -sTCP:LISTEN` empty; PID 76385
  gone). The fixture server (PID 33878) was stopped by PID; 9448 is free.

## 8. Gates remaining

None for tool calling on llama.cpp. Not exercised here: the Ollama path on
SeanDesktop (spec: only if Sean starts it with `OLLAMA_CONTEXT_LENGTH=65536`),
and Hermes / Droid / Kimi / Grok / Codex / Claude local turns — their engine
wiring is unit-tested (LM1) but no live turn was run on them in this lane.
