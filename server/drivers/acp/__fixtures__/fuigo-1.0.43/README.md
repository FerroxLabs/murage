These are the unchanged published 1.0.43 S1/S2 run-1 captures and receipts,
previously required from an absolute build-host path. They are captured provider
frames, not synthetic replacements. `PROVENANCE-1.0.43.json` binds each frame
file's SHA-256 to the release commit and binary. The authority for that
release is the lane pin in the repository: the root `scripts/fuigo-1.0.43-provenance.json`
plus `FUIGO_ASSETS` in `scripts/prepare-fuigo.mjs`. The receipt in this
directory's `scripts/` is a cross-check only; it may be absent and never supplies the pin.
`assertPublishedFuigoCapture` checks the lane pin before replay. The test still
accepts `FUIGO_1043_CAPTURE_DIR` to qualify an external copy of this same drop.
