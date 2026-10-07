# Copyright 2026 Ferrox Labs
# SPDX-License-Identifier: AGPL-3.0-or-later
param(
    [Parameter(Mandatory=$true)][string]$JobName,
    [string]$Cwd,
    [string]$ArgsFile,
    [switch]$Stop,
    [int]$WaitMs = 4000
)
$ErrorActionPreference = 'Stop'
# Both launch and recovery use this definition. Handles are never inheritable.
try {
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
public static class PipJob {
    public const uint KILL_ON_JOB_CLOSE = 0x2000;
    [StructLayout(LayoutKind.Sequential)] public struct BasicLimits {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)] public struct IoCounters {
        public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
        public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
    }
    [StructLayout(LayoutKind.Sequential)] public struct ExtendedLimits {
        public BasicLimits BasicLimitInformation;
        public IoCounters IoInfo;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }
    [StructLayout(LayoutKind.Sequential)] public struct Accounting {
        public long TotalUserTime, TotalKernelTime, ThisPeriodTotalUserTime, ThisPeriodTotalKernelTime;
        public uint TotalPageFaultCount, TotalProcesses, ActiveProcesses, TotalTerminatedProcesses;
    }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    public static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError=true)]
    public static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref ExtendedLimits info, uint length);
    [DllImport("kernel32.dll", SetLastError=true)]
    public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll")] public static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    public static extern IntPtr OpenJobObjectW(uint access, bool inherit, string name);
    [DllImport("kernel32.dll", SetLastError=true)]
    public static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll", SetLastError=true)]
    public static extern bool QueryInformationJobObject(IntPtr job, int infoClass, out Accounting info, uint length, IntPtr returned);
    [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);
    // CommandLineToArgvW / CRT quoting, including empty args and trailing slashes.
    public static string Quote(string value) {
        var result = new StringBuilder("\"");
        int slashes = 0;
        foreach (char c in value) {
            if (c == '\\') { slashes++; continue; }
            result.Append('\\', c == '"' ? slashes * 2 + 1 : slashes);
            result.Append(c); slashes = 0;
        }
        result.Append('\\', slashes * 2); result.Append('"');
        return result.ToString();
    }
    public static int Launch(string command, string[] args, string cwd) {
        var quoted = new string[args.Length];
        for (int i = 0; i < args.Length; i++) quoted[i] = Quote(args[i]);
        var info = new ProcessStartInfo(command, String.Join(" ", quoted));
        info.UseShellExecute = false;
        info.WorkingDirectory = cwd;
        // No redirection: inherit the supervisor's stdin, stdout, stderr and env.
        using (var child = Process.Start(info)) { child.WaitForExit(); return child.ExitCode; }
    }
}
'@
    if ($Stop) {
        $job = [PipJob]::OpenJobObjectW(0x000C, $false, $JobName) # TERMINATE | QUERY
        if ($job -eq [IntPtr]::Zero) {
            if ([Runtime.InteropServices.Marshal]::GetLastWin32Error() -eq 2) {
                Write-Output '{"state":"absent"}'
                exit 0
            }
            exit 221
        }
        try {
            if (-not [PipJob]::TerminateJobObject($job, 1)) { exit 221 }
            $clock = [Diagnostics.Stopwatch]::StartNew()
            do {
                $info = New-Object PipJob+Accounting
                if (-not [PipJob]::QueryInformationJobObject($job, 1, [ref]$info, [Runtime.InteropServices.Marshal]::SizeOf($info), [IntPtr]::Zero)) { exit 221 }
                if ($info.ActiveProcesses -eq 0 -or $clock.ElapsedMilliseconds -ge $WaitMs) {
                    Write-Output ('{"state":"present","activeProcesses":' + $info.ActiveProcesses + '}')
                    exit 0
                }
                Start-Sleep -Milliseconds 25
            } while ($true)
        } finally { [void][PipJob]::CloseHandle($job) }
    }
    $job = [PipJob]::CreateJobObjectW([IntPtr]::Zero, $JobName)
    # Refuse both failure and an existing name; never attach to another attempt.
    if ($job -eq [IntPtr]::Zero -or [Runtime.InteropServices.Marshal]::GetLastWin32Error() -eq 183) { exit 220 }
    $limits = New-Object PipJob+ExtendedLimits
    $basic = New-Object PipJob+BasicLimits
    $basic.LimitFlags = [PipJob]::KILL_ON_JOB_CLOSE
    $limits.BasicLimitInformation = $basic
    if (-not [PipJob]::SetInformationJobObject($job, 9, [ref]$limits, [Runtime.InteropServices.Marshal]::SizeOf($limits))) { exit 220 }
    if (-not [PipJob]::AssignProcessToJobObject($job, [PipJob]::GetCurrentProcess())) { exit 220 }
    # Read launch data only after membership is established. No CLI args cross PowerShell parsing.
    $launch = Get-Content -LiteralPath $ArgsFile -Raw -Encoding UTF8 | ConvertFrom-Json
    $code = [PipJob]::Launch([string]$launch.command, [string[]]$launch.args, $Cwd)
    # Keep the handle until process exit: closing it also terminates this supervisor.
    [Environment]::Exit($code)
} catch {
    if ($Stop) { exit 221 }
    exit 220
}
