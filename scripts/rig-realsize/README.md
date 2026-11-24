# Real-size busy-profile rig (release gate)

Owners: this folder = the rig-realsize lane. Running it before a publish (Linux container and macOS canary) = the release owner.

The 1.0.21 canaries all ran small, fresh profiles on idle machines. The field failures need everything at once: a 10 GB
profile, 38 bots with tracked notebooks re-imported every minute, long No limits turns calling owner MCP servers,
delegations in flight, a loaded machine. This rig builds that on the real server with the repository's fake Claude engine
(no keys, no network) and fails the gate on any of the owner-visible symptoms.

    scripts/rig-realsize/run.sh <evidence-root>              # any checkout with node_modules (macOS canary)
    RIG_NODE_MODULES=<dir> scripts/rig-realsize/run.sh <evidence-root> container   # Linux, --network none node container

Exit 0 GREEN, 1 RED, 2 INVALID (the pressure was not created, the load ended early) or rig failure. Needs about 25 GB free
disk and 60-75 minutes at the defaults.

Evidence lifecycle: every run writes only into <evidence-root>/<RIG_RUN_ID> (run.sh prints the id; a new one when unset).
That dir must not exist when the run starts: an id that was used before is refused (exit 2), never written into. The run's
evidence there: verdict.json, rig.log, server.log, server-*.log, messages.jsonl, completion-input.json, validity-input.json,
turn-ends.jsonl, and, written last and only when the run reached a verdict, run-complete.json (the run id, the live verdict,
size + sha256 of every evidence file). Replay one run: node scripts/rig-realsize/verdict.mjs <evidence-root> <run id>.
It reads only that run's dir and refuses (INVALID, exit 2) a run with no run-complete.json (it failed or is still running),
a seal naming another run, or a file changed after the seal; a run sealed RED or INVALID can not replay GREEN.

The replay and the live run call one function (verdict.mjs verdictOfEvidence) on the same evidence files, so they give the
same verdict and exit code: an INVALID run replays INVALID (exit 2), never GREEN. The replay needs server.log,
messages.jsonl, completion-input.json and validity-input.json; with one missing, or a fact not recorded, it says INVALID
(a RED found in what is there stays RED). Evidence from before validity-input.json existed therefore replays RED or INVALID.

RED on any of: MEMORY_CONTEXT_REVOKED, a ledger refusal, a swallowed error at response.emit, "context revoked during
dispatch", a dispatch that could not set up its turn, "retained fence refused", "I stopped this turn because some of its
context is no longer available", a reply "still being checked against earlier memory", an owner mount lost.

RED also when a turn did not really finish (completion.mjs, judged per turn id, never per thread):
- a sent turn whose OWN turn id has no delivered final reply carrying the owner tool's answer (another turn finishing on
  the same conversation, such as a later wave or the wake-up after a delegated reply, does not count);
- an accepted delegation whose delegated turn did not finish the same way, or whose answer did not reach the asker
  (the API accepting the delegation proves nothing); a refused delegation or send;
- any turn of the drive that ends other than completed ok, or that started and has not ended when the run is judged
  (the rig first waits until no bot is busy and every started turn has ended, twice in a row).

The CPU/IO load (load.sh) runs in its own process group and stops when the rig closes the pipe it holds or dies. The rig
keeps no pid file and signals no pid, so it cannot stop a process it did not start in this run.

Knobs (environment): RIG_BOTS 38, RIG_TEAMS 7, RIG_DB_GB 10, RIG_TOPICS 8, RIG_NOTEBOOK_KB 240, RIG_STEPS 120,
RIG_STEP_MS 2500, RIG_CONCURRENT 8, RIG_DELEGATIONS 2, RIG_DRIVE_MIN 30, RIG_LOCK_HOLD_MS 2600, RIG_LOCK_EVERY_MS 60000,
RIG_ROUTINE_MS 60000, RIG_LOAD_CPU 8, RIG_LOAD_IO 2, RIG_MCP_MS 300, RIG_IMPORT_WAIT_MIN 2, RIG_KEEP_PROFILE 0.
One fake step is one tools/list plus one tools/call on an owner MCP server through Murage's mount relay, so 120 fake steps
are about the release count of a 50-step real Claude turn.
