// Collector codec producer: win-sac-sign; sealed deployment/enrollment and observation consumer: MAIN.
using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Murage.Witness
{
    public static class WitnessCodec
    {
        public const int CaptureLimit = 128 * 1024 * 1024;
        public const int CaseMilliseconds = 20 * 60 * 1000;
        public static Exception Reject(string code) => new InvalidOperationException("WINDOWS_WITNESS_" + code);
        public static bool Hex(string value, int length) => value != null && value.Length == length && value.All(c => c >= '0' && c <= '9' || c >= 'a' && c <= 'f');
        public static JsonDocument Parse(byte[] bytes, int limit)
        {
            if (bytes.Length == 0 || bytes.Length > limit) throw Reject("INPUT_SIZE");
            var document = JsonDocument.Parse(bytes, new JsonDocumentOptions { MaxDepth = 32 });
            try { Unique(document.RootElement); return document; }
            catch { document.Dispose(); throw; }
        }
        private static void Unique(JsonElement value)
        {
            if (value.ValueKind == JsonValueKind.Object)
            {
                var names = new HashSet<string>(StringComparer.Ordinal);
                foreach (var property in value.EnumerateObject())
                {
                    if (!names.Add(property.Name)) throw Reject("DUPLICATE_FIELD");
                    Unique(property.Value);
                }
            }
            else if (value.ValueKind == JsonValueKind.Array) foreach (var child in value.EnumerateArray()) Unique(child);
        }
        public static void Fields(JsonElement value, params string[] fields)
        {
            if (value.ValueKind != JsonValueKind.Object || !value.EnumerateObject().Select(p => p.Name).OrderBy(n => n, StringComparer.Ordinal)
                .SequenceEqual(fields.OrderBy(n => n, StringComparer.Ordinal))) throw Reject("FIELDS");
        }
        public static string Text(JsonElement value, string name)
        {
            var field = value.GetProperty(name);
            if (field.ValueKind != JsonValueKind.String) throw Reject("TYPE");
            return field.GetString();
        }
        public static void Absolute(string value)
        {
            if (value == null || !Regex.IsMatch(value, @"\A[A-Z]:\\") || value.Length > 32700) throw Reject("PATH");
            if (value.Length == 3) return;
            foreach (var part in value.Substring(3).Split('\\'))
                if (String.IsNullOrEmpty(part) || part == "." || part == ".." || part.EndsWith(".") || part.EndsWith(" ")
                    || part.Any(c => c < 32 || "<>:\"/|?*".Contains(c))
                    || Regex.IsMatch(part, @"\A(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|\z)", RegexOptions.IgnoreCase)) throw Reject("PATH");
        }
        private static void Schema(JsonElement value) { if (value.GetProperty("schema").GetRawText() != "1") throw Reject("SCHEMA"); }
        public static void Identity(JsonElement value, string revision)
        {
            Fields(value, "repositoryId", "workflowSha", "sourceRevision", "version", "target", "runId", "runAttempt");
            foreach (var name in new[] { "repositoryId", "runId", "runAttempt" })
                if (!Regex.IsMatch(Text(value, name), @"\A[1-9][0-9]*\z")) throw Reject("IDENTITY");
            if (!Hex(revision, 40) || Text(value, "sourceRevision") != revision || !Hex(Text(value, "workflowSha"), 40)
                || Text(value, "version") != "1.0.19" || Text(value, "target") != "win32-x64") throw Reject("IDENTITY");
        }
        public static void Inputs(JsonElement value)
        {
            Fields(value, "assetsDir", "signingOutputDir", "candidateFile", "candidateSha256", "evidenceFile", "evidenceSha256", "publicationRunId", "publicationRunAttempt");
            foreach (var name in new[] { "assetsDir", "signingOutputDir", "candidateFile", "evidenceFile" }) Absolute(Text(value, name));
            foreach (var name in new[] { "candidateSha256", "evidenceSha256" }) if (!Hex(Text(value, name), 64)) throw Reject("PIN");
            foreach (var name in new[] { "publicationRunId", "publicationRunAttempt" })
                if (!Regex.IsMatch(Text(value, name), @"\A[1-9][0-9]*\z")) throw Reject("IDENTITY");
        }
        public static void Enrollment(JsonElement value, string planSha256)
        {
            var fields = new[] { "schema", "sourceRevision", "planSha256", "checkout", "systemRoot", "machineTag", "collector", "identity", "inputs" };
            Fields(value, value.TryGetProperty("adapters", out var adapters) ? fields.Append("adapters").ToArray() : fields);
            SeamStatus.Validate(SeamStatus.Adapters(value));
            Schema(value);
            Identity(value.GetProperty("identity"), Text(value, "sourceRevision")); Inputs(value.GetProperty("inputs"));
            if (!Hex(planSha256, 64) || Text(value, "planSha256") != planSha256) throw Reject("PLAN_DIGEST");
            Absolute(Text(value, "checkout")); Absolute(Text(value, "systemRoot"));
            foreach (var name in new[] { "machineTag", "collector" })
            {
                var pin = value.GetProperty(name); Fields(pin, "file", "sha256"); Absolute(Text(pin, "file"));
                if (!Hex(Text(pin, "sha256"), 64)) throw Reject("PIN");
            }
            if (!Text(value.GetProperty("collector"), "file").EndsWith(".exe", StringComparison.OrdinalIgnoreCase)) throw Reject("NATIVE_COLLECTOR_REQUIRED");
        }
        public static bool Equal(JsonElement a, JsonElement b)
        {
            if (a.ValueKind != b.ValueKind) return false;
            if (a.ValueKind == JsonValueKind.Object) return a.EnumerateObject().Count() == b.EnumerateObject().Count()
                && a.EnumerateObject().All(p => b.TryGetProperty(p.Name, out var other) && Equal(p.Value, other));
            if (a.ValueKind == JsonValueKind.Array) return a.GetArrayLength() == b.GetArrayLength()
                && a.EnumerateArray().Zip(b.EnumerateArray(), Equal).All(equal => equal);
            return a.ValueKind == JsonValueKind.String ? a.GetString() == b.GetString() : a.GetRawText() == b.GetRawText();
        }
        public static void Request(JsonElement request, JsonElement enrollment, string caseId, JsonElement plan)
        {
            Fields(request, "schema", "caseId", "runNonce", "nonce", "sourceRevision", "identity", "inputs"); Schema(request);
            if (Text(request, "caseId") != caseId || !plan.GetProperty("cases").EnumerateArray().Any(c => Text(c, "id") == caseId)
                || !Hex(Text(request, "runNonce"), 64) || !Hex(Text(request, "nonce"), 64)
                || Text(request, "runNonce") == Text(request, "nonce") || Text(request, "sourceRevision") != Text(enrollment, "sourceRevision")
                || !Equal(request.GetProperty("identity"), enrollment.GetProperty("identity"))
                || !Equal(request.GetProperty("inputs"), enrollment.GetProperty("inputs"))) throw Reject("REQUEST_BINDING");
        }
        public static void WitnessEnvironment()
        {
            foreach (var name in new[] { "CI", "GITHUB_ACTIONS", "GITHUB_RUN_ID", "GITHUB_WORKFLOW", "GITHUB_JOB", "RUNNER_ENVIRONMENT", "TF_BUILD", "BUILD_BUILDID" })
                if (Environment.GetEnvironmentVariable(name) != null) throw Reject("WITNESS_IN_CI");
        }
    }
}
