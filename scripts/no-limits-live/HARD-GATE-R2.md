# Native execution proof

A permission request or answer never establishes execution. Native accounting
requires a successful tool completion joined to exactly one start by provider,
provider instance, thread, turn and item. The start must match a committed input
declaration. Completion arguments, when supplied, must agree with that start.
Denied must-card operations contribute zero executions.

Field scenarios additionally bind the completed operation to their requested
command or file payload. Shell commands normalize line endings and surrounding
whitespace; file paths resolve against the fixture working directory. ACP tool
kinds and native identities select the operation, independently of command titles.

`unavailable-shell-missing-input` has a dedicated binding that requests Bash with
`{}`. Both action proof and independent accounting validate the missing-command
witness. An ordinary populated command fails. An adapter's null approval input
is declared only for that empty form. The release fake dispatches no executable
command for this probe.

Routine wake fixtures require a distinct provider turn starting after the delivered
`S3_PEER_REPLY`, its successful completion, and provider-authored text linked to
that turn. An inbound or copied `dres-*` row supplies only the delivery boundary.
See `HARD-GATE-R3.md` for the corrected proof and retained wake witnesses.
Append readers retain byte offsets and thread indexes; registration
lookup indexes request suffixes without assuming identifiers lack colons.
Malformed or incomplete final log rows fail closed.

Run the regression suite with Node 24:

```
node --experimental-strip-types --test scripts/no-limits-live/hard-gate-r2.node-test.mjs scripts/no-limits-live/afix-review.node-test.mjs
```

The focused native proof launches only disposable local servers and fake engines:

```
node --experimental-strip-types scripts/no-limits-live/hard-gate-native.mjs NEW_OUTPUT_DIRECTORY
```

Run both through the assigned network-none container runner. The native command
checks Claude, Codex and Fuigo shell/write/missing-input/wake rows; it explicitly
reports `releaseGate:false`. Full catalogue, private corpus and other OS release
proofs remain the release runner's responsibility.
