# Harmless storage cmdlets and named-pipe peer shared by isolated test processes.
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.IO.Pipes;
using System.Text;
using System.Text.RegularExpressions;
using System.Collections.Concurrent;
using System.Threading;
using System.Management.Automation;
public class GuardFixtureDiskCmdlet : PSCmdlet {
    [Parameter(Position=0)] public int Number { get; set; }
    [Parameter(ValueFromPipeline=true)] public PSObject InputObject { get; set; }
    [Parameter] public SwitchParameter Force { get; set; }
    protected override void ProcessRecord() {
        if (ShouldProcess("fixture-disk", "fixture-only")) WriteObject(InputObject ?? new PSObject(Number));
    }
}
[Cmdlet("Format", "Volume", SupportsShouldProcess=true)] public class GuardFixtureFormat : GuardFixtureDiskCmdlet {}
[Cmdlet("Clear", "Disk", SupportsShouldProcess=true)] public class GuardFixtureClear : GuardFixtureDiskCmdlet {}
[Cmdlet("Initialize", "Disk", SupportsShouldProcess=true)] public class GuardFixtureInitialize : GuardFixtureDiskCmdlet {}
[Cmdlet("Remove", "Partition", SupportsShouldProcess=true)] public class GuardFixturePartition : GuardFixtureDiskCmdlet {}
public sealed class GuardFixturePipe : IDisposable {
    public readonly string Name = "guard-fixture-" + Guid.NewGuid().ToString("N");
    public readonly ConcurrentQueue<string> Requests = new ConcurrentQueue<string>();
    public volatile string Decision = "deny";
    public volatile int DelayMs;
    volatile bool stopped;
    NamedPipeServerStream server;
    readonly Thread worker;
    public GuardFixturePipe() {
        server = MakePipe();
        worker = new Thread(Run); worker.IsBackground = true; worker.Start();
    }
    NamedPipeServerStream MakePipe() {
        return new NamedPipeServerStream(Name, PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.None);
    }
    void Run() {
        while (!stopped) {
            try {
                var current = server;
                current.WaitForConnection();
                var reader = new StreamReader(current, new UTF8Encoding(false), false, 1024, true);
                var writer = new StreamWriter(current, new UTF8Encoding(false), 1024, true);
                string line = reader.ReadLine();
                Requests.Enqueue(line);
                var id = Regex.Match(line, "\"id\"\\s*:\\s*\"([^\"]+)\"").Groups[1].Value;
                if (DelayMs > 0) Thread.Sleep(DelayMs);
                if (Decision == "malformed") writer.WriteLine("{}");
                else writer.WriteLine("{\"id\":\"" + id + "\",\"decision\":\"" + Decision + "\"}");
                writer.Flush(); reader.Dispose(); writer.Dispose(); current.Dispose();
                if (!stopped) server = MakePipe();
            } catch { if (!stopped) { try { server.Dispose(); } catch {} server = MakePipe(); } }
        }
    }
    public void Dispose() { stopped = true; server.Dispose(); worker.Join(1000); }
}
'@
$diskModule = Import-Module -Assembly ([GuardFixtureDiskCmdlet].Assembly) -PassThru

function Invoke-GuardChild([string] $GuardScript, [string] $Fixture, [string] $Root, [string] $Action) {
    $qGuard = $GuardScript.Replace("'", "''")
    $qRoot = $Root.Replace("'", "''")
    $qFixture = $Fixture.Replace("'", "''")
    $qHelpers = $PSCommandPath.Replace("'", "''")
    $code = ". '$qHelpers'; . '$qGuard'; " + '$script:root = ' + "'$qRoot'; " + '$fixture = ' + "'$qFixture'; " + $Action
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($code))
    $hostPath = (Get-Process -Id $PID).Path
    $stdout = Join-Path $Fixture 'stdout.txt'; $stderr = Join-Path $Fixture 'stderr.txt'
    $p = Start-Process -FilePath $hostPath -ArgumentList @('-NoProfile','-NonInteractive','-EncodedCommand',$encoded) -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru -Wait
    return @{ Code = $p.ExitCode; Out = [IO.File]::ReadAllText($stdout); Err = [IO.File]::ReadAllText($stderr) }
}
