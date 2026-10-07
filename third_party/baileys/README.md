# Baileys

Murage links a local WhatsApp Web multi-device session through
[Baileys](https://github.com/WhiskeySockets/Baileys), npm package `baileys`,
pinned at exactly `7.0.0-rc14`. Advisory review is a release gate; see
`ADVISORY.md` and `advisory.json`. Licence: MIT, Copyright (c) 2025 Rajeh Taher /
WhiskeySockets (see `LICENSE`).

Baileys depends on `libsignal` 6.0.0, which is GPL-3.0; its licence text is in
`../libsignal-node/LICENSE`. GPL-3.0 is compatible with Murage's
AGPL-3.0-or-later.

Baileys is staged unmodified into `server/node_modules` by
`scripts/stage-whatsapp-runtime.mjs`. Upstream disclaimer, quoted:

> This project is not affiliated, associated, authorized, endorsed by, or in
> any way officially connected with WhatsApp or any of its subsidiaries or its
> affiliates.
