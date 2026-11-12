# Custom ACP models and thinking

Adapted from upstream 923be2380, 800d9b889 and 5198d26df.

Run the tests in an isolated no-network container:

```sh
pnpm exec vitest run server/drivers/acp/config-options.test.ts server/drivers/acp/session-model-controls.test.ts server/drivers/acp/custom-model-catalog.test.ts server/drivers/acp/custom-selection.test.ts
```

`custom-model-catalog.test.ts` starts its own generated fake CLI in a temporary
home. `custom-selection.test.ts` uses `server/testing/fake-custom-acp-models.ts`.
The two synthetic models advertise different native thinking values through
an option named `thinking` with category `thought_level`. Receipts must show
model and thinking setters before each prompt and independent choices on two
threads. These values do not describe any installed provider's capabilities.

For server and renderer acceptance, follow README.md and start an isolated fixture:

```sh
node --experimental-strip-types scripts/control-murage.ts launch
```

Use only the printed fixture URL and its temporary data directory; never use
the owner's live app, home, accounts or provider CLI. Stop the exact fixture
child before adding the fake custom ACP engine to its config. Restart that
fixture, open the picker, refresh models, and save a different model and
thinking choice on each of two bots. Give one bot a separate thread override.
Send through the pinned control surface and inspect the fake receipts and
returned text. Change one bot and confirm the other bot and thread override
retain their choices. After a restart, confirm saved choices and the cached
catalog remain, then refresh and send again. Confirm Agent default sends no
model setter and that unsupported thinking choices prevent a prompt.

Keep the printed log path, sanitized receipts, API read-backs, and control
send/wait/messages results as evidence. Interrupt the exact fixture launcher
for cleanup. A unit result alone does not establish this workflow or a
packaged desktop launch. This lane's restricted sandbox cannot launch a
listening fixture, so this recipe remains required shepherd verification.

Copilot shares the empty-session discovery transport. The pure
`server/drivers/acp/copilot-models.test.ts` checks premium labels, explicit
sign-in probes and Auto fallback. Its probe never sends `session/prompt`;
snapshots at startup read only the previously observed sign-in answer.
