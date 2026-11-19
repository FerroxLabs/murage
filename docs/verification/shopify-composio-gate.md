Shopify consumer owner: shopify-graphql-d, branch dev/1019-shopify-graphql.
Composio producer owner: composio-429-j, branch dev/1019-composio-429.
Combined landing owner: MAIN; acceptance owner: independent release reviewer.

# Shopify unattended GraphQL release gate

H1 is implemented in the Shopify consumer: captured routine/delegation authority
counts as unattended even when the thread has no unattended mark or live routine.
Unattended Shopify REST is refused before dispatch; GraphQL remains available.
Attended REST and other toolkits retain their existing behavior. Shopify access
uses Composio or Shopify's own MCP; this change adds no custom app or credential path.

H2 (broker backoff and idle polling) requires the reviewed Composio producer at
`4808e9d19a554076f9e6b22d6d215d2927768a32`. The consumer must land with or after
that commit. The standalone consumer does not contain the inherited H2 repair.
Do not treat a Shopify-only test pass or Composio's independent PASS as proof of
the combination. Do not reimplement the producer's admission or polling policy.

Before release, the combined checkout must satisfy:

```sh
git merge-base --is-ancestor 4808e9d19a554076f9e6b22d6d215d2927768a32 HEAD
pnpm exec vitest run server/shopify-unattended.test.ts
```

Run the producer's complete reviewed gate on that same combined source, including
its backoff, admission, connector bridge, lifecycle/recovery, supervisor and
rendered Retry tests, ownership/IPC checks, mutants, and server/renderer typechecks.
Retain execution evidence outside the repository. Qualification of a composed
tree does not authorize merging an integration branch.

The Shopify suite also gates the consumer/producer boundary for HTTP 429 and 503:

- Direct, USE_TOOL and batch GraphQL calls send once on the initial refusal.
- A distinct call during Retry-After is not sent, including immediately before
  the deadline, even if the transport would now succeed.
- A broker outage creates no Shopify reconnect incident or owner reconnect prompt.
- After the deadline, a fresh request succeeds; the refused action is not replayed.

These six witnesses fail on the standalone consumer base and require the pinned
producer. Existing provenance, REST refusal, token-failure and single-prompt
assertions remain in force. No expectation changes or production test hooks are
needed for this contract.

The producer's documented pre-W1 remote-mint loss window remains outside its
agreed recovery scope. Packaged Windows/Electron smoke remains a separate gate.
