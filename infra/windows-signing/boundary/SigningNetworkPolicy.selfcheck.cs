// Fake-policy/host witness owner: win-sac-sign; real Windows WFP/ACL/admission witness owner: MAIN.
using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Murage.Signing;

public sealed class FixtureNetwork : ISigningNetworkApi, IDisposable
{
    public List<string> Calls = new List<string>();
    public string Failure;
    private void Call(string name) { Calls.Add(name); if (Failure == name) throw new Exception(); }
    public void Begin(string sid) { Call("begin"); }
    public void Block(bool ipv6) { Call(ipv6 ? "block6" : "block4"); }
    public void Allow(SigningEndpoint endpoint) { Call("allow"); }
    public void Commit() { Call("commit"); }
    public void Abort() { Call("abort"); }
    public void Dispose() { Call("dispose-network"); }
}
public sealed class FixtureAdmission : ISigningAdmission
{
    public List<string> Calls = new List<string>();
    public string Failure;
    public FixtureNetwork Network;
    private void Call(string name) { Calls.Add(name); if (Failure == name) throw new Exception(); }
    public void AssertPeer(long pid, long creation) { Call("peer"); if (pid != 10 || creation != 20) throw new Exception(); }
    public Task<string> SealAsync(string launch, string authorization, CancellationToken cancellation)
    {
        Call("seal");
        if (!Network.Calls.Contains("commit")) throw new Exception("network assertion WFP not committed before seal");
        cancellation.ThrowIfCancellationRequested();
        return Task.FromResult(new string('c',64));
    }
    public void RevalidateHeldHandles() { Call("revalidate"); }
    public Task<string> VerifyCompleteReceiptAsync(CancellationToken cancellation) { Call("receipt"); return Task.FromResult(new string('d',64)); }
    public void Dispose() { Call("dispose-admission"); }
}
public static class NetworkChecks
{
    private const string Sid = "S-1-5-21-1-2-3-1001";
    private static int checks;
    private static void Assert(bool value) { checks++; if (!value) throw new Exception("network assertion " + checks); }
    private static void Reject(Action action) { bool failed=false; try { action(); } catch { failed=true; } Assert(failed); }
    private static async Task RejectAsync(Func<Task> action) { bool failed=false; try { await action(); } catch { failed=true; } Assert(failed); }
    private static SigningEndpoint Endpoint() { return new SigningEndpoint(SigningProcessSpec.Root + @"\pwsh\pwsh.exe", "192.0.2.1", 443); }
    private static SigningEndpoint[] Endpoints() { return new[] { Endpoint() }; }
    private static Dictionary<string,string> Credentials() { return new Dictionary<string,string> { {"AZURE_TENANT_ID","fixture"},{"AZURE_CLIENT_ID","fixture"},{"AZURE_CLIENT_SECRET","fixture"} }; }
    public static async Task<int> Run()
    {
        var network = new FixtureNetwork();
        SigningNetworkPolicy.Install(network, Sid, Endpoints());
        Assert(network.Calls.SequenceEqual(new[] {"begin","block4","block6","allow","commit"}));
        foreach (var path in new[] { SigningProcessSpec.Root + @"\pwsh\pwsh.exe", SigningProcessSpec.Signtool })
        foreach (var address in new[] { "192.0.2.1", "2001:db8::1" }) Assert(new SigningEndpoint(path,address,443).Address == address);
        foreach (var path in new[] { "pwsh.exe", @"C:\Temp\pwsh.exe", SigningProcessSpec.Root + @"\node\node.exe", SigningProcessSpec.Root + @"\builder\builder.exe", null })
            Reject(() => new SigningEndpoint(path,"192.0.2.1",443));
        foreach (var address in new[] { "*.azure.net", "fixture.example", "192.0.2.0/24", "127.0.0.1", "::1", "0.0.0.0", "::", "::ffff:192.0.2.1", "fe80::1%4", "192.000.002.001", null })
            Reject(() => new SigningEndpoint(Endpoint().Executable,address,443));
        Reject(() => new SigningEndpoint(Endpoint().Executable,"192.0.2.1",0));
        foreach (var sid in new[] { "S-1-5-18", "S-1-1-0", "fixture", Sid + ")", null })
        { var api=new FixtureNetwork(); Reject(() => SigningNetworkPolicy.Install(api,sid,Endpoints())); Assert(api.Calls.Count==0); }
        foreach (var rows in new[] { null, Array.Empty<SigningEndpoint>(), new SigningEndpoint[] { null }, new[] { Endpoint(),Endpoint() }, Enumerable.Range(1,257).Select(i => new SigningEndpoint(Endpoint().Executable,"2001:db8::"+i.ToString("x"),443)).ToArray() })
        { var api=new FixtureNetwork(); Reject(() => SigningNetworkPolicy.Install(api,Sid,rows)); Assert(api.Calls.Count==0); }
        Reject(() => SigningNetworkPolicy.Install(null,Sid,Endpoints()));
        foreach (var failure in new[] {"begin","block4","block6","allow","commit","abort"})
        {
            var api=new FixtureNetwork { Failure=failure == "abort" ? "block4" : failure };
            Reject(() => SigningNetworkPolicy.Install(api,Sid,Endpoints()));
            Assert(api.Calls.Last()=="abort");
            if (failure != "commit") Assert(!api.Calls.Contains("commit"));
        }
        network = new FixtureNetwork(); var admission = new FixtureAdmission { Network=network }; var processes=new FixtureProcessApi();
        var host=new SealedSigningHost(admission,network,processes,new IntPtr(10),Sid,Endpoints(),ProcessChecks.Environment());
        Reject(() => host.RevalidateHeldHandles());
        await RejectAsync(async () => { await host.CreateSigningProcessAsync(Credentials(),CancellationToken.None); });
        Assert(processes.Calls.Count==0);
        host.AssertPeer(10,20); Reject(() => host.AssertPeer(11,20));
        Assert(await host.SealAsync("launch","authorization",CancellationToken.None)==new string('c',64));
        await RejectAsync(async () => { await host.SealAsync("launch","authorization",CancellationToken.None); });
        host.RevalidateHeldHandles();
        var completion=await host.CreateSigningProcessAsync(Credentials(),CancellationToken.None);
        Assert(completion.ExitCode==0 && completion.ReceiptSha256==new string('d',64));
        Assert(admission.Calls.Last()=="receipt");
        Assert(processes.Calls.Contains("resume"));
        await RejectAsync(async () => { await host.CreateSigningProcessAsync(Credentials(),CancellationToken.None); });
        host.Dispose(); host.Dispose();
        Assert(network.Calls.Last()=="dispose-network" && admission.Calls.Last()=="dispose-admission");
        Reject(() => host.AssertPeer(10,20));
        foreach (var failure in new[] { "network", "token", "sid", "seal", "revalidate", "create", "exit", "receipt", "cancel" })
        {
            network=new FixtureNetwork {Failure=failure=="network" ? "commit" : null};
            admission=new FixtureAdmission {Network=network,Failure=new[] {"seal","revalidate","receipt"}.Contains(failure) ? failure : null};
            processes=new FixtureProcessApi {Failure=new[] {"token","sid","create"}.Contains(failure) ? failure : null,Exit=failure=="exit" ? 7 : 0};
            using(var current=new SealedSigningHost(admission,network,processes,new IntPtr(10),Sid,Endpoints(),ProcessChecks.Environment()))
            {
                if(new[] {"network","token","sid","seal","revalidate"}.Contains(failure)) {
                    await RejectAsync(async()=>{await current.SealAsync("launch","authorization",CancellationToken.None);});
                    Assert(!processes.Calls.Contains("create"));
                } else {
                    await current.SealAsync("launch","authorization",CancellationToken.None);
                    if(failure=="cancel") current.TerminateJob();
                    await RejectAsync(async()=>{await current.CreateSigningProcessAsync(Credentials(),CancellationToken.None);});
                    if(failure!="receipt") Assert(!admission.Calls.Contains("receipt"));
                }
            }
        }
        return checks;
    }
}
