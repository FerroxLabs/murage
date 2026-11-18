// Portable parser self-check producer: win-sac-sign; Windows/observer witness consumer: MAIN.
using System;
using System.Text;
using System.Text.Json;
using Murage.Witness;
public static class CollectorChecks
{
    public static int Run()
    {
        int count = 0;
        void Check(bool pass) { if (!pass) throw new Exception("COLLECTOR_SELF_CHECK_FAILED"); ++count; }
        void Reject(Action action)
        {
            try { action(); } catch (InvalidOperationException) { ++count; return; } catch (JsonException) { ++count; return; }
            throw new Exception("COLLECTOR_MUTANT_SURVIVED");
        }
        JsonDocument Parse(string text) => WitnessCodec.Parse(Encoding.UTF8.GetBytes(text), 1024 * 1024);
        Check(WitnessCodec.CaptureLimit == 128 * 1024 * 1024 && WitnessCodec.CaseMilliseconds == 20 * 60 * 1000);
        foreach (var text in new[] { "{} trailing", "{\"schema\":1,\"schema\":1}", "{\"inputs\":{\"pin\":1,\"pin\":2}}", "{\"a\":[{\"b\":0,\"b\":0}]}", new string('[', 33) + new string(']', 33) })
            Reject(() => { using var doc = Parse(text); });
        Reject(() => WitnessCodec.Parse(Encoding.UTF8.GetBytes("{\"a\":\"" + new string('a', 100) + "\"}"), 99));
        Reject(() => WitnessCodec.Parse(Array.Empty<byte>(), 99));
        foreach (var value in new[] { "relative", @"C:\root\..\escape", @"C:\root\file:ads", @"C:\root\file.", @"C:\root\file ", @"C:\root\CON.json", @"C:\root\\file", @"\\server\share\file", @"C:/root/file", @"c:\root\file", @"C:\root\*" })
            Reject(() => WitnessCodec.Absolute(value));
        WitnessCodec.Absolute(@"C:\"); WitnessCodec.Absolute(@"C:\Witness\main-enrollment.json"); count += 2;
        string revision = new string('a', 40), hash = new string('b', 64);
        string identity = $$"""{"repositoryId":"10","workflowSha":"{{revision}}","sourceRevision":"{{revision}}","version":"1.0.19","target":"win32-x64","runId":"20","runAttempt":"1"}""";
        string inputs = $$"""{"assetsDir":"C:\\Witness\\assets","signingOutputDir":"C:\\Witness\\signing","candidateFile":"C:\\Witness\\candidate.json","candidateSha256":"{{hash}}","evidenceFile":"C:\\Witness\\evidence.json","evidenceSha256":"{{hash}}","publicationRunId":"30","publicationRunAttempt":"1"}""";
        string enrollment = $$"""{"schema":1,"sourceRevision":"{{revision}}","planSha256":"{{hash}}","checkout":"C:\\Witness\\checkout","systemRoot":"C:\\Windows","machineTag":{"file":"C:\\Witness\\tag.json","sha256":"{{hash}}"},"collector":{"file":"C:\\Witness\\collector.exe","sha256":"{{hash}}"},"identity":{{identity}},"inputs":{{inputs}} }""";
        using var enrolled = Parse(enrollment);
        WitnessCodec.Enrollment(enrolled.RootElement, hash); ++count;
        foreach (var changed in new[] { enrollment.Replace("1.0.19", "1.0.20"), enrollment.Replace("1.0.19", "1.0.21"), enrollment.Replace("\"schema\":1", "\"schema\":1.0"), enrollment.Replace("\"schema\":1", "\"schema\":1,\"secret\":\"fixture\"") })
            Reject(() => { using var doc = Parse(changed); WitnessCodec.Enrollment(doc.RootElement, hash); });
        Reject(() => WitnessCodec.Enrollment(enrolled.RootElement, new string('c', 64)));
        string request = "{\"schema\":1,\"caseId\":\"preflight\",\"runNonce\":\"" + hash + "\",\"nonce\":\"" + new string('c', 64)
            + "\",\"sourceRevision\":\"" + revision + "\",\"identity\":" + identity + ",\"inputs\":" + inputs + "}";
        using var plan = Parse("{\"cases\":[{\"id\":\"preflight\"}]}");
        using var original = Parse(request);
        WitnessCodec.Request(original.RootElement, enrolled.RootElement, "preflight", plan.RootElement); ++count;
        foreach (var changed in new[] { request.Replace("preflight", "unknown"), request.Replace(new string('c', 64), hash), request.Replace("\"runId\":\"20\"", "\"runId\":\"21\""), request.Replace("\"publicationRunAttempt\":\"1\"", "\"publicationRunAttempt\":\"2\""), request.Replace("candidate.json", "substituted.json"), request.Replace("1.0.19", "1.0.20") })
            Reject(() => { using var doc = Parse(changed); WitnessCodec.Request(doc.RootElement, enrolled.RootElement, "preflight", plan.RootElement); });
        Reject(() => WitnessCodec.Request(original.RootElement, enrolled.RootElement, "cleanup", plan.RootElement));
        foreach (var name in new[] { "CI", "GITHUB_ACTIONS", "GITHUB_RUN_ID", "GITHUB_WORKFLOW", "GITHUB_JOB", "RUNNER_ENVIRONMENT", "TF_BUILD", "BUILD_BUILDID" })
        {
            var previous = Environment.GetEnvironmentVariable(name);
            try { Environment.SetEnvironmentVariable(name, "false"); Reject(WitnessCodec.WitnessEnvironment); }
            finally { Environment.SetEnvironmentVariable(name, previous); }
        }
        return count;
    }
}
