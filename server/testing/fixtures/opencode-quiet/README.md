# Captured OpenCode stderr ownership fixture

Captured 2026-11-06 on Linux x64 using public npm `opencode-ai@1.19.5`.
Binary SHA-256: `7df4e4136301f16589b0f30bf91a61380fca5f8ef22dd36570f5ebe1d4ec802c`.

Exact argv (also used in production): `acp --print-logs`.
Working directory: `/home/user/scratch/opencode/work`. All config/data/cache/state/home directories belonged to
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

This establishes the 1.19.0, 1.19.5 and 1.19.6 grammar, not compatibility with every OpenCode release.
Unknown log formats produce no diagnostic; the existing failure handling and
silence deadlines continue unchanged. The parser's fake-timer tests and the fake ACP
process test establish the 60-second delivery behavior independently of this
short capture, whose fake provider stops after OpenCode's own bounded retries; the long-retry captures below
show the real engine staying unanswered past 60 s.

## 1.0.23 captures (OPENCODE-QUIET-1023 build delta 1)

Captured 2026-11-22 on Linux x64, offline (own network namespace with loopback only), working directory
`/home/user/scratch/opencode/work`, same isolated environment and loopback provider as above. The download was the only
network step and ran before any capture.

| version | source | binary SHA-256 | short capture | long-retry capture |
|---|---|---|---|---|
| 1.19.0 | npm `opencode-linux-x64-baseline@1.19.0` tarball (the Cloud image pin), tarball SHA-256 `6bdf946045ebfa5773811d0037c1ca8c8a3831880434289b9e4a40c2f1fe8432` = `build-image.sh` `opencode_sha256_by_arch[x86_64]`; `package/bin/opencode` placed at `<root>/node_modules/.bin/opencode` | `135ac3f86c43f2a22328a3554fec5f0bc57d71576077902661bc38dac34871fd` | `1.19.0.stderr.log`, `1.19.0.stdout.jsonl` | `1.19.0.long.*` |
| 1.19.5 | `npm install --prefix <root> opencode-ai@1.19.5` | `7df4e4136301f16589b0f30bf91a61380fca5f8ef22dd36570f5ebe1d4ec802c` | (above) | `1.19.5.long.*` |
| 1.19.6 | `npm install --prefix <root> opencode-ai@1.19.6` (`npm view opencode-ai version` = 1.19.6 at build time: the version the desktop install hint resolves to) | `aab0a58cd7fc5a1f17495b76c08e79989d331653d8b63156aca2f6e9e36d1173` | `1.19.6.stderr.log`, `1.19.6.stdout.jsonl` | `1.19.6.long.*` |

Arguments: short `node capture.mjs /home/user/scratch/opencode`; long `node capture.mjs /home/user/scratch/opencode --long`.
The `stream error` record grammar of 1.19.0 and 1.19.6 is identical to 1.19.5 (same 11 fields, same order), so the parser
is unchanged. A record shape without `session.id`, `small` and `agent` is not accepted.

Long-retry mode (`--long`): one session, one prompt, 150 s kill timer. The provider answers the first main-model request
with 429 `retry-after: 1` (one owned `stream error`), answers title requests (title-generator system text in the request
body) with 429 at once, and holds every later main request open for 75 s before a normal one-chunk OpenAI-compatible
stream. `<v>.long.timeline.json` lists each request's class and time, every ACP notification and the prompt answer, in ms
from the start of the script:

| version | prompt sent | owned stream error | held main request | release | prompt answered | updates during hold |
|---|---|---|---|---|---|---|
| 1.19.0 | 1817 | 2352 | 3372 | 78408 | 78498 `end_turn` | none |
| 1.19.5 | 1419 | 1778 | 2784 | 77819 | 77880 `end_turn` | none |
| 1.19.6 | 1566 | 1940 | 2946 | 77981 | 78042 `end_turn` | none |

Each version: exactly one owned (`small=false`) `stream error` before 60 s, `session/prompt` unanswered at 65 s, then a
normal result. Title errors (`small=true`) also appear and are not owned.
