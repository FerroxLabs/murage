#!/usr/bin/env python3
"""Only a tagged behavioural AssertionError counts as historical RED."""
import json, re, sys
from pathlib import Path
report = json.loads(Path(sys.argv[1]).read_text())
table = json.loads(Path(sys.argv[2]).read_text())
mode = sys.argv[3] if len(sys.argv) > 3 else 'RED'
rows = [(suite['name'].replace('\\', '/'), test) for suite in report['testResults'] for test in suite['assertionResults']]
invalid = False
red_keys = {(x['file'], x['pattern']) for x in table['RED']}
assert not red_keys.intersection((x['file'], x['pattern']) for x in table.get('PRESERVE', [])), 'RED/PRESERVE overlap'
expected_rows = table['RED'] + table.get('PRESERVE', []) if mode == 'GREEN' else table[mode]
for expected in expected_rows:
 tests = [test for file, test in rows if file.endswith(expected['file']) and re.search(expected['pattern'], test['fullName'])]
 ok = bool(tests)
 for test in tests:
  messages = test.get('failureMessages', [])
  if mode == 'RED':
   first = messages[0] if messages else ''
   valid = test['status'] == 'failed' and first.startswith('AssertionError') and re.search(r'ORACLE:' + re.escape(expected['id']) + r'(?=$|[\s:])', first) is not None
  else: valid = test['status'] == 'passed'
  ok = ok and valid
 print(expected['id'], 'RED-BEHAVIOUR' if ok and mode == 'RED' else 'GREEN' if ok and mode == 'GREEN' else 'PRESERVE-PASS' if ok else 'RED-INVALID', 'matches=' + str(len(tests)))
 if not ok:
  invalid = True
  for test in tests:
   print(' ', test['fullName'], test['status'], (test.get('failureMessages') or [''])[0][:350])
sys.exit(1 if invalid else 0)
