# VAULT-M7 part 1 r5: questions for the product owner and MAIN

Owners: VAULT-M7 design lane r5 (design-1022-row87-vault) carried these forward from r4 unchanged in substance; MAIN relays and records rulings (Q2, Q3, Q7 are MAIN scope rulings); the product owner decides Q1. Recommendation first. Replaces QUESTIONS-r4. r5 changes no question; it adds two facts to Q1: a removal shown as "Not removed" (disk not writable) is never applied later, and saved-secret files are written by a worker thread that holds only sealed bytes.

Q1 POLICY (product owner; new acknowledgement): residual R1 (DESIGN-r5 1.1).
Recommendation: accept. No Vault value reaches a file other than the sealed `secrets/vault.bin` (and its sealed write temp: unlinked after a failed write when possible, otherwise swept at the next boot before any further Vault write), an environment, a child process, a pipe, or the server process. The remaining same-user exposure is the one every saved key has: a program running as the owner can ask the OS store for the sealing key, and on Windows read Murage main's memory.
Consequence to accept with it (D25): saved secrets are paused while any bot or any one of its tasks has Full access (No limits needs Full access) or runs on an engine/OS pair that has not passed W29b; a turn that was live during a pause cannot use the Vault, its next turn can. The builder runs W29b first and attaches the per-pair table, so the owner sees how many real homes start paused. Demoting a bot does not stop programs it already started (stated on the page). After a crash, saved secrets stay paused until the owner presses Resume on the Vault page (D27). If declined: no Vault on Windows and Linux in part 1.

Q2 SCOPE (MAIN): part 1 delivers only through `vault_fetch` to owner-pinned https origins; command-line use (CLI logins, PEM/SSH keys) is part 2. This changes MAIN's r2 ruling (env or pipe into the tool process). Recommendation: yes (Murage has no per-command containment; r3 11.1 is the part-2 contract).

Q3 SCOPE GATE (MAIN): MCP pointer materialization (#5145) stays off in part 1. Recommendation: yes.

Q7 SCOPE CUT (MAIN, new in r4): V1 ships without chat-only holds (V2), 1Password (V3) and My Cloud (V5); the shared credential writer fix (V4) becomes its own item with MAIN as owner until seated. All stay in the 1.0.21 train as separate design rounds. Recommendation: yes; these were the parts that kept reopening Astra findings across three rounds.

Q4 (carried): no plain-text opt-in Vault on headless or `basic_text` Linux. Recommendation: yes.
