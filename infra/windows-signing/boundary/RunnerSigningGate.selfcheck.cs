// Runner dispatch checks owner: win-sac-sign; built-worker and Windows service witness owner: MAIN.
using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Murage.Signing;

public static class RunnerGateChecks
{
    private const string Root = @"C:\Program Files\MurageSigning";
    static int checks;
    static string Shell = "\"" + Root + @"\pwsh\pwsh.exe" + "\" -NoProfile -NonInteractive -File {0}";
    static string Script = "$ErrorActionPreference = 'Stop'\n& '" + Root + @"\node\node.exe" + "' --max-old-space-size=4300 '" + Root + @"\app\scripts\windows-signing-driver.mjs" + "'\nexit $LASTEXITCODE\n";
    static Dictionary<string,string> Environment() { return new Dictionary<string,string> { { "AZURE_TENANT_ID","fixture" },{ "AZURE_CLIENT_ID","fixture" },{ "AZURE_CLIENT_SECRET","fixture" },{ "PATH","poison" },{ "NODE_OPTIONS","--require=fixture.cjs" },{ "GITHUB_PATH","fixture" } }; }
    static void Assert(bool value) { checks++; if (!value) throw new Exception("runner gate assertion " + checks); }
    static byte[] Response(byte[] request)
    {
        using (var value = JsonDocument.Parse(request))
        {
            Assert(value.RootElement.GetProperty("operation").GetString() == "launch");
            Assert(value.RootElement.GetProperty("credentials").EnumerateObject().Count() == 3);
            Assert(!Encoding.UTF8.GetString(request).Contains("poison") && !Encoding.UTF8.GetString(request).Contains("NODE_OPTIONS") && !Encoding.UTF8.GetString(request).Contains("GITHUB_PATH"));
            return JsonSerializer.SerializeToUtf8Bytes(new { id = value.RootElement.GetProperty("id").GetString(), ok = true, result = new { exitCode = 0, receiptSha256 = new string('d',64) } });
        }
    }
    static async Task Reject(Dictionary<string,string> env, string shell, string script, Func<byte[],byte[]> mutate = null, bool cancelled = false)
    {
        int calls = 0; byte[] buffer = null;
        var cancellation = new CancellationTokenSource(); if (cancelled) cancellation.Cancel();
        bool rejected = false;
        try
        {
            await RunnerSigningGate.DispatchAsync(env,shell,script,(request,ct) => { calls++; buffer = request; return Task.FromResult(mutate == null ? Response(request) : mutate(Response(request))); },cancellation.Token);
        }
        catch (Exception e) { rejected = e.Message == "WINDOWS_SIGNING_RUNNER_REJECTED"; }
        Assert(rejected && calls == (mutate == null ? 0 : 1));
        Assert(!RunnerSigningGate.HasCredentials(env));
        if (buffer != null) Assert(buffer.All(b => b == 0));
    }
    static byte[] Change(byte[] bytes, string field, object value, bool result = false)
    {
        var fields = JsonSerializer.Deserialize<Dictionary<string,object>>(bytes);
        if (result) { var nested = JsonSerializer.Deserialize<Dictionary<string,object>>(fields["result"].ToString()); nested[field] = value; fields["result"] = nested; }
        else fields[field] = value;
        return JsonSerializer.SerializeToUtf8Bytes(fields);
    }
    public static async Task<int> Run()
    {
        var env = Environment(); byte[] buffer = null;
        Assert(RunnerSigningGate.HasCredentials(env));
        Assert(await RunnerSigningGate.DispatchAsync(env,Shell,Script,(request,ct) => { buffer = request; return Task.FromResult(Response(request)); },CancellationToken.None) == 0);
        Assert(!RunnerSigningGate.HasCredentials(env) && env.Count == 3 && env["PATH"] == "poison");
        Assert(buffer.All(b => b == 0));
        foreach (var key in new[] { "AZURE_TENANT_ID","AZURE_CLIENT_ID","AZURE_CLIENT_SECRET" })
        {
            env = Environment(); env.Remove(key); await Reject(env,Shell,Script);
            env = Environment(); env[key] = ""; await Reject(env,Shell,Script);
            env = Environment(); env[key] = "fixture\0suffix"; await Reject(env,Shell,Script);
            env = Environment(); env[key.ToLowerInvariant()] = env[key]; env.Remove(key); await Reject(env,Shell,Script);
        }
        env = Environment(); env["AZURE_EXTRA"] = "fixture"; await Reject(env,Shell,Script);
        foreach (string shell in new[] { "pwsh", "pwsh.exe", @"relative\pwsh.exe", Shell.Replace(" -NoProfile",""), Shell.Replace(" -NonInteractive",""), Shell.Replace(" -File"," -Command"), Shell.Replace("Program Files", "Users\\fixture"), Shell + " extra" }) await Reject(Environment(),shell,Script);
        foreach (string script in new[] { "node scripts/windows-signing-driver.mjs", Script.Replace(" --max-old-space-size=4300",""), Script + "Write-Output 'fixture'", Script.Replace("--max-old-space-size=4300", "--require=fixture.cjs"), Script.Replace("exit $LASTEXITCODE", "exit 0"), Script.Replace("windows-signing-driver", "windows-gepa-ci") }) await Reject(Environment(),Shell,script);
        await Reject(Environment(),Shell,Script,cancelled:true);
        env = Environment(); env["AZURE_CLIENT_SECRET"] = new string('a',65536); await Reject(env,Shell,Script);
        foreach (var mutate in new Func<byte[],byte[]>[] {
            bytes => Change(bytes,"id","stale"), bytes => Change(bytes,"ok",false), bytes => Change(bytes,"AZURE_CLIENT_SECRET","fixture"),
            bytes => Change(bytes,"exitCode",1,true), bytes => Change(bytes,"receiptSha256","missing",true), bytes => Change(bytes,"receiptSha256",new string('0',64),true),
            bytes => Change(bytes,"AZURE_CLIENT_SECRET","fixture",true), bytes => Encoding.UTF8.GetBytes("invalid"), bytes => Encoding.UTF8.GetBytes("null"),
            bytes => Encoding.UTF8.GetBytes("{\"id\":\"duplicate\"," + Encoding.UTF8.GetString(bytes).Substring(1)), bytes => { throw new Exception("private fixture diagnostic"); }
        }) await Reject(Environment(),Shell,Script,mutate);
        RunnerSigningGate.AssertCredentialFree(new Dictionary<string,string>());
        foreach (var value in new[] { Environment(), new Dictionary<string,string> { { "azure_extra","fixture" } }, null })
        {
            bool rejected = false; try { RunnerSigningGate.AssertCredentialFree(value); } catch(Exception e) { rejected = e.Message == "WINDOWS_SIGNING_RUNNER_REJECTED"; } Assert(rejected);
        }
        var before = System.Environment.GetEnvironmentVariable("AZURE_FIXTURE");
        try
        {
            System.Environment.SetEnvironmentVariable("AZURE_FIXTURE","fixture");
            bool rejected = false; try { RunnerSigningGate.AssertCredentialFree(new Dictionary<string,string>()); } catch(Exception e) { rejected = e.Message == "WINDOWS_SIGNING_RUNNER_REJECTED"; } Assert(rejected);
        }
        finally { System.Environment.SetEnvironmentVariable("AZURE_FIXTURE",before); }
        return checks;
    }
}
