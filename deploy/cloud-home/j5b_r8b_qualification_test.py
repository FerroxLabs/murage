"""Execute the deployed D10 function against a clock and command fixture."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

RIG = Path(os.environ.get('J5B_RIG_UNDER_TEST', str(Path(__file__).parent / 'qualify/home-events-deployed.sh')))


class D10Cadence(unittest.TestCase):
    def exercise(self, arrival=60, never_page=False, never_recover=False):
        source = RIG.read_text()
        polling = source[source.index('until_ge()'):source.index('receipt_count()')]
        start = source.index('d10_waiting_count()') if 'd10_waiting_count()' in source else source.index('d10()')
        d10 = source[start:source.index('d6()', start)]
        with tempfile.TemporaryDirectory(prefix='j5b-d10-') as root:
            env = dict(os.environ, CALLS=root + '/calls', TICKS=root + '/ticks',
                       ARRIVAL=str(arrival), NEVER_PAGE=str(int(never_page)), NEVER_RECOVER=str(int(never_recover)))
            fixture = r'''
set -euo pipefail
SECONDS=0
RO=0
START_RO=-1
RECOVER_AT=-100
CTL=/fixture/control
HOME_DIR=/fixture/home
hold() { :; }
unhold() { :; }
fresh() { :; }
date() { echo 1800000005000; }
sleep() { SECONDS=$((SECONDS + $1)); printf '%s\n' "$SECONDS" >> "$TICKS"; }
mount() {
  case "$*" in
    *remount,ro*) RO=1; START_RO=$SECONDS ;;
    *remount,rw*) RO=0; RECOVER_AT=$SECONDS ;;
  esac
}
curl() {
  printf '%s\n' "$*" >> "$CALLS"
  case "$*" in
    *'-X POST'*) printf '{}\n' ;;
    *)
      local n=0
      if [ "$RO" = 1 ] || { [ "$NEVER_RECOVER" = 1 ] && [ "$START_RO" -ge 0 ]; } || [ "$SECONDS" -lt "$((RECOVER_AT + 5))" ]; then n=1; fi
      printf '{"opsAlertsWaiting":%s,"homeEvents":{"outboxDegraded":%s,"items":[{"type":"restore.aborted","at":%s}]}}\n' "$n" "$n" "${at:-1800000005000}"
      ;;
  esac
}
cp_sql() {
  local n=0
  if [ "$NEVER_PAGE" = 0 ] && [ "$START_RO" -ge 0 ] && [ "$SECONDS" -ge "$((START_RO + ARRIVAL))" ]; then n=1; fi
  printf '[{"results":[{"n":%s}]}]\n' "$n"
}
'''
            result = subprocess.run(['bash', '-c', fixture + polling + d10 + '\nd10\n'], env=env, capture_output=True, text=True, timeout=25)
            calls = Path(root, 'calls').read_text() if Path(root, 'calls').exists() else ''
            ticks = [int(t) for t in Path(root, 'ticks').read_text().splitlines()] if Path(root, 'ticks').exists() else []
            return result, calls, max(ticks, default=0)

    def test_hold_just_after_heartbeat_delivers_on_next_cadence(self):
        result, calls, elapsed = self.exercise(arrival=60)
        self.assertEqual(result.returncode, 0, 'D10 rejected the normal next heartbeat: ' + result.stderr)
        self.assertGreaterEqual(elapsed, 60)
        posts = [line for line in calls.splitlines() if '-X POST' in line]
        self.assertEqual(len(posts), 2)
        self.assertTrue(all('/rig/abort ' in line and '"job"' in line and '"id"' in line and '"at"' in line for line in posts), 'both aborts must use the real route and job payload')
        absent, _, bounded = self.exercise(never_page=True)
        self.assertNotEqual(absent.returncode, 0, 'a missing owned alert must still reject the deployment')
        self.assertLessEqual(bounded, 180)

    def test_recovery_is_queried_again_until_zero(self):
        result, calls, _ = self.exercise(arrival=0)
        self.assertEqual(result.returncode, 0, 'D10 kept the first recovery value instead of polling: ' + result.stderr)
        self.assertGreater(calls.count('/api/health'), 3)
        stuck, _, bounded = self.exercise(arrival=0, never_recover=True)
        self.assertNotEqual(stuck.returncode, 0, 'a customer warning that stays positive must reject the deployment')
        self.assertLessEqual(bounded, 180)


class BoundsWording(unittest.TestCase):
    def test_h_threshold_uses_strict_retention(self):
        import re
        default = Path(__file__).resolve().parents[2] / 'docs/design/DESIGN-J5b-r8b-delta.md'
        text = Path(os.environ.get('J5B_DESIGN_UNDER_TEST', str(default))).read_text()
        self.assertFalse('window is exceeded only after more than 32 control restarts' in text,
                         '96 + 32 already equals 128; retention needs strictly fewer later keys')
        claim = re.search(r'ceases to prove retention at `H = (\d+)`', text)
        self.assertIsNotNone(claim, 'the threshold must be stated in hold items, not translated to restart count')
        cutoff = next(h for h in range(128) if 96 + h >= 128)
        self.assertEqual(int(claim.group(1)), cutoff)
        self.assertIn('strictly fewer than 128', text)


if __name__ == '__main__':
    unittest.main()
