# X3 English strings

This inventory records the English copy introduced by X3. Existing sensitive-path
row descriptions are supplied by the existing path-rule inventory. Substituted
paths, names, shell setup reasons and earlier cd descriptions are runtime values.
The November 12 ruling allows only the wipe check to card at No limits; X3 card
and proof-refusal copy applies to protected modes.

| Source / identifier | English copy and trigger |
| --- | --- |
| `server/auto-approve.ts`, `K_CARD_RULE` | this session has used more than 32 folders, so Murage now checks every file pattern in it — first relative pattern after the place cap. |
| `server/auto-approve.ts`, `P5_CARD_PREFIX` | the folder this command runs in is not known — followed by the earlier unresolved directory effect in parentheses. |
| `server/auto-approve.ts`, `GLOB_BUDGET_WORDS` | file patterns could not be checked in time — matching budget or incomplete pattern-bearing word/brace alternatives. |
| `server/auto-approve.ts`, `SHELL_DEADLINE_CARD_RULE` | the file-pattern check ran out of time before every possible folder was looked at — the shared deadline expired before a place could be checked. |
| `server/auto-approve.ts`, word cap | too many file patterns to check — more than 128 words. |
| `server/drivers/murage-exec`, missing conversion helper | murage-exec: cygpath is not available |
| `server/drivers/murage-exec`, missing map | murage-exec: the turn environment is not available |
| `server/drivers/murage-exec`, private-map validation | murage-exec: the turn environment is not Murage's |
| `server/drivers/murage-exec`, malformed map | murage-exec: the turn environment could not be read |
| `server/drivers/murage-exec`, missing required map fields | murage-exec: the turn environment is incomplete |
| `server/drivers/murage-exec`, proven shape refusal | Murage could not confirm the folder this command starts in, so it did not run it; the next try is checked the slow way See the wrapper source for the complete diagnostic prefix/suffix. |
| `server/index.ts`, shell folder lookup failure | shell folder lookup could not finish |
| `server/drivers/claude.ts`, managed settings proof conflict | Claude's turn was not started: the managed settings file {path} sets {names} in its "env" block, which would change how Murage runs every command. Remove {that name/those names} from that file's "env" block and send the message again. Reserved names begin with `MURAGE_EXEC_`. |

Wrapper refusals also emit fixed reason tokens and a value-free shape checksum.
The engine records `unreadable`, shape and proof-floor diagnostics without
logging environment values. Those tokens are diagnostic data, not translated
card copy. The managed settings refusal names only conflicting variables.

Dispatch diagnostics read at most 64 KiB of the recent mismatch log and inspect
at most 64 snapshot directory entries. `keep-mismatch-recent` is a bounded
suffix count; a larger snapshot folder or file yields no PATH diagnostic.
These counters never change a permission result.
