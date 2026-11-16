// Fake-native checks owner: win-sac-sign; real Windows token/process witness owner: MAIN.
using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Murage.Signing;

public sealed class FixtureProcessApi : ISigningProcessApi
{
    public readonly List<string> Calls = new List<string>();
    public string Failure;
    public int Exit;
    public byte[] Block;
    public SigningProcessSpec Spec;
    public CancellationTokenSource Cancel;
    public void AssertStandardToken(IntPtr token) { Call("token"); if (token != new IntPtr(10)) throw new Exception(); }
    public void AssertTokenSid(IntPtr token, string sid) { Call("sid"); if (token != new IntPtr(10) || sid != "S-1-5-21-1-2-3-1001") throw new Exception(); }
    private void Call(string call) { Calls.Add(call); if (Failure == call) throw new Exception("private fixture diagnostic"); }
    public IntPtr CreateJob() { Call("job"); return Failure == "null-job" ? IntPtr.Zero : new IntPtr(20); }
    public SigningProcessHandles CreateSuspended(IntPtr token, SigningProcessSpec spec, byte[] environment)
    {
        Block = environment; Spec = spec; Call("create");
        if (!Encoding.Unicode.GetString(environment).EndsWith("\0\0")) throw new Exception();
        if (Failure == "cancel-created") Cancel.Cancel();
        return Failure == "null-child" ? null : new SigningProcessHandles(new IntPtr(30), new IntPtr(40));
    }
    public void Assign(IntPtr job, IntPtr process) { if (job != new IntPtr(20) || process != new IntPtr(30)) throw new Exception(); Call("assign"); }
    public void Resume(IntPtr thread) { if (thread != new IntPtr(40)) throw new Exception(); Call("resume"); }
    public Task<int> WaitAsync(IntPtr process, CancellationToken cancellation)
    {
        Call("wait"); if (Failure == "cancel-wait") { Cancel.Cancel(); cancellation.ThrowIfCancellationRequested(); }
        return Task.FromResult(Exit);
    }
    public void Terminate(IntPtr process) { if (process != new IntPtr(30)) throw new Exception(); Call("terminate"); }
    public void Close(IntPtr handle) { Call("close-" + handle.ToInt64()); }
}
public static class ProcessChecks
{
    static int checks;
    static void Assert(bool value) { checks++; if (!value) throw new Exception("process assertion " + checks); }
    static void Reject(Action action) { bool rejected = false; try { action(); } catch (Exception e) { rejected = e.Message == "WINDOWS_SIGNING_PROCESS_REJECTED"; } Assert(rejected); }
    static async Task RejectAsync(Func<Task> action) { bool rejected = false; try { await action(); } catch (Exception e) { rejected = e.Message == "WINDOWS_SIGNING_PROCESS_REJECTED"; } Assert(rejected); }
    public static Dictionary<string, string> Environment()
    {
        return new Dictionary<string, string> {
            { "SystemRoot", @"C:\Windows" }, { "WINDIR", @"C:\Windows" },
            { "TEMP", @"C:\MurageSigningData\" + new string('a', 64) + @"\temp" }, { "TMP", @"C:\MurageSigningData\" + new string('a', 64) + @"\temp" },
            { "PATH", SigningProcessSpec.Root + @"\node;" + SigningProcessSpec.Root + @"\pwsh" },
            { "PSModulePath", SigningProcessSpec.Root + @"\provider\modules" }, { "NODE_OPTIONS", "" }, { "MURAGE_BUILD_COMMIT", new string('b',40) }
        };
    }
    static Dictionary<string, string> Credentials()
    {
        return new Dictionary<string, string> { { "AZURE_TENANT_ID", "fixture" }, { "AZURE_CLIENT_ID", "fixture" }, { "AZURE_CLIENT_SECRET", "fixture" } };
    }
    public static async Task<int> Run()
    {
        var bootstrap = new SigningProcessSpec(true, Environment());
        Assert(bootstrap.Executable == SigningProcessSpec.Root + @"\node\node.exe");
        Assert(bootstrap.Arguments == "--max-old-space-size=4300 \"" + SigningProcessSpec.Root + @"\app\scripts\windows-signing-bootstrap.mjs" + "\"");
        Assert(!bootstrap.Environment.Keys.Any(key => key.StartsWith("AZURE_")));
        var spec = new SigningProcessSpec(false, Environment(), Credentials());
        Assert(spec.Executable == SigningProcessSpec.Root + @"\pwsh\pwsh.exe");
        Assert(spec.Arguments == "-NoProfile -NonInteractive -File \"" + SigningProcessSpec.Root + @"\launch\launch.ps1" + "\"");
        Assert(spec.WorkingDirectory == SigningProcessSpec.Root + @"\launch");
        var block = spec.EnvironmentBlock(); var text = Encoding.Unicode.GetString(block);
        Assert(text.EndsWith("\0\0") && text.Split('\0').Count(row => row.StartsWith("AZURE_")) == 3);
        Assert(text.Contains("NODE_OPTIONS=\0") && !text.Contains("GITHUB_"));
        var original = Environment(); spec = new SigningProcessSpec(true, original); original["PATH"] = "poison";
        Assert(spec.Environment["PATH"] != "poison");
        foreach (var key in Environment().Keys) { var bad = Environment(); bad.Remove(key); if (key == "MURAGE_BUILD_COMMIT") continue; Reject(() => new SigningProcessSpec(true, bad)); }
        foreach (var key in new[] { "AZURE_CLIENT_SECRET", "azure_client_secret", "GITHUB_PATH", "GITHUB_ENV", "GITHUB_OUTPUT", "ACTIONS_ID_TOKEN_REQUEST_TOKEN", "USERPROFILE", "PSHOME", "HTTP_PROXY", "npm_config_prefix", "MURAGE_PRIVATE_TOKEN", "MURAGE_PASSWORD", "MURAGE_SECRET", "MURAGE_CREDENTIAL", "BAD=KEY", "BAD\0KEY", "", "path" })
        {
            var bad = Environment(); bad[key] = "fixture"; Reject(() => new SigningProcessSpec(true, bad));
        }
        foreach (var poison in new[] { "pwsh", "node", @"C:\user\bin", SigningProcessSpec.Root + @"\..\temp", SigningProcessSpec.Root + @"\node;", SigningProcessSpec.Root + @"\node\.", SigningProcessSpec.Root + @"\node ", SigningProcessSpec.Root + @"\node:stream", SigningProcessSpec.Root + @"\node\file'" })
        foreach (var key in new[] { "PATH", "PSModulePath" }) { var bad = Environment(); bad[key] = poison; Reject(() => new SigningProcessSpec(true, bad)); }
        foreach (var pair in new[] { ("NODE_OPTIONS", "--require=fixture.cjs"), ("SystemRoot", @"C:\Temp"), ("WINDIR", @"C:\Temp"), ("TEMP", @"C:\Temp"), ("TMP", @"C:\Temp"), ("MURAGE_DATA", "fixture\0ignored") })
        { var bad = Environment(); bad[pair.Item1] = pair.Item2; Reject(() => new SigningProcessSpec(true, bad)); }
        var poisonedWindows = Environment(); poisonedWindows["SystemRoot"] = poisonedWindows["WINDIR"] = @"C:\Temp";
        Reject(() => new SigningProcessSpec(true, poisonedWindows));
        var poisonedTemp = Environment(); poisonedTemp["TEMP"] = poisonedTemp["TMP"] = @"C:\Temp";
        Reject(() => new SigningProcessSpec(true, poisonedTemp));
        Reject(() => new SigningProcessSpec(true, null));
        var nullValue = Environment(); nullValue["MURAGE_DATA"] = null; Reject(() => new SigningProcessSpec(true, nullValue));
        Reject(() => new SigningProcessSpec(true, Environment(), Credentials()));
        Reject(() => new SigningProcessSpec(false, Environment()));
        foreach (var key in Credentials().Keys)
        {
            var missing = Credentials(); missing.Remove(key); Reject(() => new SigningProcessSpec(false, Environment(), missing));
            var empty = Credentials(); empty[key] = ""; Reject(() => new SigningProcessSpec(false, Environment(), empty));
            var nul = Credentials(); nul[key] = "fixture\0suffix"; Reject(() => new SigningProcessSpec(false, Environment(), nul));
        }
        var extra = Credentials(); extra["AZURE_EXTRA"] = "fixture"; Reject(() => new SigningProcessSpec(false, Environment(), extra));
        var huge = Environment(); huge["MURAGE_DATA"] = new string('a',32768); Reject(() => new SigningProcessSpec(true, huge).EnvironmentBlock());
        foreach (bool isBootstrap in new[] { true, false })
        {
            var api = new FixtureProcessApi();
            Assert(await SigningProcess.RunAsync(api, new IntPtr(10), new SigningProcessSpec(isBootstrap, Environment(), isBootstrap ? null : Credentials()), CancellationToken.None) == 0);
            Assert(api.Calls.SequenceEqual(new[] { "token", "job", "create", "assign", "resume", "wait", "terminate", "close-20", "close-40", "close-30" }));
            Assert(api.Block.All(b => b == 0));
            Assert(!api.Spec.Environment.Keys.Any(key => key.StartsWith("AZURE_")));
        }
        var nonzero = new FixtureProcessApi { Exit = 7 };
        Assert(await SigningProcess.RunAsync(nonzero, new IntPtr(10), bootstrap, CancellationToken.None) == 7);
        foreach (var failure in new[] { "token", "job", "null-job", "create", "null-child", "assign", "resume", "wait", "cancel-created", "cancel-wait", "terminate", "close-20", "close-40", "close-30" })
        {
            var cancel = new CancellationTokenSource(); var api = new FixtureProcessApi { Failure = failure, Cancel = cancel };
            await RejectAsync(async () => { await SigningProcess.RunAsync(api, new IntPtr(10), bootstrap, cancel.Token); });
            if (api.Block != null) Assert(api.Block.All(b => b == 0));
            if (new[] { "token", "job", "null-job" }.Contains(failure)) Assert(!api.Calls.Contains("create"));
            if (new[] { "create", "null-child", "assign", "cancel-created" }.Contains(failure)) Assert(!api.Calls.Contains("resume"));
            if (new[] { "assign", "resume", "wait", "cancel-created", "cancel-wait", "terminate", "close-20", "close-40", "close-30" }.Contains(failure))
                Assert(api.Calls.Contains("terminate") && api.Calls.Contains("close-20") && api.Calls.Contains("close-40") && api.Calls.Contains("close-30"));
        }
        var cancelled = new CancellationTokenSource(); cancelled.Cancel(); var notStarted = new FixtureProcessApi();
        await RejectAsync(async () => { await SigningProcess.RunAsync(notStarted, new IntPtr(10), bootstrap, cancelled.Token); }); Assert(notStarted.Calls.Count == 0);
        await RejectAsync(async () => { await SigningProcess.RunAsync(notStarted, IntPtr.Zero, bootstrap, CancellationToken.None); }); Assert(notStarted.Calls.Count == 0);
        if (!System.Runtime.InteropServices.RuntimeInformation.IsOSPlatform(System.Runtime.InteropServices.OSPlatform.Windows)) Reject(() => new WindowsSigningProcessApi());
        return checks;
    }
}
