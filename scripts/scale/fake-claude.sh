#!/bin/sh
exec node --experimental-strip-types /work/server/testing/fake-claude-cli.ts "$@"
