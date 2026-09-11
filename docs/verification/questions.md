# Agent questions

A bot's "ask the owner" — Claude Code's `AskUserQuestion`, the muragebox
`ask_user` tool, Codex's `item/tool/requestUserInput` and MCP form
elicitations, Fuigo's `_fuigo/ask_user_question` and `_fuigo/mcp/elicit`, an
ACP agent's `elicitation/create` (form or URL), and a pi extension's
`select`/`input`/`editor` dialog — becomes one question card in chat. A question is never
auto-approved, never remembered as a grant, and never answered by the AI
reviewer: the whole point of asking is that a person decides.

## Sub-features

- One card per request, with a header chip, option descriptions, choose-one or
  choose-any, and free text ("Other").
- Answer, or skip explicitly. A skip is delivered at once, as an honest
  "no answer" — never a refusal and never a guess in the owner's name.
- A bounded engine wait (30 minutes by default). When it runs out the card
  becomes **Expired** and offers **Send as a message**, so a late answer still
  reaches the bot.
- Cards persist in `messages.db`. Interrupting a turn, or restarting Murage,
  expires an open question rather than dropping it.
- Each engine gets its own reply shape, built only from the owner's validated
  picks: Codex `{answers:{<id>:{answers:[…]}}}` (empty arrays when nobody
  answered), Fuigo `{outcome:"accepted", answers:{<question>:[labels]},
  annotations:{<question>:{notes}}}` or `{outcome:"cancelled"}`, ACP
  elicitation `{action:"accept", content}` typed per the schema / `decline`
  (skip) / `cancel` (timeout, turn end), pi `{value}` / `{cancelled:true}`.
  A URL elicitation is shown as a link; Murage never opens or fetches it.
- Over Telegram the paired owner gets the question with one button per
  option (multi-select toggles plus Submit, "Reply with text" for free text,
  Skip). The tap goes through the same validation as the desktop card. Secret
  questions stay in-app.

## User path

A bot asks mid-turn; the card appears in the conversation (1:1 or a room). Pick
with the mouse, or with the keyboard alone: `1`-`9` pick inside the focused
question, `Tab` moves on, `Enter` sends, `Esc` starts a skip.

## Driving it

Node suites, no network:

```sh
pnpm exec vitest run server/question-normalize.test.ts server/ask-user-question-api.test.ts \
  src/components/QuestionCard.test.ts --maxWorkers=2
pnpm exec vitest run server/drivers/claude.test.ts --maxWorkers=2 -t question
# the other engines, against their fake CLIs, and end to end through the server
pnpm exec vitest run server/drivers/codex.test.ts server/drivers/acp/acp.test.ts server/drivers/pi.test.ts --maxWorkers=2 -t ASK3
pnpm exec vitest run server/engine-questions-api.test.ts --maxWorkers=1
# Telegram buttons, text capture and the wiring into the real approvals expression
pnpm exec vitest run server/telegram-approvals.test.ts server/telegram-transport.test.ts \
  server/telegram-channel.test.ts server/telegram-permission-wiring.test.ts --maxWorkers=2
```

The card in a real browser (keyboard, both skins, phone width, screenshots):

```sh
MURAGE_E2E_DATA_DIR=<scratch dir outside the repo> pnpm exec playwright test -c src/e2e/question-card.config.ts
```

The live round trip against the installed `claude` binary — it calls
`AskUserQuestion` through Murage's own permission proxy and broker, and the
answer is delivered exactly as the card delivers it:

```sh
node scripts/verify-question-claude.ts
```

It passes only when the model is told
`Your questions have been answered: "…"="…"` with the label that was picked,
and then acts on it. Needs `claude` on `PATH` and the login that binary already
has; it starts no Murage server and never touches `~/.murage`.

The live round trip against the BUNDLED Fuigo engine, through the real
server (a paid model call through FluxRouter — the caller reads the key into
the environment; the script never reads a credential file and redacts the key
from everything it writes):

```sh
node scripts/prepare-fuigo.mjs --current
FLUX_API_KEY="$(cat /path/to/flux.key)" node scripts/verify-question-fuigo.mjs --allow-provider --output /tmp/fuigo-question-proof
```

It passes only when the pinned engine identifies as `FUIGO_VERSION`, a real
tool-using turn writes a canary file behind a permission card that the script
allows once (the wire must show the engine's `allow_once` option selected,
never its "allow all edits this session" row), the model's
`_fuigo/ask_user_question` becomes a question card, the answers go back as
`{outcome:"accepted", answers, annotations}`, and the model's final line
repeats the picks. `receipt.json`, the redacted `wire.ndjson` and the
transcript `messages.db` land in `--output`. Proven on Fuigo 1.0.12 (LFU2).

Live proof still open for ASK3: a real Telegram bot tapping the buttons and
replying with text. It is gated on Sean's resources; the fakes above pin the
exact wire shapes taken from the engines' own sources (openai/codex
`v2/item.rs`, Fuigo `ask_user_question/types.rs`, ACP `schema/v1/schema.json`,
pi `docs/rpc.md`).

## Gotchas

- An answer is conversation, not authorization: it is never written to
  `decisions.ndjson`. What is logged is that the card was **shown**
  (`card-shown`/`question`), and later `question-skipped` or
  `question-expired`.
- A secret question's answer is never written to the transcript or the log, and
  an expired secret question therefore offers no "Send as a message".
- `Your questions have been answered` in a transcript means labels only. If any
  answer was free text, Claude says `The user answered: …` instead — both mean
  the answers arrived. `The user did not answer the questions` means they did
  not.
- The engine's wait lives only in memory. Anything still open on disk after a
  restart is expired by the boot sweep; that is the honest outcome, not a bug.
