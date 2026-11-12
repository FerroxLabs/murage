# Standalone proof used by the direct Node entry; this process inherits its job.
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'gate-admission.ps1')
Assert-GateAdmission
