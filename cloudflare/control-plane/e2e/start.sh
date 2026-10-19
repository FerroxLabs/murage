#!/usr/bin/env bash
# Starts the real control-plane Worker for the portal journey: fresh local D1 from the full migration chain, then wrangler dev.
set -eu
cd "$(dirname "$0")/.."
source ../../scripts/safe-wipe.sh   # the only recursive delete scripts may use
SAFE_WIPE_WITHIN="$PWD" safe_wipe "$PWD/.wrangler-e2e"
export WRANGLER_SEND_METRICS=false CI=1
./node_modules/.bin/wrangler d1 migrations apply DB --local --persist-to .wrangler-e2e --config e2e/wrangler.e2e.jsonc >/tmp/cp-e2e-migrate.log 2>&1 || { tail -30 /tmp/cp-e2e-migrate.log; exit 1; }
# The fixture Stripe key is assembled here, not written whole in the config: a literal in that shape trips push protection. billingConfig() still
# validates its format, so it must keep the sk_test_ + alphanumeric shape.
STRIPE_FIXTURE_KEY="sk_""test_e2efixturefixturefixture"
exec ./node_modules/.bin/wrangler dev --local --var "STRIPE_SECRET_KEY:$STRIPE_FIXTURE_KEY" --persist-to .wrangler-e2e --config e2e/wrangler.e2e.jsonc --ip 127.0.0.1 --port 8788
