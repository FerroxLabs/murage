# VAULT-M7 part 1 r2: questions for the product owner

Owners: VAULT-M7 design lane r2 (vault-m7-design-1021-r2) wrote these; MAIN relays and records rulings; the product owner decides. Recommendation first, then what was checked. r1's Q1-Q5 are replaced by this list.

Q1 POLICY (needs acknowledgement; security row): residuals R1 and R2 (DESIGN-r2 1.1).
Recommendation: accept both as stated, with the two lines on the card and the Vault page. R1: a program running as the owner's OS user, including a Full-access bot's command, can read a running process's environment (and on Windows its memory), and on Windows/Linux can ask the OS store for the key. That already holds for every secret Murage keeps today; the Vault narrows it to the life of one `vault_run` call, with stdin delivery by default so no environment holds the value. R2: a granted bot's own command gets the value and could disguise or send it; Murage masks every known encoding before the bot sees output. The ruling "never readable by the model" holds for everything Murage does; it cannot hold against a granted bot's own command without a per-bot OS sandbox or owner-pinned commands (both Parked: new surfaces).
Checked: `docs/terms-acceptance.md:13` (the existing same-user residual); `server/procs.ts:293-300` (launcher env fixed, child env passed in a stdin frame).

Q2 SCOPE: MCP key slot binding ("Use a saved one" on an MCP key) moves to part 2.
Recommendation: yes. Every MCP launch path today writes key values to disk (Claude's per-turn credential file and `mcp.json`, Pi's `mcp.json`), which breaks the no-plaintext-file ruling, and Astra C2 needs a recipient fence that D3 owns. DESIGN-r2 11.2 gives the contract part 2 must meet.
Checked: `server/drivers/claude.ts:5572-5585`, `server/drivers/pi.ts:1012-1016`, `server/mcp-secrets.ts:227-236`.

Q3 SCOPE/DEPENDENCY: 1Password provider in part 1.
Recommendation: yes, with no value cache (read per use). The builder confirms the SDK license from the package metadata and adds the NOTICE line before merge.

Q4 POLICY: plain-text opt-in Vault on headless servers and Linux without a keyring.
Recommendation: not in part 1 (Vault LOCKED there). An opt-in needs its own writer, recovery and owner-visible protection level (Astra H8); park it for a later round. If W19b finds a 1.0.20 writer that drops the section, add the release note "Going back to an earlier version removes saved Vault secrets."

Q5 SEQUENCING: "Also use on My Cloud" (S6) may land after the desktop Vault.
Recommendation: yes; the button stays hidden until MurageCloud signs the contract in DESIGN-r2 8.
