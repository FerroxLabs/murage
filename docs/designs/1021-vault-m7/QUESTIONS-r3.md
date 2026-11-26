# VAULT-M7 part 1 r3: questions for the product owner and MAIN

Owners: VAULT-M7 design convergence lane r3 wrote these; MAIN relays and records rulings (Q2, Q3 are MAIN scope rulings); the product owner decides Q1. Recommendation first. Replaces QUESTIONS-r2.

Q1 POLICY (new acknowledgement; security row): residual R1 (DESIGN-r3 1.1).
Recommendation: accept. In r3 no Vault value ever reaches a file, an environment, a child process or a pipe. The only remaining same-user exposure is the one every provider and workspace key already has: a program running as the owner's OS user can, on Windows and Linux, ask the OS store for the key that seals `credentials.bin`, and on Windows read Murage's memory. This is a NEW acknowledgement for secrets (`docs/terms-acceptance.md:13` covers only the terms record). If declined, the only fail-closed alternative is no Vault on Windows and Linux in part 1.
Consequence to acknowledge with it (D25, fail-closed default already in the design): saved secrets are paused while any bot has Full access or runs on an engine/OS pair whose sandbox has not passed W29b, because such a bot could act as another bot on Murage's internal routes. The owner sees which bots cause the pause. Lifting this needs sender-bound internal authority (a separate design; Parked).
Also R2: the site the owner pins receives the value; the card says so.

Q2 SCOPE (MAIN): part 1 delivers saved secrets only to web APIs (`vault_fetch` to an owner-pinned https origin, in an owner-pinned header or query slot). Command-line use (CLI logins, PEM/SSH keys) moves to part 2.
Recommendation: yes. Two review rounds blocked command delivery because Murage has no per-command containment of its own (the host-power block is not a filesystem/network sandbox). DESIGN-r3 11.1 states what part 2 must meet. This also matches the MAIN ruling's intent (one call-scoped recipient, never readable by other bots or the model) more strictly than env/pipe injection.

Q3 SCOPE GATE (MAIN; Astra r2 #13): MCP pointer materialization (#5145) is not in part 1.
Recommendation: record the scope decision: keep it disabled in part 1 (D8, W17 prove the disabled state). Every MCP launch path writes key values to disk today (`server/drivers/claude.ts:5572-5585`, `server/drivers/pi.ts:1012-1016`); DESIGN-r3 11.2 is the part-2 contract (D3 owns the MCP side).

Q4 (carried): no plain-text opt-in Vault on headless or `basic_text` Linux in part 1. Recommendation: yes.

Q5 (carried): "Also use on My Cloud" may land after the desktop Vault, hidden until MurageCloud signs. Recommendation: yes.

Q6 (carried, builder check): 1Password SDK license confirmed from package metadata and NOTICE line added before merge.
