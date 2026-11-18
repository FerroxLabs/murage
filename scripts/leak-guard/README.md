# Shared public-tree leak guard

Run `node scripts/leak-guard/check.mjs --root . --base 0bcda6c9e`.
This thin adapter invokes `/work/fuigo-builds/shared/leak-guard.sh` with the
same directory's `public-leak-patterns.txt`. There is no repository pattern
list or alternate matcher. Do not edit the shared pair or create exclusions.

The shared guard scans tracked text at **HEAD** and added lines from the base
to HEAD. Commit changes before checking; working-tree edits and staged changes
are not scanned. Its matching and coverage rules are authoritative.

The wrapper captures raw shared output and prints only hit counts for each
section. It never prints matched source or Git diagnostics. Exit 0 means
clean; exit 1 means hits; exit 2 means configuration/execution failure.
Both nonzero exits block release. An inventory of unresolved runtime names
is for MAIN's review, never an exclusion or an automatic pass.

For isolated containers, provision an unchanged copy of the shared pair and
set `PUBLIC_LEAK_GUARD_SHARED_DIR` to its directory. Verify both file hashes
against the canonical pair before running. Missing shared files fail closed.
The shell script prefers the canonical pattern path when it is readable.
There is no `--patterns` or arbitrary diff-input option.

The fixture tests commit temporary repositories and construct positive
examples from split strings. The repository gate separately requires the
actual HEAD and release additions to pass the shared guard.
