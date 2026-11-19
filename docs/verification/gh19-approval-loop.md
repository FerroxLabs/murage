# GH-19 delegated approval loop

Source: [issue 19 and its replies](https://github.com/FerroxLabs/murage/issues/19).
The reporter ran the Chief of Staff's daily briefing, which delegated to Macro.
After `acp mcp gate ... missing=agents`, Macro repeatedly displayed the command
approval, including after several Allow clicks, without apparent progress.
Starting a new Chief task the next day reached Macro's same conversation and
repeated the symptom. The expected alternative to successful execution is a
clear failure instead of another identical card.

The report does **not** include the command text or native request identifiers.
It cannot establish whether those requests were replays or distinct operations.
The fixture pins the answered-request replay mechanism; reporter confirmation
is still needed to identify the historical engine behavior. The GH-20B ledger
entry's `needs info` is not evidence that any 1.0.19 branch fixes this issue.

## Named gate

`server/gh19-delegated-approval-loop.test.ts`:

> GH-19: Allow on a delegated Macro card never reopens an answered native request, including the next routine on the same thread

This launches an isolated real HTTP server, a fake Chief engine, and a fake ACP
Macro engine. It runs a real routine and the authenticated `delegate_bot` route,
reports every mount ready, and requests permission for the fixture
command `echo briefing && echo macro`. After the real approval endpoint delivers
Allow, the fake peer repeats the same native request without executing a command.
The test requires a visible terminal error, one answered card, no open replacement
card, and no poisoned conversation on the next routine run. It waits for runtime
events rather than assuming silence means success. All data belongs to the fixture.

On the 1.0.19 train a Murage-mounted ACP turn whose mount list reports a server
as failed ends before its prompt, so the reported `missing=agents` state cannot
open a card at all. A third delegation, to a Macro whose `agents` mount reports
an error, pins that: the turn ends visibly with the context-unavailable line and
no approval card. The replay runs therefore use ready mounts. Window frames carry
the card's public handle only, so the test answers by handle and reads each run's
outcome from the Macro frames in stream order.

`server/drivers/acp/hermes-tripwire-1019.test.ts` checks that an answered request
replayed after the Hermes hooks stopped being ready ends on the V-H2 hook check
(`hook-repair-failed`), with one card and exactly one native answer. The identity
checks run after the hook check, so a hook failure keeps its own stop reason.

`server/drivers/acp/approval-delivery-108.test.ts` additionally checks delivered
Allow and Deny replay, a replay under a new RPC id but the same ACP tool-call id,
in-flight duplicates under both the same and a new RPC id, changed arguments, and fresh operations that still need
their own approval. A new tool call may reuse a completed JSON-RPC id; it gets a
new card, never the old grant. A replay is the same ask: the same tool-call id
and the same request params. A different ask inside one tool call (OpenCode asks
`external_directory`, then `bash` or `edit`, under one tool-call id) opens its own
card, whether the first card is answered or still open, and the turn continues
after its Allow. Tool-call identity follows the
[ACP tool-call contract](https://agentclientprotocol.com/protocol/v1/tool-calls).

## RED evidence and branch attribution

The named gate fails on `c12aaad9341e8f87126a193f35b5c2768f0aa66f`:
after Allow, expected `turn.completed`, received `request.opened`.
The same test also fails on the combined candidate below, at the same assertion:

| Branch | Tested tip |
| --- | --- |
| `dev/1019-nolim-b6-s1` | `e9b08b3266c1e89b7bf8281f906b49ac47e288b2` |
| `dev/1019-nolim-b6-s2` | `f5021f1692bd2bc476d0c26cc0d0564f1a99cbbb` |
| `dev/1019-nolim-b6-s3` | `1e7640db9493a9300e6348d46579678373ef473d` |
| `dev/1019-deleg-l5b6a` | `f095a331657cf251ff1a2c08184c0b417030619f` |
| `dev/1019-deleg-l5b6c` | `b4c515a8a94c54c17bda24208b75fbde37479892` |
| `dev/1019-deleg-d80dev` | `88a949d820b8604ee3f5e22c550b332066c62e70` |

The disposable candidate was assembled with `git merge-tree`; only additive
`ci/gate-tests.txt` conflicts needed union resolution. Candidate tree:
`0ea4b4c11a23c62d42a5cac00a1b8d78afa65d94`; candidate plus regression commit:
`8bd9df9a8`. These branches do not fix the demonstrated replay loop.

The fix retains answered request identities for the active turn. Replaying an
answered ask ends that turn with an error instead of opening another card
or resending an Allow. Pending transport failures remain retryable under the
existing delivery rules. Stop, uncertainty, one-time scope and new-operation
approval guards remain in force. The next turn starts with fresh request state.

Run the gate and its neighbors through the job's container wrapper. Evidence is
recorded in the continuation lanes' `DONE.md` files outside the checkout. The
paired comparison covers ACP driver tests and permission-path callers against
base `0fc91ffa6c`; full-suite validation remains unchecked. This change does not
restore a missing MCP capability or grant standing approval to repeated commands.
