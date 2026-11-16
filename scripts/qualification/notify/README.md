# Notify 1.0.19 qualification contracts

Authority: DESIGN-r2.md and the AGREE-as-amended Astra review, 2026-11-10.
This directory contains qualification infrastructure. It contains no real-OS
receipts and grants no product approval authority.

Wave 0 consumes e10dcd6bd (including 886fc55b7). `validateAdmission` requires
Windows 10 22H2 and 11 24H2 GUI; macOS 14/15/26 Aqua with native arm64 and x64;
Ubuntu 24.04 GNOME 46 X11 and Wayland; and an exact Fedora/Plasma 6 release.
Operator role names are not operators. Rosetta cannot qualify native performance.

Freeze the manifest, discovery inventory, generated subcases and their hashes
before observations. Every identity dimension is explicit (`none` when unused).
`checkId` names one assertion/stimulus; `captureToolId` and `profileKind` prevent
cross-credit between different tools and new/upgrade/mature profiles. Layout IDs
must enumerate light/dark, normal/maximum text, supported minimum work areas,
all offered system layouts and display geometry; capture inventory must include
each R2 tool/backend with a separately reviewed supportedness decision. Expanding
cases is allowed; shrinking after a failure is not.

The generator does not qualify the completeness of an operator inventory. MAIN
must review that inventory against R2.1/P2/P4 and bind it to the final RC before
using aggregation. A validator PASS describes only its supplied data; the release
join additionally requires signed/hash-verified files, instrumentation mapping,
all production reruns, real engines, G9 reviews and teardown receipts. Synthetic
test fixtures are never release evidence.

CPU units are percent of one logical core: 100 × (ON mean cores − OFF mean cores),
using unrounded duration-weighted integer counters. Existing S9 stays unchanged.
E profiles require identical idle bot rosters and the same roster-matching pinned
bot; only ON enables bubble/dock. Bubble and every expected dock must remain
visible throughout the interval. No enabled switch alone proves visibility.

Every actionable outside surface, including common-bound layouts, requires a
main-owned qualified layout/envelope revision. Unknown layouts cannot issue
authority; layout changes invalidate outstanding tokens. The differing-bounds
selector contingency does not make this runtime safety requirement optional.

Real qualification remains OPEN until the separately owned native collectors,
GUI rig, discovery, presence/capability, envelope, copy and final-join slices and
all operator receipts are complete. Missing permission/runner is admission OPEN,
not behavioral RED. Retain failed and invalid attempts alongside successful ones.
