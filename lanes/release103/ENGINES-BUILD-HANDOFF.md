# Cloud engines build handoff (design r9), 2026-10-16

Worktree `/Volumes/Fixture/workspace/cloud-engines`, branch `fix/cloud-engines-five`, base `a55ff1940`. Design:
`0161/lanes/release103/CLOUD-ENGINES-DESIGN.md` (r9 at the top is the builder's contract; precedence r9 > r8 > ... > r5;
the "r9 build record" under the r9 table lists what the build settled that the design left open).

## State of the build

Every r5 to r9 item is built, with its fixtures. The two interrupted WIP commits are gone: the first was reworded into
a logical commit, the second and the credentials sub-builder's uncommitted tree were reviewed and recommitted as the
logical commits at the top of the branch. The sub-builder branches (`-state`, `-adm`, `-mask`, `-cred`) are merged.

| Piece | Status |
|---|---|
| Server: bot-state client, release before delete, tombstone guard, bot on every spawn site (turns, review, proposal, text helper, PIP text-only, browser checker), Codex billing from bot-state-query, Claude renewal flag | done |
| Launcher: admission and fd handoff (collision-free remap, locked re-admission, roots fence, retention), release, bot-state-query; an in-scope payload without an admission record refuses | done |
| Launcher: immutable placeholders (r5 R5.1), MASK_NAMES union | done |
| Launcher: versioned sign-in stores (R2 + H2 ancestors), Claude C (setup-token, root-parent TokenFilter capture), Codex C (rendered read-only auth.json), OpenCode mode-dependent OPENCODE_AUTH_CONTENT, B per-bot logins, logouts and key enrollments as publishes, Codex account claim kept on refresh, cleanup of every store | done |
| Desktop: relay carries bot, provider and the key (first socket message); Cloud home page picks the bot (`cloud-home:list-bots`, id and name only), offers OpenCode and API-key sign-ins; the engine card shows the renewal line | done |
| Gate on Hetzner: both typechecks, `server/cloud-home`, `server/drivers`, `server/store.test.ts`, the touched `src` and `electron` tests | green except 9 tests that fail identically at `a55ff1940` (app-health x6, boot-egress, copy.test, mining-event-path) |

## Open items (need a real home or Sean)

1. Real-home gates are written but not run: `deploy/cloud-home/qualify/negative-tests.sh` (root; ext4 immutability,
   systemd descriptor passage) and `engine-start-check.py` (Claude token checks need `MURAGE_CHECK_CLAUDE_TOKEN_FILE`
   from a test account; Codex key checks run offline). Run both on a real home before sign-off.
2. Astra build review of this branch against r9.
