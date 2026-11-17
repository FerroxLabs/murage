# Lease self-check owner: win-sac-sign; native Windows witness consumer: MAIN.
$ErrorActionPreference = 'Stop'
$assembly = Join-Path ([System.IO.Path]::GetTempPath()) ("boundary-" + [Guid]::NewGuid().ToString('N') + '.dll')
Add-Type -Path "$PSScriptRoot/SigningLease.cs", "$PSScriptRoot/BoundaryPipe.cs" -OutputAssembly $assembly
Add-Type -Path $assembly
$references = @($assembly) + @(Get-ChildItem "$PSHOME/ref/*.dll" | ForEach-Object FullName)
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using Murage.Signing;
public sealed class FixtureHost : ISealedSigningHost {
    public int Seals, Starts, Checks, Stops;
    public bool RejectSeal, RejectStart, RejectFinal, BadReceipt, NonzeroExit;
    public TaskCompletionSource<bool> Started = new TaskCompletionSource<bool>();
    public TaskCompletionSource<bool> Continue = new TaskCompletionSource<bool>();
    public bool Pause;
    public void AssertPeer(long pid, long creation) { if (pid != 10 || creation != 20) throw new Exception(); }
    public Task<string> SealAsync(string launch, string auth, CancellationToken cancellation) {
        Seals++; if (RejectSeal) throw new Exception("fixture failure"); return Task.FromResult(new string('c',64));
    }
    public void RevalidateHeldHandles() { Checks++; if (RejectFinal && Checks == 2) throw new Exception(); }
    public async Task<SigningCompletion> CreateSigningProcessAsync(IReadOnlyDictionary<string,string> credentials, CancellationToken cancellation) {
        Starts++; if (credentials.Count != 3 || !credentials.ContainsKey("AZURE_CLIENT_SECRET")) throw new Exception();
        Started.SetResult(true);
        if (Pause) await Continue.Task;
        if (RejectStart || cancellation.IsCancellationRequested) throw new Exception("fixture child diagnostics");
        return new SigningCompletion(NonzeroExit?1:0,BadReceipt?"missing":new string('d',64));
    }
    public void TerminateJob() { Stops++; }
    public void Dispose() { }
}
public static class LeaseChecks {
    static int checks;
    static void Assert(bool value) { checks++; if (!value) throw new Exception("boundary assertion " + checks); }
    static async Task Reject(Func<Task> action) { bool rejected=false; try { await action(); } catch(Exception e) { rejected=e.Message=="WINDOWS_SIGNING_BOUNDARY_REJECTED"; } Assert(rejected); }
    static SigningLease Lease(FixtureHost host, TimeSpan? ttl=null) { return new SigningLease(host,new Dictionary<string,string> {
        {"AZURE_TENANT_ID","fixture"},{"AZURE_CLIENT_ID","fixture"},{"AZURE_CLIENT_SECRET","fixture"}
    },new string('a',64),new string('b',64),10,20,ttl ?? TimeSpan.FromMinutes(1)); }
    static Task<string> Seal(SigningLease lease) { return lease.SealAsync(10,20,new string('a',64),new string('b',64)); }
    static Task<SigningCompletion> Release(SigningLease lease) { return lease.ReleaseAsync(10,20,new string('c',64)); }
    public static async Task<int> Run() {
        var host=new FixtureHost();
        using(var lease=Lease(host)) {
            await Reject(async()=>{await Release(lease);}); Assert(host.Starts==0);
            await Reject(async()=>{await lease.SealAsync(11,20,new string('a',64),new string('b',64));});
            await Reject(async()=>{await lease.SealAsync(10,21,new string('a',64),new string('b',64));});
            await Reject(async()=>{await lease.SealAsync(10,20,new string('e',64),new string('b',64));});
            await Reject(async()=>{await lease.SealAsync(10,20,new string('a',64),new string('e',64));});
            Assert(host.Seals==0); await Seal(lease);
            await Reject(async()=>{await Seal(lease);});
            await Reject(async()=>{await lease.ReleaseAsync(10,20,new string('e',64));}); Assert(host.Starts==0);
            var result=await Release(lease); Assert(result.ExitCode==0 && result.ReceiptSha256==new string('d',64));
            Assert(host.Starts==1 && host.Checks==2);
            await Reject(async()=>{await Release(lease);}); Assert(host.Starts==1);
        }
        Assert(host.Stops>0);
        host=new FixtureHost { RejectSeal=true };
        using(var lease=Lease(host)) { await Reject(async()=>{await Seal(lease);}); await Reject(async()=>{await Release(lease);}); Assert(host.Starts==0 && host.Stops>0); }
        foreach(var failure in new[]{"start","final","disconnect-before","disconnect-after","receipt","exit"}) {
            host=new FixtureHost { RejectStart=failure=="start", RejectFinal=failure=="final", Pause=failure=="disconnect-after", BadReceipt=failure=="receipt", NonzeroExit=failure=="exit" };
            using(var lease=Lease(host)) {
                await Seal(lease);
                if(failure=="disconnect-before") lease.Revoke();
                if(failure=="disconnect-after") {
                    var running=Release(lease); await host.Started.Task; lease.Revoke(); host.Continue.SetResult(true);
                    await Reject(async()=>{await running;});
                } else await Reject(async()=>{await Release(lease);});
                await Reject(async()=>{await Release(lease);}); Assert(host.Stops>0); if(failure=="disconnect-before") Assert(host.Starts==0);
            }
        }
        host=new FixtureHost { Pause=true };
        using(var lease=Lease(host)) {
            await Seal(lease); var running=Release(lease); await host.Started.Task;
            await Reject(async()=>{await Release(lease);}); Assert(host.Starts==1);
            host.Continue.SetResult(true); await running;
        }
        host=new FixtureHost();
        using(var lease=Lease(host,TimeSpan.FromMilliseconds(50))) {
            await Seal(lease); await Task.Delay(150); await Reject(async()=>{await Release(lease);}); Assert(host.Starts==0 && host.Stops>0);
        }
        return checks;
    }
}
'@ -ReferencedAssemblies $references
$checks = [LeaseChecks]::Run().GetAwaiter().GetResult()
Write-Output "lease assertions $checks"
