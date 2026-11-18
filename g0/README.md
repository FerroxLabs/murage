# Signal G0 capture sanitization

`g0/scrub.py` is the repository-owned replacement for
`/work/fuigo-builds/l1-signal/g0/scrub.py` named by the Signal ruling. It uses
source-derived schemas at `48a0a5e90cb0c36153f0276c0affff090e588290`.
No real captures or identities are included here.

Run one session over the complete capture directory so identity aliases,
RPC IDs, link URI aliases and the time origin remain consistent across files:

```sh
python3 g0/scrub.py --bundle /private/raw /private/new-staging
```

The raw directory must contain only named JSON/JSONL fixtures. Each fixture
must have one complete frame. Unknown filenames, fields, dictionary keys,
protocol enums, MIME types, shapes, malformed JSON and symlinks stop the
entire bundle before output is created. Extend the reviewed schema when a
new pinned-source shape is needed; never add generic string passthrough.
Group/history/long-text/timer/malformed-identity probes remain in scope;
an unsupported capture blocks publication until its schema is reviewed.

Numbers become valid +1555 aliases; service IDs become valid v4 UUIDs.
ACI and PNI use separate aliases, with the PNI prefix retained. Malformed
identities remain malformed using fixed text. Message bodies and attachment
metadata are replaced; text over the admission limit keeps its length.
Attachment bytes/keys/paths are never copied. Link URIs contain only fixed
fake key material and mapped UUIDs. Positive timestamps share a single shift;
zero sentinels, device IDs and expiration durations retain their meaning.
Never sanitize fixtures one by one for a release: the two-argument JSONL
mode is only for inspecting a single batch.

Review **every output artifact in full**, including SANITIZATION.json,
fixtures, eventual manifest, logs, screenshots and other publication files.
The sanitizer is not a human review, nor proof of a live run. Raw screenshots,
QRs and logs are not accepted by this tool and must not be published from the
raw directory. A reviewer creates a separate JSON file outside staging:

```json
{
  "reviewer": "review citation",
  "signalCliCommit": "48a0a5e90cb0c36153f0276c0affff090e588290",
  "artifacts": { "own-note.json": "sha256 of exact bytes", "SANITIZATION.json": "sha256 of exact bytes" }
}
```

Then `python3 g0/scrub.py --review /private/new-staging /private/review.json`
checks exact enumeration and digests. Any added, omitted, modified or linked
artifact invalidates review. This command does not publish or auto-approve.
Create the production fixture manifest only after review, include it in a
final review inventory, and bind its digest in the runtime pin. Keep sanitizer
inventory/review records outside the loader's strict fixture directory.
