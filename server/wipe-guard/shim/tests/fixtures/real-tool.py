#!/usr/bin/env python3
"""A real exec witness: preserve argv, streams, and the requested exit status."""
import json
import os
import sys
from pathlib import Path

with Path(os.environ['WG_REAL_LOG']).open('a') as output:
    output.write(json.dumps({'argv': sys.argv[1:], 'cwd': os.getcwd(), 'lc_all': os.environ.get('LC_ALL')}) + '\n')
sys.stdout.write(os.environ.get('WG_REAL_STDOUT', ''))
sys.stderr.write(os.environ.get('WG_REAL_STDERR', ''))
raise SystemExit(int(os.environ.get('WG_REAL_EXIT', '0')))
