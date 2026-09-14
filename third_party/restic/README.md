# Restic 0.19.1

Upstream: https://github.com/restic/restic/tree/v0.19.1
BSD-2-Clause; upstream LICENSE retained here. Restic is a separate executable,
not a custom Murage encryption implementation. Build pins live in
shared/backup-restic-pin.mjs. Only darwin-arm64 is currently admitted.

The raw upstream payload is checked before staging. A re-signed Mac tool must
retain its pinned normalized payload and pass Apple-anchor/current-app Team ID
verification. Native signed-package qualification and dependency attribution
review remain release gates; source/mock checks do not supply those passes.
