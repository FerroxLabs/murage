# Full access Windows 108 packaged check

Run this on the packaged Windows fixture under the isolation rules in [README.md](README.md). Use a temporary home and data directory with fake engines. No live account or installation participates.

1. Start the package and leave it idle. No environment probe should start until a command asks.
2. Start a harmless command through each fake Codex, Fuigo and Grok fixture. Capture the command-environment launch metadata without recording environment values or probe output. The allowed exception is the pinned `powershell.exe` or `pwsh.exe` form with `-NoProfile`, one fixed nonce-tagged JSON probe after `-Command`, closed stdin and `windowsHide: true`. Arbitrary app-launched scripts remain a failure. Claude's inherited-environment path remains separate.
3. Measure cold and warm elapsed times for both Windows PowerShell 5.1 and pinned PowerShell 7 in a folder containing spaces and Unicode. Record the OS, shell version, sample count and latency distribution. These measurements remain required release evidence.
4. Confirm a controlled three-second response completes. Timeout and output overflow must invoke the full System32 taskkill path for the exact PID with `/T /F`. Cleanup gets at most one second and the callback settles once. Missing, failing and overlong cleanup helpers must leave the command asking. A later eligible command retries after its cooldown; another origin gets its own check.
5. At Full access and No limits, an owner's literal `bash -c 'printf marker108'` can proceed after checking its entire payload. Start-Process, Python code, WSL and generated or on-disk PowerShell scripts still ask. Never execute guarded commands to verify their cards.
6. With an existing Full access bot default and lower-level open conversations, open Permissions. Confirm **Apply to my open conversations** appears, the review names the count and level, skipped conversations are counted, and **Follows the bot default** describes rooms. Cancel changes nothing. Apply raises only eligible owner conversations. Higher levels and remembered grants remain as they were.
7. Queue an owner project routine, stop the fixture before dispatch, and reopen the same fixture data. Its next normal dispatch keeps the recorded ceiling, capped by current routine and bot levels. Restoring a copied archive removes delivery authority and leaves that restored request with the unattended judge.

Capability copy: Murage can check the Windows command environment before applying this conversation's approval level. Full access can run supported Windows launchers for commands you start. Murage still asks when it cannot read the launched command.

This checklist is an acceptance procedure, not execution evidence. Record the fixture launch, observations and results when the gate runs.
