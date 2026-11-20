# HighLevel reference source (Sean 11-10: reuse source material, don't design from scratch where code exists)

Use these BEFORE writing new code; port and adapt where they fit, and say in DONE what you reused.
1. Upstream OpenMaus (our licensed upstream; AGPL-compatible): /root/fuigo-builds/orph/_ev/refs/upstream-openmaus-highlevel/
   - highlevel.ts: Cloudflare control-plane HighLevel OAuth + Marketplace install/token broker (411 lines) — the reference for the Marketplace app, OAuth token exchange/refresh, and webhook intake (F8, C1 connection).
   - highlevel.test.ts: its tests (port the cases).
   - composio-broker-index.ts: the broker pattern for third-party app calls.
   - README.md: control-plane notes.
2. Murage's own earlier HighLevel writes work (hub /root/mb-105-git.git): 4baaa1d9c (final writes round), 122892b6c, e77793331 (W1), d370a1fb9 (W2 native wins), 506ea3ef6, 6a04f7080, 67089e013, 0b28c4679, d344ed73c, c35914837, f2f26eb83, 36da71cd8; branches feat/1017-hl-s2-w1a, feat/1017-hl-s2-e. The design's "Restores from" column names which commit each slice restores.
3. Current HighLevel code: /root/fuigo-builds/orph/_base/server/highlevel/*.ts and shared/highlevel.ts (read-only tools, client, provider-contract endpoints).
4. Hermes agent and OpenClaw: no HighLevel-specific code in our copies, but use them for tool/approval patterns: hermes-agent tools and skills (/root/fuigo-builds/orph/_base/third_party/hermes-agent), OpenClaw app catalog pattern (ask MAIN for a copy if you need it).
5. HighLevel API v2 docs (public, read-only web; no account sign-in): the source of truth for endpoints and scopes in S0's manifest.
