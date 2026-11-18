# Owner backup continuation English inventory

Owners: afix-nl-backup-b owns the continuation producer and this inventory;
salv-spend owns existing spend and pause messages; tri3-g2 owns existing backup
card copy and registered settlement.

The authority slice introduces these English diagnostics in `server/index.ts`:

| Literal | Audience and meaning |
| --- | --- |
| `backup continuation stopped before submission` | Internal setup refusal: identity, policy, epoch or ticket changed. |
| `backup continuation selection changed before submission` | Internal setup refusal: durable source, engine, failover row or task marker changed. |
| `backup continuation already submitted or stopped` | Internal setup refusal: final single-use claim or cancellation check refused. |
| `owner backup continuation refused` | Server log prefix for automatic selection failure; only the error class is logged. |
| `raised backup continuation refused` | Server log prefix for fresh owner raise failure; only the error class is logged. |

`server/owner-limit-continuation.ts` introduces the internal error codes
`backup-continuation-cancelled` and `backup-continuation-already-applied`.
They are storage/dispatch diagnostics, with no action label or localized UI copy.

The authority checks reuse the existing API response `This choice is no longer
available.` for a stale raised/explicit application and the existing `not found`
response for an excluded caller. These literals predate the authority slice.
Existing backup offer, Wait, engine billing, takeover and spending refusal copy
is unchanged. The saved-backup fix adds no English runtime literals.
