# Agent questions

A bot's "ask the owner" — Claude Code's `AskUserQuestion`, the muragebox
`ask_user` tool — becomes one question card in chat. A question is never
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
```

The card in a real browser (keyboard, both skins, phone width, screenshots):

```sh
pnpm exec playwright test -c src/e2e/question-card.config.ts
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
