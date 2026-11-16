#!/bin/bash
set -euo pipefail
cd /cap
printf '%s  %s\n' 12c9b952ee9c9561e4ef36ed18973f3af2a443817f5dc928e89bee38dddddc07 package/bin/fuigo | sha256sum -c -
package/bin/fuigo --version > binary-version.txt
python3 capture.py "$1" "$2"
