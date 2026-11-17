# Synthetic containment inventory

Outer boundary: `it-remote.sh`, Node 24, UID 2001, `--network none`, 6 CPUs and
14 GiB, at most two job containers. Inner preload is opt-in (`NOLIM_TEST_CONTAINMENT=1`): its ACP production
smoke and six refusal mutants pass. The seven-driver key-read guard matrix was
also attempted: ACP passed, six drivers failed (three caught tripwires, two
missing acknowledgements, and OpenAI incomplete). The full matrix remains OPEN.
A unit tripwire result is not full-run containment certification.

Allowed execution is restricted to the fixed fake provider scripts, inert MCP
script and memory worker under the extracted product root. The only additional
probes are `/usr/bin/which docker|podman` (`container-computer.ts`),
`ssh -V`, `git config --get core.sshCommand` in the fixture home
(`engine-env.ts`), and the exact fixed `/bin/sh -c` environment check from
`engine-env.ts`, again in the fixture home. Arbitrary shell execution, `exec`,
TLS and unregistered sockets fail and leave a ledger entry even when caught.
The login-shell capture is disabled with the existing `VITEST` seam, so the
fixture never loads an account's startup files.

The fixed local-model discovery targets from `shared/local-models.ts` and
`drivers/local-inject.ts` return a rejected promise without opening a socket;
these are counted as refused probes, not allowed endpoints. All other fetches
must target registered fixture listeners. The current low-level socket guard
registers ports, not HTTP paths; full endpoint-path and descendant coverage
remain open until adversarial integration tests cover them. This limitation
must not be described as a completed registered-endpoint proof.

Every other attempted process or connection is a tripwire. No Docker socket,
user home, real database, credentials or paid provider is mounted by this job.
The fake tools return scripted data and never execute corpus commands.

The failed guard matrix is retained as `guard-seven.log` in the private BLD3
evidence directory. The successful two-pin transport measurements ran without
this opt-in guard; they prove adapter behavior, not this containment contract.
