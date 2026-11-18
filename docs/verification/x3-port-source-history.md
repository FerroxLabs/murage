# X3 port source history

Ordered source ancestry (`git log --reverse --topo-order 40b87b6ef..ea51035cd`): 89 commits, including the 22 L7 commits excluded by the source merge. These are provenance, not commits cherry-picked onto 1.0.19. The final file delta and dispositions in [the port contract](x3-port-1019.md) determine what is ported. Historical documentation/results are excluded; mixed commits contribute only surviving X3 hunks.

| Commit | Allocation | Subject |
|---|---|---|
| `71a2c6e03ca3` | L7 — excluded | test: ACP model and thinking session controls |
| `dfb22e67be47` | L7 — excluded | feat(1.0.18 base): parse ACP models and native thinking choices (upstream 923be2380) |
| `e573415f4994` | L7 — excluded | test: per-bot custom ACP model and thinking selection |
| `95ab9f074ca3` | L7 — excluded | feat(1.0.18 C27): choose custom ACP models and thinking per bot (upstream 923be2380) |
| `3d75aa94c2fa` | L7 — excluded | test: custom ACP documentation and verification contract |
| `c1ed48fb389f` | L7 — excluded | feat(1.0.18 C28): document custom ACP choices and isolated verification (upstream 800d9b889, 5198d26df) |
| `2f1999a053cb` | L7 — excluded | test: Copilot live models, premium multipliers, Auto and explicit sign-in probe |
| `4afc124dc049` | L7 — excluded | feat(1.0.18 F9b): discover Copilot models, costs and thinking (upstream af59c2ec4, a55540c3f) |
| `66205fab23c2` | L7 — excluded | test: Copilot scoped launcher configuration and credential refresh |
| `54f3cc0caecb` | L7 — excluded | feat(1.0.18 ACP tools): configure Copilot scoped launcher tools (upstream 16071c32b, fd4a01929) |
| `6031cadcb93e` | L7 — excluded | test(acp): expose Copilot turn errors and record mount review |
| `a61c1568c404` | L7 — excluded | test(acp): the Copilot launcher fixture answers its turn: the driver reports a turn with no reply as an error, which is what the contract test was hitting |
| `9fa8a35d30c8` | L7 — excluded | docs(copilot): a1f772737 is a checked SKIP, read from the upstream clone: it changes only argvPaths in the bot box, which this tree does not have |
| `1b46d164dc90` | L7 — excluded | Protect Copilot launch credential paths at approval boundaries |
| `7e3725b3119b` | L7 — excluded | Bound ACP choices consistently before publication and cache reuse |
| `fe37d8eb9520` | L7 — excluded | Bind loaded ACP sessions before dispatching subsequent frames |
| `308968913b4f` | L7 — excluded | Release Copilot credential files on child teardown and reclaim dead owners |
| `826cd6190479` | L7 — excluded | Reset resumed thinking to native defaults or reopen the session |
| `8f4f0de2901f` | L7 — excluded | Test Copilot resume launch contract and scoped MCP fingerprint separately |
| `32c776d7bf17` | X3 source / integration; see file manifest | Inventory every production file writer by credential class |
| `0c0c318f741d` | X3 source / integration; see file manifest | Ask before command globs reach temporary engine credentials |
| `7fbc47d6d7ae` | X3 source / integration; see file manifest | Recognize engine credential files and owner configuration paths |
| `765a33f3eb65` | X3 source / integration; see file manifest | Ask before reading named credential stores in the data folder |
| `95b4da723a68` | X3 source / integration; see file manifest | Correct the credential inventory and add a read-only verdict replay |
| `5c7a8c9cbb2d` | X3 source / integration; see file manifest | Document backup credential roots and check planted SSH files |
| `5cf968951135` | L7 — excluded | Reclaim orphaned Copilot files on Windows without Unix owner checks |
| `1bded9066d46` | L7 — excluded | Bind fallback conversation ownership before the next ACP frame |
| `d859afec640d` | L7 — excluded | Check fallback session commands before the first prompt |
| `7a2219a73e0b` | X3 source / integration; see file manifest | Follow credential files in relocated runtime folders |
| `f4fed5c74cd6` | X3 source / integration; see file manifest | Cover browser connection files and temporary credentials |
| `db28cd01290d` | X3 source / integration; see file manifest | Check credential inventory examples against the file guard |
| `d0f3cc78a105` | X3 source / integration; see file manifest | Check real connection writer destinations against the inventory |
| `82dec06e7dee` | X3 source / integration; see file manifest | Record native directory glob matcher blocker |
| `5eaf845a9a68` | X3 source / integration; see file manifest | Cover credential inventory destinations 1 through 25 |
| `a82567df89e7` | X3 source / integration; see file manifest | Cover credential inventory destinations 26 through 50 |
| `b81847d4dc79` | X3 source / integration; see file manifest | Cover credential inventory destinations 51 through 75 |
| `916700244111` | X3 source / integration; see file manifest | Cover credential inventory destinations 76 through 100 |
| `38e5af99924a` | X3 source / integration; see file manifest | Cover credential inventory destinations 101 through 125 |
| `c4901b5cd080` | X3 source / integration; see file manifest | Enforce whole credential table and finish destination columns |
| `9341b2246bbf` | X3 source / integration; see file manifest | Add real credential store writer fixtures and filesystem observation |
| `89deb96cd9e0` | X3 source / integration; see file manifest | Add engine writer fixtures and enforce all 70 writer dispositions |
| `30f43bcc3760` | X3 source / integration; see file manifest | Tighten writer destination checks and document branch dispositions |
| `a729397989de` | X3 source / integration; see file manifest | Record complete coverage dispositions and final static verification |
| `5ff8d537adc9` | X3 source / integration; see file manifest | Fix credential directory globs and owner atomic filenames |
| `e71a1b617f0d` | X3 source / integration; see file manifest | Document owner glob matcher method fault |
| `869facc9f4bc` | X3 source / integration; see file manifest | Record stopped BUILD-FIX 16 implementation and follow-ups |
| `95d9596c1fe4` | X3 source / integration; see file manifest | Require file children for sensitive directory globs |
| `5d33af847910` | X3 source / integration; see file manifest | Read globs as files: wildcard-only tails and leading name wildcards (BUILD-FIX 16c) |
| `d64de39a0d3b` | X3 source / integration; see file manifest | Restore X3 glob split shapes baseline |
| `1003c5799972` | X3 source / integration; see file manifest | Add directory reads and known cwd glob candidates |
| `dda77e93b793` | X3 source / integration; see file manifest | Classify Flux connector receipts as data coverage |
| `7e096c8944b9` | X3 source / integration; see file manifest | Adapt X3 shapes and placement tests to option B |
| `d7fcdb884e02` | X3 source / integration; see file manifest | Sync Pi canonical path anchor handling |
| `fed187be70e8` | X3 source / integration; see file manifest | Pass the cwd fixture filesystem through UnseenOptions |
| `f2be9288c29d` | X3 source / integration; see file manifest | Exercise project cwd shapes through the server judge |
| `bf6c086812f8` | X3 source / integration; see file manifest | Name accepted ordinary extension intersections explicitly |
| `b4e1160fc891` | X3 source / integration; see file manifest | Identify the engine in the exact cwd fixture |
| `b10c91a72784` | X3 source / integration; see file manifest | Record option B results and mutation evidence |
| `da75a824359f` | X3 source / integration; see file manifest | Add red persistent shell cwd regressions |
| `2d1c086acbda` | X3 source / integration; see file manifest | Add bounded per-thread shell cwd glob checks |
| `7febdbaa5587` | X3 source / integration; see file manifest | Record persistent shell verification and mutation evidence |
| `926d7c4b20b3` | X3 source / integration; see file manifest | Extend shell folder operands and validate X3 mutation witnesses |
| `19c0aa276e0f` | X3 source / integration; see file manifest | Add literal-core-gated second pass for pinned glob rows |
| `2cfa738b5ad4` | X3 source / integration; see file manifest | X3 credential-writer fixture: the safeStorage stand-in answers isAsyncEncryptionAvailable, which the keyring policy now asks |
| `d014faa79813` | X3 source / integration; see file manifest | X3: two stale wide tests follow the shipped contracts. Copilot prepare() returns a fresh file per call (3aac8a0c6 added the random suffix; the old test still expected one path). The permission gate may NAME .claude.json in its protected list, but the structure test still forbids any other file parsing or reading it. |
| `1541da9c63c6` | X3 source / integration; see file manifest | X3 r4e.1: bounded fail-closed glob verdicts, threshold-1 position automaton, shell session state |
| `fe952b992d3d` | X3 source / integration; see file manifest | X3: an unknown shell scope cards only a glob that follows an unprovable cd; redirects, substitutions and plain loops stay quiet |
| `7724de8efe15` | X3 source / integration; see file manifest | X3 phase 2: one hook point where a shell call's start set is chosen (startSetFor), returning the session record by default |
| `ef322a37b876` | X3 source / integration; see file manifest | X3 phase 2 C: the typed glob outcome the place loop reads (CredentialGlobOutcome, GlobStepBudget, GlobWord) |
| `9e6e2e1a7b8e` | X3 source / integration; see file manifest | X3 r5 section 5 with rev 3.2: a bounded shell session record, exit-0 P1 commits, overflow to unknown with one K card, P5 decided before any listing |
| `5006dd2b1f3f` | X3 source / integration; see file manifest | X3 r5 rev 3.2 rows: T-S2, T-S2r, T-SP1/T-SP2 on the floor path, T-S3, T-S3p with the 17-open-request case, T-S3r, T-S3r-rel and its S2 twin, T-S3rel, and T-SCALE with MS-CAP-PLACES, MS-CAP-PENDING and MS-IO. These count realpath and opendir as work units. |
| `f0a6af472db4` | X3 source / integration; see file manifest | X3 S-a/S-b: places only grow by union, and unknown clears only by installing an absolute cwd through a committed P1 chain |
| `5f94e4fcf178` | X3 source / integration; see file manifest | X3 phase 2 C: r5 sections 1-4 witness judge |
| `d0c00015d6dd` | X3 source / integration; see file manifest | X3 phase 2 C: witness test rows typecheck |
| `3f2068790786` | X3 source / integration; see file manifest | X3 r5 G1: the place loop reads glob words only from the shell lexer (shellGlobWords), with wrapped payloads, and placedGlobs leaves the decision path |
| `2832495c5dbe` | X3 source / integration; see file manifest | X3 phase 2: the reason-log home-glob case uses a tail no key row names |
| `3e6f3ee50cf1` | X3 source / integration; see file manifest | X3 phase 2: the shell-snapshots key row, in GATE_PATH_IDS |
| `217d39f4200f` | X3 source / integration; see file manifest | X3 phase 2: proof selection behind startSetFor, P-SPAWN, additive proven publish |
| `8ecc72f340c8` | X3 source / integration; see file manifest | X3 P-SPAWN (A:22): Codex records the folder it hands to spawn and thread/start, and returns it as spawnCwd, so a call without params.cwd starts from that folder instead of unknown |
| `6fcbc26691cc` | X3 source / integration; see file manifest | X3 P-SPAWN: the launch no longer takes a folder; the spawn folder arrives only through accept(), and the record and session fixtures hand it there |
| `105ff2da6475` | X3 source / integration; see file manifest | X3 combine: merge B x3-p2b 6fcbc2669 (proof selection, P-SPAWN, Codex spawnCwd) onto A+C |
| `441f91772061` | X3 source / integration; see file manifest | X3 dot rule (owner ruling 8 Nov): a proven Claude Code call matches leading dots with or without GLOBIGNORE |
| `fee317948e28` | X3 source / integration; see file manifest | X3 r5 F4 row (r5:161): ls * in {~/.aws} listing [config] is QUIET; kills M1 (restore AA:1698), which survived all 11 files |
| `fb5d6a1429da` | X3 source / integration; see file manifest | X3: merge the combined glob judge and credential coverage (x3-combined fee317948) onto 40b87b6ef; ACP/Copilot launcher lineage stays at base |
| `b2377c7b422b` | X3 source / integration; see file manifest | x3r4-simple WIP of aaed8a20 (uncommitted at 17:44Z), snapshotted at takeover 19:25Z |
| `9e76d78cd184` | X3 source / integration; see file manifest | x3r4: warm key sees the exec nonce as one placeholder; claude-shell-sites; wrapper tests. Stanza expectations carry MURAGE_EXEC_KEEP=mcp:<nonce>:<names> only where murage-exec.ts withExecKeep (the doc comment at line 211, EVERY stanza with a string command) adds it on purpose; the nonce comes from the CLI env dump (fixture-dump lists MURAGE_EXEC_NONCE). murage-exec-mcp env shim now named in a wrapper copy beside the wrapper (PATH is pinned to /usr/bin:/bin at murage-exec line 49). |
| `900ecc22fccc` | X3 source / integration; see file manifest | X3 wrapper: merge x3r4-take 9e76d78cd (exec nonce, claude-shell-sites, wrapper tests) |
| `07554a2b4d34` | X3 source / integration; see file manifest | X3 rulings H1-H4, M5 on Astra r1: a cd installs only when the tokenizer proves it (comments, negation, //, groups, loops, one literal operand); publishes carry a per-record sequence and a stale one is dropped; the deadline never skips a place silently; invalidating a prepared floor judgement re-judges it on unknown; always-ask restored to base; base fixtures carry outsideRead null; drop the non-X3 ACP variant remnants and the Copilot tests; the .murage-root.json record classes follow base data-dir-inventory |
| `ea51035cddaf` | X3 source / integration; see file manifest | X3: the final .murage-root.json gets a coverage row per root with base classification record (data-dir-inventory.ts:60); the harness skips only the .tmp leftover (base excluded, :346) |
