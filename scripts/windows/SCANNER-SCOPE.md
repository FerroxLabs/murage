# Native-call scanner scope

Binding MAIN ruling: winscen p11f, 2026-11-11T01:10Z. This scope overrides
every earlier scanner clause and decides all future scanner reviews.

The native-call scanner exists to stop OUR OWN gate scripts (written by our builders, reviewed, in our repo) from
ACCIDENTALLY killing or spawning a process that the gate does not own on Sean's Desktop. It is not a sandbox
against a deliberately obfuscating author of our own code: such an author could defeat any static check, in any
language, and is out of scope by the same reasoning as Sean's ruling on obfuscated commands on owner turns. The REAL
guarantees on the Desktop are the runtime ones, already confirmed by crev4-6: every native helper runs suspended in
its own no-breakaway job, is killed only via TerminateJobObject, cleanup is by name with deadlines, escaped processes
are REPORTED, never killed, plus the NEVER-list. Reviews judge the scanner against ACCIDENTAL use: an ordinary,
plausible way a builder might write a kill/spawn call. A deliberately obfuscated construction (Function via
.constructor, string-built code, encoded payloads, prototype tricks) is NOT a P1 against the scanner, as long as
the cheap structural bans below hold.

## Cheap structural bans

- Any member access named `constructor` whose result is called or passed, and any call on a call result of
  `.constructor` (crev6's exact input).
- `Reflect.apply`/`Reflect.construct` and `.call`/`.apply`/`.bind` on a non-local function value obtained from a
  computed member.
- Keep the earlier bans (eval, Function, vm, dynamic import, process aliasing).

The two owner files are `owned-process.ps1` and `native-launcher.mjs`.
The constructor check rejects the member value at its source, including calls,
passed values, aliases, and calls on the constructed result. Computed member
values used with `call`, `apply`, or `bind` are rejected directly or through
local variable aliases; locally declared functions remain usable.
