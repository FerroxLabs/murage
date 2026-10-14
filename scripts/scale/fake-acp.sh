#!/bin/sh
# The ACP engine the rig's bots use: answers at once, so any time above it is Murage's own.
exec node --experimental-strip-types /work/server/testing/fake-acp-cli.ts "$@"
