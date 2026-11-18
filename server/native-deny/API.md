# Dormant S0 compiler and backstop

Nothing imports this directory from a driver or the running server. No engine is
eligible or switched by this slice. Profile, registry, emitters, real-engine
probes and integration remain separate slices. These checks recognize launch
text, as the upstream reader does; they do not contain processes or descendants.

`compileDenySpec({descriptor, paths?, refusals?, selfPaths?})` requires trusted
upstream metadata. The private classifier sets are not copied into production
code. Until ownership release supplies an exhaustive upstream descriptor export,
integration remains blocked. `test-support.ts` extracts descriptor data from the
existing source strictly for isolated tests. It is never imported by production.

Descriptor exceptions are tagged strings: `exact:<path>`, `prefix:<path/>`, and
`regex:<source>`. Prefix exceptions distinguish the folder itself from its
contents. Every system row preserves the upstream exceptions; root, home and
volume rows have self scope. An emitter must preserve these meanings exactly or
return unexpressible. Self-scope rows belong to L2; they must never become home
subtree denies. No wipe-prefix vocabulary is duplicated: the wipe rows come from
ALWAYS_ASK_NO_LIMITS, with empty optional L1 prefixes and the real reader at L2.

Additional paths discover homes, volumes and lexical/real aliases. Protected rows
come from owner-mode protectedClass. POSIX refusal paths preserve case. Ambiguous
Windows aliases return unexpressible, while ordinary absolute drive paths are
normalized. Grammar-specific escaping belongs to each emitter.

Before launch, reserve a private transport directory, use
`nativeDenySocketPath(privateDir)`, and include that directory, the token file,
configs and client scripts in selfPaths. Compile and emit the policy before
creating the session. Pass createNativeDenySession the server's pinned engine
identity table (`tools`), launch cwd/home/shell/env digest, policy hash, integrity
files and a tamper callback. The table maps exact engine tool identities to
shell/stdin/code/patch/read/write. The S0 code kind pins the upstream
`execute_code` Python identity and passes its raw source to that reader. An
optional language declaration must be `python`; other code languages need a
trusted adapter identity before integration. Unknown names and all MCP requests are denied
here; retain existing MCP mediation separately. No request can inject that table.

`startNativeDenySocket(session, {path, envFile})` creates an exclusive 0600 token
file and socket under private directories. It rejects transport paths absent from
the compiled selfPaths. Token contents are passed through the environment file,
never argv. The returned `close()` verifies pins at turn end and retires the
session before closing clients. The caller owns and removes its private directory.

`makeNativeDenyRequest` constructs test/client requests. `requestNativeDeny`
requires a whole matching response and validated-operation digest. The digest
binds generation, tool/mount, complete argument digest, cwd, shell, environment,
policy and DenySpec. It proves consistency of the operation data, not identity of
the process actually executing it. Preserve canonical-byte checks at the real
use point. Same-UID token theft, endpoint replacement and transient
edit/execute/restore are residual risks requiring an OS boundary.

Do not send a prompt until a full positive round trip succeeds from the engine's
actual seam. Server listen success alone proves no engine liveness. Any timeout,
server loss, disconnect, partial frame, invalid digest or replay denies. Nonempty
stdin denies because a live interpreter/session's cumulative execution context
is not bounded. Empty polling is allowed after binding.

The ownerMarks wrappers are synchronous. Typed denies, mandatory findings and
named catastrophes precede wipe-table filtering; ordinary unreadable text remains
allowed. Reader exceptions, deadlines, size limits and work-budget exhaustion
deny, even below the 16 MiB transport cap. The word proxy cannot waive an
incomplete read. Reads/edits resolve paths through the upstream placement helper.
Refusals and self paths also check lexical/real aliases. POSIX placement expands
symlink components before a following `..`, retaining raw relative components
until they have been placed against the session cwd. Shell matching of new self/refusal paths is best effort at launch,
including literal relative names; it does not inspect arbitrary later effects.

Pins are rehashed on every request and at turn end, with no metadata-only cache.
A mismatch retires the session, bumps generation, sets its conversation profile
to today and calls onTamper. Integration must terminate and await its tracked turn
and descendants and persist the conversation restriction in that callback.
Pending reads recheck generation and integrity before allowing. Rehashing cannot
guarantee detection of an edit/execute/restore between checks. The F4 regression
uses a fake byte consumer to witness altered same-inode, same-size bytes with
restored mtime, then restores them before the next request/turn-end sample. That
sample allows, documenting the limitation rather than claiming containment.
Separate regressions require denial before calling the reader when bytes differ
at request entry, and before returning a pending allow when bytes differ after
reading. Restoring after either denial cannot revive the retired session. Real
consumers must retain their existing canonical-byte checks at their own use
points; S0 does not integrate or replace them.

Run the S0 test suites, fix-regressions.test.ts, s0-mutants.mjs and
fix-mutants.mjs only in an isolated fixture container. They execute no payloads or real engines. The fixture has temporary
home/data via the repository's testing setup, and the transport suites create
throwaway sockets. They prove these dormant modules; no user conversation or
engine integration workflow is claimed.
