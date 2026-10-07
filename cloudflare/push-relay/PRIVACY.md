# Relay retention and operator notes

The Worker reads `CF-Connecting-IP` only to normalize it in memory, reducing
IPv6 to /64 and treating IPv4-mapped IPv6 as IPv4. It does not read
`X-Forwarded-For` or `request.cf`. Edge limiters and D1 IP counter scopes receive
only a hexadecimal HMAC-SHA-256 digest. The signed input is the integer UTC
two-day period since the Unix epoch, a newline, and the normalized address.
Each new period produces different keys and starts new counters.

`IP_HASH_KEY` is an optional Worker secret. Without it, a lazily generated
256-bit random key lives only in the isolate. Those counters are per-isolate,
so configure the secret for limits shared across isolates. Changing the secret
also resets the IP counters. No secret value belongs in `wrangler.jsonc`.

An operator can set the secret from this package directory using the existing
bulk-upload procedure below. This is a future operator action requiring
Cloudflare access; it was not run during this build:

```sh
(
  umask 077
  relay_secret_file=$(mktemp)
  trap 'rm -f "$relay_secret_file"' EXIT
  node -e 'require("node:fs").writeFileSync(process.argv[1], JSON.stringify({IP_HASH_KEY: require("node:crypto").randomBytes(32).toString("hex")}))' "$relay_secret_file"
  npx wrangler secret bulk "$relay_secret_file"
)
```

Wrangler 4.125.0's installed `config-schema.json` supports `invocation_logs`,
`head_sampling_rate`, `persist`, and trace enablement. It has no errors-only
sampling or request-field exclusion option. Invocation logs (which carry
request headers, the client IP among them) and traces are disabled; sampling
stays at 1 so every remaining line is kept. Application console calls are
error-only and use fixed fields and allowlisted diagnostic codes, never
addresses, tokens, or request bodies, so Workers Logs keep only those error
lines. After deploy, confirm in the dashboard that an error event carries no
request headers. This change does not erase historical platform logs or D1
recovery history (D1 Time Travel keeps up to 30 days of prior states).

IP counters are hourly. The minute cron deletes each `ip-%` counter once its
hour has closed, so a digest is kept for about an hour. The same rule removes
any raw-IP counter an older Worker writes between migration 0002 and deploy.

The approval-key route (`POST /v1/approval-keys`) keeps nothing about the key,
the install id or the statement it signs: no row, no log line beyond the usual
route and status. It spends the challenge, and counts requests per IP digest
and per SHA-256 of the install id for one hour; the cron deletes both counters
once the hour has closed.

Apply these additive migrations in order with the matching Worker release:

1. `migrations/0002_ip_hash_counters.sql` deletes all legacy `ip-%` counters;
   IP scope suffixes now mean rotating keyed digests. Other quotas remain.
2. `migrations/0003_idle_activity.sql` adds `relay_bindings.last_active_at`,
   backfills it and the existing `relay_devices.last_seen_at` to migration
   time, and indexes both activity columns. All timestamps are UTC epoch
   milliseconds.
3. `migrations/0004_last_binding_cleanup.sql` adds
   `relay_forget_unbound_device`, an `AFTER DELETE` binding trigger. Deleting
   the final binding deletes its device and push token in the same transaction.
   A failure rolls back both removals.

Devices are active on registration, successful token refresh, successful
binding creation, accepted host publish (including deduplication), and
successful provider delivery. Token refresh touches all the device's bindings;
publish and delivery touch only their binding and its device. Refused refreshes
and failed delivery attempts do not extend retention. Last-binding removal
still deletes the device immediately, including when its grant expires.
Replacing expired grants inserts the replacement first within the same batch.

The existing minute cron sweeps bindings idle for at least 30 days, expired
grants, and unbound devices idle for at least 30 days. Binding deletions cascade
to events and immediately remove newly unbound devices. Each table's primary
delete selects at most 500 rows per round, with at most four rounds per run.
That is at most 2,000 selected bindings and 2,000 selected unbound devices per
run, plus dependent cascade deletions. Backlogs drain over later runs. Cron
cleanup still runs while delivery is paused.

Verification uses isolated in-memory SQLite fixtures, fake provider responses,
and the actual Worker fetch and scheduled entrypoints. No live app or remote
Cloudflare resource is used. Run `npm test` and `npm run check` here. The first
privacy regression run had 15 failing tests on the original implementation,
covering all four requested items; the implementation made those tests pass.
