# Native provenance handoff

The Mac preflight now compiles both architectures and separately runtime-loads
notification authorization and presence on arm64 and native Intel x64. Windows
preflight pins the requested full source SHA and retains failure artifacts.
Hosted CI preflight is not a Windows client GUI, an installed-package test, or
macOS 14/15/26 performance evidence.

Both collectors verify the checked-out SHA against EXPECTED_SHA, require clean
native/script inputs, recompute native input hashes, verify the actual loaded
file against its build receipt, and re-read it after the load. Reports include
source SHA, native source hash, target, build hash and loaded hash. Notification
preflight checks all seven exports without requesting permission; presence checks
read, replacement subscriptions, repeated unsubscribe and exit with an active
subscription. Diagnostics without provenance never say `loaded: true`.

Reports are explicitly `stage: build-load`. N1 still needs the final signed
package/archive hashes, exact extracted/installed native bytes, signature/source
mapping, and runtime loads of those installed bytes on each required OS/arch.
Signing changes are not accepted as an unexplained exception to a hash mismatch.
The packaged qualification supervisor and final-byte mapper belong to wave 1B;
CI source scripts must not be run on Sean's Mac. Until those tools and real
receipts exist, final native qualification is OPEN.

No workflow has been dispatched by this builder. The local hub push does not
supply native runtime receipts or authorize a release. Named operators and the
final immutable package handoff are required before N1 can pass.
