# F6 membership and identifier-array amendment

Authorized by afix-hlf6-rv for problems 2 and 3 in the F6 review design.

`users.get` permits `users.list` as its ownership preflight. `users.update`
and `users.delete` permit `users.list` before `users.get`. Each nested user
operation establishes membership from a complete inventory scoped to the
trusted connection location before accessing the global user endpoint.
Conflicting location or account-type declarations refuse ownership.

Shared argument validation derives identifier-array paths from each supplied
frozen schema and validates every element with `highlevelIdSchema`. Scalar
identifier fields retain scalar validation. The existing `contactId: string[]`
task-search contract and its JSON body are unchanged.

No operation IDs, scopes, risks, retry classes or dispatch interfaces change.
`users.create` retains its existing credential-input refusal pending Sean's
password-flow decision. This amendment adds no password input.

Regenerate only `frozen-contract.json` using `contractSnapshot` in
`scripts/highlevel-f0-snapshot.ts`; historical additive snapshots stay intact.
