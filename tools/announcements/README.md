<!-- Copyright 2026 Ferrox Labs. SPDX-License-Identifier: AGPL-3.0-or-later -->
# Announcements publishing kit

Short notices from the Murage team (a Flux outage, a fix to install, a new
feature) that reach every app without a release. The app side is
`server/announcements.ts` (fetch, verify, cache, filter) and
`src/components/Announcements.tsx` (banner and card). This folder is the
publishing side, meant for the private repo `FerroxLabs/murage-announcements`.

| File | What it is |
|---|---|
| `example/announcements.yml` | A commented example: every field, two notices |
| `announcements.schema.json` | Editor help for the YAML (lint.mjs is the real check) |
| `build.mjs` | YAML to feed, using the app's own rules (`shared/announcements.ts`) |
| `lint.mjs` | `node lint.mjs announcements.yml`: fails on anything the app drops or the copy rules forbid |
| `sign.mjs` | `node sign.mjs announcements.yml out/`: lint, then Ed25519 sign; key from `ANNOUNCEMENTS_SIGNING_KEY` |
| `github/publish.yml` | The workflow for the private repo: lint on PR, sign and upload on merge after the owner approves |

## The private repo

```
announcements.yml
images/               pictures the notices use (png, jpg, webp, up to 1 MB)
.github/workflows/publish.yml   copied from github/publish.yml
```

Add or change a notice in a pull request. The check lints it and writes a
preview to the job summary. Merge to main, approve the
`announcements-production` deployment, and it is live within minutes; apps
pick it up on their next check (at launch, then every six hours). To pull a
notice, delete it and merge.

## Keys

Generate the signing key on a trusted machine, never in CI and never in a repo:

```
openssl genpkey -algorithm ed25519 -out murage-announcements.pem
node tools/announcements/sign.mjs --public-key murage-announcements.pem
```

1. Paste the printed public key into slot 1 of `ANNOUNCEMENT_PUBLIC_KEYS` in
   `server/announcements.ts` (replacing the placeholder) and ship a release.
   Until a release carries a real key, apps fetch nothing.
2. Put the PEM into the `ANNOUNCEMENTS_SIGNING_KEY` secret of the
   `announcements-production` environment, and the public key into its
   `ANNOUNCEMENTS_PUBLIC_KEY` variable. Keep an offline copy of the PEM.

Rotating: generate a new key, put its public key in slot 2 and ship a release.
Once most apps have it, switch the environment secret and variable to the new
key. In a later release move it to slot 1 and empty slot 2.

## Rules the app enforces

One fixed URL, `https://updates.ferroxlabs.com/murage/announcements.json`, plus
`.sig`. No query string, no cookies, no identifying headers. 64 KB at most,
20 notices at most. Unsigned, badly signed, or older than the copy the app
already has (`issuedAt`) is ignored. Pictures only from
`https://updates.ferroxlabs.com/murage/images/`. Security notices show even
when someone switches announcements off in Settings.
