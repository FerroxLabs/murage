# Flux one-click sign-in: human spec (run later, with Sean's OK)

A real run mints a Flux key and counts against Sean's 5 connected-app tokens. Do NOT run until Sean says so. FluxMain PR #207 is live in production (confirmed by FluxMain 2026-10-30); the browser consent step needs a person, so the real proof is Sean's live canary plus the L-GATE row.

Pre-check: the fluxDesktopSignin feature switch is on by default since 1.0.11 (shared/flux-desktop-signin-default.mjs); make sure config.json does not set features.fluxDesktopSignin = false, which turns it off and makes the IPC refuse with FLUX_SIGNIN_UNAVAILABLE. Flux PR #207 is deployed: https://fluxrouter.ai/desktop/authorize answers, and POST https://fluxrouter.ai/api/desktop/token returns {api_key, key_prefix, name, key_id (UUID), scopes} for client murage-desktop. Host fluxrouter.ai and the sk-flux- prefix are confirmed.

Stub run (no cost): `node --test electron/flux-desktop-signin.node-test.mjs` covers the full exchange against a local stub.

Real run, packaged desktop app, fresh data dir:
1. Settings, Models, Flux Router card shows "Sign in with Flux Router" and the paste field.
2. Click it. Button reads "Waiting for your browser…", the browser opens fluxrouter.ai/desktop/authorize with client_id=murage-desktop and a 127.0.0.1 redirect.
3. Press Cancel on the consent page. Murage shows "Sign-in was cancelled. Nothing was changed." No key saved.
4. Click again, Allow. The tab says "You're signed in". Card shows Connected; Test connection passes. Key never shown anywhere.
5. Click again and leave the browser alone for 5 minutes: "Sign-in timed out" and the paste field still works.
6. Open the authorize URL twice (second click while waiting): only one listener; Cancel sign-in stops it.
7. Replace flow: with a key saved, Replace key then sign in; revision accepted, old key replaced.
8. Confirm on the Flux side that exactly one token was minted per Allow.
