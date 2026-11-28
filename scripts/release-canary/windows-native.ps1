# Copyright 2026 Ferrox Labs
# SPDX-License-Identifier: AGPL-3.0-or-later

param([Parameter(Mandatory)] [string]$Probe)
$ErrorActionPreference = 'Stop'
switch ($Probe) {
    'session' {
        Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class CanarySession {
    [DllImport("wtsapi32.dll", SetLastError=true)]
    public static extern bool WTSQuerySessionInformation(IntPtr server, int session, int type, out IntPtr data, out int length);
    [DllImport("wtsapi32.dll")] public static extern void WTSFreeMemory(IntPtr data);
}
'@
        $session = [System.Diagnostics.Process]::GetCurrentProcess().SessionId
        $ptr = [IntPtr]::Zero
        $size = 0
        $state = -1
        if ($session -gt 0 -and [CanarySession]::WTSQuerySessionInformation([IntPtr]::Zero, $session, 8, [ref]$ptr, [ref]$size)) {
            try { if ($size -eq 4) { $state = [Runtime.InteropServices.Marshal]::ReadInt32($ptr) } }
            finally { [CanarySession]::WTSFreeMemory($ptr) }
        }
        $caller = [Security.Principal.WindowsIdentity]::GetCurrent()
        @{ id = $caller.User.Value; session = $session; disconnected = ($state -eq 4) } | ConvertTo-Json -Compress
    }
    'processes' {
        $exeName = [IO.Path]::GetFileName($env:CANARY_PROBE_FILE)
        $processes = @(Get-CimInstance Win32_Process)
        $rows = foreach ($process in $processes) {
            if (!$process.CreationDate) { continue }
            $row = @{ pid = $process.ProcessId; parent = $process.ParentProcessId
                      started = $process.CreationDate.ToUniversalTime().ToString("o"); session = $process.SessionId }
            if ($process.Name -eq $exeName -and $process.SessionId -eq [System.Diagnostics.Process]::GetCurrentProcess().SessionId) {
                $owner = Invoke-CimMethod -InputObject $process -MethodName GetOwnerSid
                if ($owner.ReturnValue -ne 0) { throw "Process identity unavailable" }
                $row.id = $owner.Sid
                $row.exe = $process.ExecutablePath
                $row.command = $process.CommandLine
            }
            $row
        }
        ConvertTo-Json -InputObject @($rows) -Compress
    }
    'listener' {
        $port = [int]$env:CANARY_PROBE_PORT
        $rows = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | ForEach-Object {
            @{ pid = $_.OwningProcess; address = $_.LocalAddress }
        })
        ConvertTo-Json -InputObject $rows -Compress
    }
    'signature' {
        $file = Get-Item -LiteralPath $env:CANARY_PROBE_FILE
        $sig = Get-AuthenticodeSignature -LiteralPath $file.FullName
        @{ valid = ($sig.Status -eq 'Valid'); signer = $sig.SignerCertificate.Thumbprint
           version = $file.VersionInfo.ProductVersion } | ConvertTo-Json -Compress
    }
    default { throw "Unknown native probe" }
}
