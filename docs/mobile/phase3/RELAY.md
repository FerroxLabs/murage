# Murage push relay: operating it

Worker `murage-push-relay` in the Ferrox Labs Cloudflare account (`874fe1689a53e6f56ff74816a9f23b26`), at `https://murage-push-relay.sean-874.workers.dev`. Its database is D1 `murage-push-relay` (`671f9ae8-0c93-4da6-8221-a8eaa2a6758d`). It stores push tokens, binding ids and counts. It never stores names or message text. Cloudflare's own invocation logs record the request URL and the client IP.

Run every command from `cloudflare/push-relay` with `CLOUDFLARE_ACCOUNT_ID=874fe1689a53e6f56ff74816a9f23b26`, using the authorized deployment operator’s wrangler OAuth login.

## Stop all pushes now
```bash
npx wrangler d1 execute murage-push-relay --remote --command "INSERT INTO relay_settings (key,value) VALUES ('paused','1') ON CONFLICT(key) DO UPDATE SET value='1'"
```
Resume with value `'0'`. While paused, every event is refused with `relay_paused`, and hosts retry up to six times. For a harder stop, set the var `RELAY_PAUSED` to `"1"` in `wrangler.jsonc` and deploy.

## Limits
- 10 bindings per device.
- 500 pushes per binding per day.
- `GLOBAL_DAILY_CAP` per day overall (100,000; see `wrangler.jsonc`).
- 50 queued per binding and 10,000 queued in total.
- Per client IP in D1: 30 challenges and 10 registrations an hour.

