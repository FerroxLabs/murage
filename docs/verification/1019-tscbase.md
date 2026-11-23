# Server TypeScript baseline verification

Job: `tscbase`, 2026-11-10.

The requested base is `e1f3307dcd8faaade0489a9c08f1f9e6118b64bb`
(`dev/1019-int19h`). The first completed server compilation on that unmodified
base returned exit code **0**, with **no diagnostics**:

```sh
IT_JOB=tscbase \
IT_W=/root/fuigo-builds/swarm-b/tscbase/wt \
IT_ORIG=/root/fuigo-builds/tools/it-local-generic.sh \
/root/fuigo-builds/tools/it-remote.sh \
  'node node_modules/typescript/bin/tsc -p tsconfig.server.json --pretty false'
```

The fresh clone initially lacked dependencies, so an earlier container attempt
stopped with `MODULE_NOT_FOUND` before compilation. Dependencies were copied from
the shared installation with the same lockfile hash before the successful run.
No compiler options, project includes, or exclusions were changed.

The base already contains commit
`1935aa699dc01cf4907de52852f1c18d7cd74d42`, which addresses two relevant contracts:

- The delegation dispatch test supplies `depth: 0` and
  `skillAuthoring: false` when minting a memory capability from its claim.
  A resolved claim alone does not provide these required mint inputs.
- `agentsIntegration` accepts the shared `EmailToolMode` type instead of
  the narrower inline `"send" | "read"` union. This admits the delegated email
  mode passed by the email mount verdict without a cast or a runtime change.

The reported commit `6d4a2dae3` is not present in the cloned hub. Its seven
reported diagnostics were not supplied and cannot be reconstructed from the
clean requested base. Consequently this verification does not claim to have
reproduced or fixed seven errors. No additional source change is justified by
the server compiler result.

Container logs, the repeat compiler result, targeted test results, and the full
gate comparison are recorded by the job in
`/root/fuigo-builds/swarm-b/tscbase/evidence/` and its sibling `DONE` file.
