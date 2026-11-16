# Fuigo trust qualification

The process-only primary route is already implemented. The production switch
`FUIGO_PROCESS_TRUST_REPLY` remains false until the acceptance conditions in
FUIGO-PROCESS-REPLY-ON are met: review against the real Fuigo implementation,
and real No limits owner turns in picked folders on Linux, Windows and macOS.
Each run must show no card, the folder instructions arriving, and no durable
trust grant. Tests with a fake CLI do not satisfy those conditions.

The schema-2 receipt checker now requires the captures at merge time:

```
node scripts/fuigo-bump.mjs --merge-check path/to/bump-VERSION.json --real-turns path/to/captures
```

It rechecks every capture and compares the derived result with the receipt.
The receipt also carries `packageVersion`; regenerate older receipts with the
bump tool rather than filling in missing evidence. Three OS names alone are
not qualification. This change does not qualify a binary or change any pin.

Remaining assurance limits of schema 2: package identity and driver-reported
store observations remain claims in the captured driver record. The ledger's
FUIGO-BUMP-EVIDENCE redesign requires separately reviewed proof of store
reads, attempt accounting, snapshot timing and card controls. Rechecking the
same schema does not resolve those design findings. That work and primary
activation remain open until the required design and real-OS evidence exist.

Settings now distinguishes unstamped Murage grants, checks consent 2 before
calling a generation-2 upstream grant effective, and reports the launcher's
temporary home for an unrouted Cloud turn. The settings tests use isolated
homes; they do not change the owner's Fuigo trust file.
