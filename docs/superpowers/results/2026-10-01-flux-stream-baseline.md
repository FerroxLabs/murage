# Flux stream live baseline and tuning sweep (Task 14)

Date 2026-10-01 to 2026-10-02. Simulator (`tools/flux-stream-sim`, `--provider assemblyai`) against the live AssemblyAI `universal-3-6-pro`, driven by the conformance suite from Sean's Mac. Reports are the JSON files beside this one (counts and timings only, no transcript text). All numbers are ms; "p50/p90" with n = 5 plain fixtures (latency) or the pause fixtures f02 to f06 (splits). n = 5 makes p90 the slowest sample, so treat p90 differences under about 100 ms as noise (the two medium commit-off runs differ by 12 ms).

## Result

Murage ships **medium, explicit 400/1280, punctuation commit OFF** (`StreamMic.query()` unchanged: `eagerness=medium`; `STREAM_COMMIT=false`). It is the only config tested with zero thinking-pause splits at the owner level and zero audible restarts that is also fast (T-eot-murage p90 about 1.73 s against 2.9 s and 3.9 s for the slower presets). No change to the contract module. Owner-voice run: **not run** (`$MURAGE_OWNER_RECORDING` not set).

## 1. Acceptance run, default config (medium, commit on)

`baseline-medium.json`, `--mode acceptance --target murage`. 45 of 49 checks pass, 3 fail, A06 excluded by design, L10 (start cap) passes.

| Gate | Value | Limit | |
|---|---|---|---|
| T-text-p50 | 866 | 800 | FAIL |
| T-text-p90 | 966 | 1000 | pass |
| T-eot-p50 | 866 | 900 | pass |
| T-eot-p90 | 1725 | 2000 | pass |
| T-eot-murage-p90 (commit on) | 1251 | 1300 | pass |
| T-superseded (commit on, total over 5) | 3 | 2 | FAIL |
| T-audible-restarts | 0 | 0 | pass |

Failed checks, all against the live provider and none touched by this task: T01-T03 (f09-backchannel, WER 1.00: WER 1.00 on a one-word fixture, cause not investigated), L03 (close 1000 after 2013 ms) and L05 (close 1000 at 92235 ms). T-text-p50 misses by 66 ms, T-superseded by one: both are the live provider, not the simulator. Spike expectation (text p50 about 0.7 s, eot p90 about 1.75 s without the commit) holds for eot (1725) and is about 150 ms slower for text.

## 2. Sweep (dev mode, `--only E-latency,E-murage --profile`)

E-murage runs the same commit policy over plain and pause fixtures in the same sessions. "Owner turns" = every pause fixture f02 to f06 produced exactly one owner turn (the check asserts it); every run below passed that, so no run split a pause at the owner level. Superseded = provider-level splits that the call layer joined (total over 5 fixtures; the gate limit is 2).

| Config | Commit | text p50/p90 | eot p50/p90 | T-eot-murage p50/p90 | superseded p50/p90 (gate total) | audible restarts | owner turns f02-f06 |
|---|---|---|---|---|---|---|---|
| medium 400/1280 | on | 878/962 | 878/1719 | 866/1179 | 0/2 (3) | 0 | 1 each |
| medium 400/1280 | off | 840/883 | 841/1692 | 861/1727 | 0/1 (ok) | 0 | 1 each |
| medium 400/1280 (rerun) | off | 840/947 | 841/1732 | 867/1739 | 0/1 (ok) | 0 | 1 each |
| low 1500/3000 | on | 1972/2054 | 2041/3905 | 2039/2280 | 0/2 (3) | 0 | 1 each |
| low 1500/3000 | off | 1975/2057 | 2044/3900 | 2047/3892 | 0/0 | 0 | 1 each |
| 1000/2500 | on | 1468/1561 | 1532/2942 | 1480/1765 | 1/2 (4) | 0 | 1 each |
| 1000/2500 | off | 1485/1529 | 1485/2944 | 1440/2943 | 0/0 | 0 | 1 each |

Commit on against off (medium): T-eot-murage p90 1727 to 1179 (about 550 ms faster), at the cost of 3 superseded sends over the pause fixtures against 0 to 1, and still 0 audible restarts. Ruling R4 ships it off regardless; the numbers are recorded for the record only.

## 3. R9: explicit 400/1280 against provider defaults (pause fixtures)

Provider-default means the new sim flag `--provider-default-turns` (off by default), which sends no `min_turn_silence` or `max_turn_silence`; the contract module is untouched and unit-tested (`providerParams(config, true)`).

| Config | Commit | text p50/p90 | T-eot-murage p50/p90 | superseded p50/p90 (gate total) | audible restarts | owner turns f02-f06 |
|---|---|---|---|---|---|---|
| explicit medium 400/1280 | off | 840/883 | 861/1727 | 0/1 (ok) | 0 | 1 each |
| provider defaults | off | 625/792 | 640/1739 | 1/2 (4) | 0 | 1 each |
| provider defaults | on | 623/1182 | not measured: E-murage hit its 360 s ceiling after the plain fixtures | n/a | n/a | n/a |

The provider defaults are about 215 ms faster at p50 but split the pauses more at the provider level (superseded total 4 against under 2), with the same p90 end of turn. The call layer absorbed every split in both. The provider-default commit-on run did not finish (single timeout, not repeated); it adds nothing to the decision.

Pause fixture gaps (fixtures manifest): f02 1220, f03 970 and 960, f04 1300, f05 1100, f06 1000 ms.

## 4. Does 1280 split thinking pauses?

At the owner level, no: every run kept every pause fixture to one owner turn with 0 audible restarts. At the provider level, a gap near or above 1280 ms (f04 is 1300) can end a provider turn; those are the 0 to 2 superseded sends, joined by the call layer's hold. A pause above the hold's own window would be a real split; the fixtures stop at 1300.

## Preset proposal for the coordinator

No contract change is needed or proposed. If the coordinator wants fewer provider-level splits on pauses over 1.25 s at the cost of speed, the measured trade is: low 1500/3000 (eot p90 3.9 s) and 1000/2500 (eot p90 2.9 s) both remove superseded sends with commit off (0/0) but add 1.2 to 2.2 s to every turn. Evidence does not justify it: 400/1280 already gives one owner turn on every pause fixture. Keep medium at 400/1280 and revisit only if Sean's own voice (owner run, still not run) shows thinking pauses above 1.3 s.

## Disagrees with the spike or plan

- T-text-p50 866 (limit 800) and T-superseded 3 (limit 2, commit on) fail on the live provider. Commit off, which ships, passes T-superseded.
- With the commit off, T-eot-murage p90 is 1.73 s, above the plan's 1.3 s commit-on target; the plan's expected 1.0 to 1.3 s needs the commit.
- 1500 ms minimum silence stops provider splits but makes every turn about 2.0 s here (spike: 1.76 s), confirming the spike's cost finding.

## Test notes

`conformance.test.ts` "passes every contract check on the simulator" fails here on P04 (coalescing) and B02 (slow consumer, no close within 15 s); it fails identically on clean HEAD 079bbc94 in a detached worktree, so it is machine-dependent and not from this change. Everything else in `src/lib/stream*`, `src/lib/call*` and the sim and conformance tests passes (the sim timing tests pass when run on their own).