### Edge limits
Two Workers Rate Limiting bindings sit in front of D1. They are keyed by client IP (`CF-Connecting-IP`; an IPv6 client's whole /64 is one key) and checked before any D1 read, so a flood costs no D1 work. Over a limit, the relay answers 429 `{"error":"rate_limited"}`.

| Binding | Limit | What spends it |
|---|---|---|
| `EDGE_OPEN_LIMIT` | 20 a minute | `POST /v1/challenges`, `POST /v1/devices`, `POST /v1/publishers/redeem`, and any request whose bearer is missing or malformed |
| `EDGE_BEARER_LIMIT` | 120 a minute | Any request with a well-formed bearer, before D1 looks it up |

Why these numbers:
- A phone enrols in two calls, and a host redeems once per workspace, so 20 a minute is about ten pairings at once.
- Only D1 can tell a real bearer from a guessed one, so every well-formed bearer is counted. 120 a minute (2 a second) is far above any real host (at most 500 events a binding a day) and caps a guesser at 2 lookups a second per IP.

Keep these points in mind:
- Counters are kept per Cloudflare location and are approximate, so treat a limit as a ceiling, not an exact quota.
- The D1 limits still apply behind the edge limits.
- Without a binding (local tests, a dry run), its gate is open. A binding that throws also lets requests through and logs `{"edge":"unavailable"}`.

To change a limit:
1. Edit `simple.limit` for the binding in the `ratelimits` block of `wrangler.jsonc`. `period` can only be 10 or 60 seconds.
2. Run `npx wrangler deploy --dry-run`. It lists both bindings with their limits.
3. Run `npx wrangler deploy`.

To reset every counter, change the binding's `namespace_id` to another integer not used elsewhere in the account.

## Secrets
Upload them with `npx wrangler secret bulk <file.json>`, from a JSON file written under umask 077 and deleted straight after. Never paste a value.

Do **not** use `npx wrangler secret put <NAME>` fed from a file on stdin. On 2026-09-27 that stored `APNS_KEY` empty. The Worker started with APNs off, and every iOS send ended `rejected` until the key was uploaded again with `bulk`.

```bash
(  # a subshell, so the umask does not stay set in your shell
  umask 077
  f=$(mktemp)
  node -e 'const fs=require("fs"); fs.writeFileSync(process.argv[1], JSON.stringify({ APNS_KEY: fs.readFileSync(process.argv[2], "utf8") }))' \
    "$f" ~/.config/murage-mobile/<the .p8 file>
  npx wrangler secret bulk "$f"
  rm -f "$f"
)
```
Put several secrets in the one file to upload them together. `wrangler secret list` shows the names only, so it cannot tell an empty value from a good one. Check the upload instead:
1. Run `npx wrangler tail --format json` and send a test push to a phone of that platform.
2. APNs: no `{"apns":"off",...}` line appears. That line names the missing part as yes/no (`key`, `pem`, `team`, `keyId`), at most once a minute per isolate.
3. FCM: an empty or unreadable `FCM_SERVICE_ACCOUNT` shows only at send time, as `{"provider":"fcm","status":0,"reason":"not_configured"}` (APNs logs the same with `"provider":"apns"`).
4. The event's `accepted_at` is set in D1. A refusal logs `{"provider":"apns"|"fcm","status":...,"reason":...}` with the provider's own reason code, and an unanswered send logs `{"unanswered":<host>,"kind":<error name>}`.

| Name | What it is |
|---|---|
| `APNS_KEY` | The `.p8` PEM. It is Sandbox-only for now: key `DFHV7X5VH2`, team `PX6SP9GPWJ`, both vars in `wrangler.jsonc`. |
| `FCM_SERVICE_ACCOUNT` | `~/.config/murage-mobile/fcm-service-account.json`, service account `murage-push-relay@murage-mobile-260927`. |
| `PLAY_INTEGRITY_SERVICE_ACCOUNT` | Optional. Defaults to the FCM service account. |
| `ANDROID_DEBUG_CERT_SHA256` | The base64url SHA-256 of the debug keystore on Hetzner lane plan3b. It lets debug builds register. |

## Rotating a key
Upload the new secret with `wrangler secret bulk` as above, run `npx wrangler deploy`, then do the three checks. Nothing on the phones changes.

## Deployed
- **2026-09-27, Plan 3b D1 Steps 2, 3 and 5.** The D1 migration `0001` is applied. The smoke test on `/v1/nothing` answered `{"error":"not_found"}`, and `POST /v1/challenges` answered 201.
- **2026-09-27 19:03, R9 proven.** The first real APNs push from the Worker reached Sean's iPhone: the relay set `accepted_at` from the APNs sandbox. It took the fixes in commit `e69b58f7`, below.
- **Secrets re-uploaded with `wrangler secret bulk`.** `APNS_KEY` first (it had been stored empty), then `FCM_SERVICE_ACCOUNT` (from its file) and `ANDROID_DEBUG_CERT_SHA256` (the 43-character base64url SHA-256 of the debug keystore's DER certificate on Hetzner lane plan3b).
- **Edge rate limit deployed** (version `d4406c6f`, commit `57563a25`): `EDGE_OPEN_LIMIT` 20 a minute and `EDGE_BEARER_LIMIT` 120 a minute per client IP. The smoke test answered 404 on an unknown path and 202 on an event.
- **2026-10-01, full-review fixes deployed** (version `14acf4c9`, commit `d4bc4161`; the previous version `c9702676` is the rollback target). It deploys:
  - B2: the 16 KiB body cap is enforced while the body streams in.
  - B5: FCM events carry no `collapse_key`.
  - B9 with I-2: a platform with no provider secret refuses admission with 503 `provider_unavailable`, the host retries, and its queued events are never claimed.
  - B12: invalid-token deletions are logged.
  - B10: the resolved text reads "No longer waiting."

  No schema change. Smoke test: 404 on `/v1/nothing`, 201 on `POST /v1/challenges`, and 413 `request_too_large` for a 40 KB body with or without a Content-Length header. One minute of `wrangler tail` showed no errors.

### What the first device push taught (e69b58f7)
These passed the unit tests and failed only once deployed:
- **`redirect: "error"` throws in workerd.** Every APNs, FCM, OAuth and Play Integrity call became a silent network retry. The relay uses `redirect: "manual"`, which never follows either, and every caller treats a 3xx as a refusal. `test/workers-runtime.test.ts` bans `redirect: "error"`.
- **An empty `"secrets": { "required": [] }` block was removed as a precaution.** It was suspected of binding no secrets, but the key was still missing after its removal, so the proven cause was the empty upload below. Leave it out unless a wrangler version documents what it does.
- **`wrangler secret put` on stdin stored `APNS_KEY` empty** (a deployment mistake, not a runtime failure). Use `wrangler secret bulk` (see Secrets).
- **A send that fails must say why.** Refusals log the provider's reason code, and unanswered sends log the host and the error name. Neither ever logs a token, a URL path (an APNs path carries the device token) or a body.
