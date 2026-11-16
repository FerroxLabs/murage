Apply each patch independently, run in the 7C container, record its failing
output, then reverse it before applying another. No mutant is active here.
No runtime, compiler, test runner or real CLI was executed by this builder.

LS-A3fS2-mutant-M-ALLOWLIST-OPEN.patch
  server/drivers/claude-s2-input.test.ts:
  T-S2-STEER-MID-BARRIER, T-S2-ELICIT-MID-BARRIER, T-S2-ALLOWLIST must fail.

LS-A3fS2-mutant-M-TURN-STARTED-EARLY.patch
  server/drivers/claude-s2-production.test.ts:
  T-S2-STEER-MID-BARRIER runtime (success and cold fallback) and
  T-S2-ELICIT-MID-BARRIER runtime must fail their no-live/no-start assertion.
  server/drivers/claude-s2-start-order.test.ts:
  T-S2-START-ORDER-STATIC must also fail.

LS-A3fS2-mutant-M-SPLIT-RETIRES-S1.patch
  server/drivers/claude-s2-s1-parity.test.ts:
  T-S2-S1-PARITY must fail for Claude unsupported and Codex.

The parity harness executes the same spies against the current relay and
the exact 7c64d71f4 source fixture. Fixture SHA-256:
c001e4cb9b4a3c4c44127b35e7245a2a5a593da5fa244eefe53f15a1c228d6ab
The checked-in expected event sequence must first match that executable
baseline, then the current relay. Runtime capture/confirmation is pending 7C.
The baseline kills CLI before combined confirmation and retains its ticket
string; the addendum's prose order is not the baseline's executable order.

Real production qualification: MURAGE_REAL_CLAUDE_S2=1,
server/drivers/claude-s2-no-cross-production.test.ts, plus the pass-2 real
tests. T-S2-NO-CROSS-PRODUCTION never drives retirement: only production
result settlement cuts N. It delays a native answer below the writer until
after N+1's production barrier. A real-CLI failure means S2 is not viable.
