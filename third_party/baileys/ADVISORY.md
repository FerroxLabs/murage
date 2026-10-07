# Baileys advisory release evidence

GHSA-qvv5-jq5g-4cgg (critical, published 2026-06-10): message upsert and history sync spoofing and app state corruption from a crafted protocolMessage payload.

Checked 2026-10-06 against the GitHub advisory API and the npm registry:

- Affected: `baileys` >= 7.0.0-rc.1, < 7.0.0-rc12, and < 6.7.22 on the 6.x line.
- Patched: 7.0.0-rc12 (6.x: 6.7.22).
- Pinned here: 7.0.0-rc14, which is the npm `latest` dist-tag on the check date. Its registry integrity equals the lockfile integrity in `advisory.json`.

`check:whatsapp-inventory` refuses release qualification unless this record matches the staged Baileys version and lockfile integrity. Re-check before each release that changes the Baileys pin.
