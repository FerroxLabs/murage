# Copyright 2026 Ferrox Labs
# SPDX-License-Identifier: AGPL-3.0-or-later
$ErrorActionPreference = 'Stop'
& node (Join-Path $PSScriptRoot 'run.mjs') --os windows @args
exit $LASTEXITCODE
