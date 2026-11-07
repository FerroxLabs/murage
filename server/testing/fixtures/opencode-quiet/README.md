# Captured OpenCode stderr ownership fixture

Captured 2026-11-06 on Linux x64 using public npm `opencode-ai@1.19.5`.
Binary SHA-256: `7df4e4136301f16589b0f30bf91a61380fca5f8ef22dd36570f5ebe1d4ec802c`.

Exact argv (also used in production): `acp --print-logs`.
Working directory: `/root/swarm1018/ENGINES-REST-1018/scratch/opencode/work`. All config/data/cache/state/home directories belonged to
the isolated scratch installation. The environment contained no real provider keys.
The sole configured provider was a loopback HTTP fixture returning JSON HTTP 429.
No sign-in, account creation, or real model request was used.

`capture.mjs` is the actual capture driver, adjusted only to accept the installation
directory as an argument. It initializes ACP, creates and prompts session A, loads A,
creates B, and submits prompts to A and B concurrently. It captures both streams.
The committed stdout is exclusively ACP JSON-RPC; stderr includes startup messages,
main request errors and title errors. The unedited captures retain the original
session IDs and timestamps. Requests include only synthetic fixture text.

Reproduction (after installing the public release in a fresh scratch directory):
create `home` and `work` in that directory, then run
`node server/testing/fixtures/opencode-quiet/capture.mjs /absolute/scratch/opencode`.
The script supplies the isolated environment and the loopback fake provider itself.

Evidence: `stream error` records carry exact `session.id`, `small`, `agent`, and
`mode` fields. A loaded session keeps its ID; overlapping sessions have distinct IDs.
Title errors carry `small=true agent=title`; primary model errors carry
`small=false agent=build mode=primary`. The observer consumes only the latter shape
for the active ACP session. It does not infer ownership from timestamps or log order.
Murage starts one fresh OpenCode process per turn, so old session errors are not
replayed through a reused process's stderr. No shared filesystem log is read.

This establishes the 1.19.5 grammar, not compatibility with every OpenCode release.
Unknown log formats produce no diagnostic; the existing failure handling and
silence deadlines continue unchanged. The parser's fake-timer tests and the fake ACP
process test establish the 60-second delivery behavior independently of this
capture, whose fake provider stops after OpenCode's own bounded retries.
