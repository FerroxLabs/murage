// Workflow collector producer owner: Builder B; authenticated installed-candidate measurements and protected pins owner: MAIN.
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Threading;

namespace Murage.Witness
{
    public sealed record AssetsRequest(string Assets, string SigningOutput, string Source, string Output);
    public sealed record MeasuredPe(string Path, byte[] Bytes, string LeafDerSha256, bool NativeValid, bool Embedded, bool SigntoolValid);
    public sealed record AssetsObservation(OperationBinding Binding, JsonElement Candidate, JsonElement Evidence, IReadOnlyList<MeasuredPe> Installed,
        IReadOnlyDictionary<string, byte[]> Captures, SacInterval Sac, int AcceptedBuild, int AcceptedUbr, string PolicyId, string PolicySha256);
    // This interface deliberately exposes reads only; no fault, revoke, stop or destroy operation exists.
    public interface IAssetsMeasurements
    {
        AssetsObservation Measure(AssetsRequest request, OperationBinding binding, CancellationToken cancellation);
        IReadOnlyDictionary<string, byte[]> ReadAssets(string directory);
    }
    public static class AssetsCollector
    {
        public static AssetsRequest Arguments(string[] args)
        {
            if (args.Length != 8 || args[0] != "--assets" || args[2] != "--signing-output" || args[4] != "--source" || args[6] != "--output"
                || !WitnessCodec.Hex(args[5], 40)) throw WitnessCodec.Reject("USAGE");
            foreach (int index in new[] { 1, 3, 7 }) WitnessCodec.Absolute(args[index]);
            if (args[7] == args[1] || args[7] == args[3]) throw WitnessCodec.Reject("OUTPUT_PATH");
            return new AssetsRequest(args[1], args[3], args[5], args[7]);
        }
        public static bool IsPe(string name, byte[] bytes) => name.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) || name.EndsWith(".dll", StringComparison.OrdinalIgnoreCase)
            || name.EndsWith(".node", StringComparison.OrdinalIgnoreCase) || name.EndsWith(".pyd", StringComparison.OrdinalIgnoreCase) || bytes.Length >= 2 && bytes[0] == 77 && bytes[1] == 90;
        public static void FilePath(string name)
        {
            if (String.IsNullOrEmpty(name) || name.Contains('\\') || name.Contains(':') || name.StartsWith('/')) throw WitnessCodec.Reject("INVENTORY_PATH");
            WitnessCodec.Absolute(@"C:\Inventory\" + name.Replace('/', '\\'));
        }
        internal static void Collect(AssetsRequest request, IAssetsMeasurements measurements, OperationBinding binding, IEvidenceAuthenticator authenticator,
            byte[] authenticationProof, Action<string, byte[]> writeExclusive)
        {
            using var budget = new CancellationTokenSource(WitnessCodec.CaseMilliseconds); var cancellation = budget.Token;
            var before = measurements.ReadAssets(request.Assets); var observation = measurements.Measure(request, binding, cancellation);
            if (observation.Binding != binding) throw WitnessCodec.Reject("OBSERVATION_BINDING");
            var candidate = observation.Candidate; var evidence = observation.Evidence;
            foreach (var document in new[] { candidate, evidence })
            {
                if (document.GetProperty("schema").GetRawText() != "1" || WitnessCodec.Text(document, "sourceRevision") != request.Source) throw WitnessCodec.Reject("IDENTITY");
                foreach (var name in new[] { "sourceRevision", "version", "target", "runId", "runAttempt" })
                    if (WitnessCodec.Text(candidate, name) != WitnessCodec.Text(evidence, name)) throw WitnessCodec.Reject("IDENTITY");
            }
            var paths = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            var peHashes = new List<string>();
            foreach (var pe in observation.Installed)
            {
                FilePath(pe.Path);
                if (!paths.Add(pe.Path) || !IsPe(pe.Path, pe.Bytes) || pe.Bytes.Length < 2 || pe.Bytes[0] != 77 || pe.Bytes[1] != 90
                    || !pe.NativeValid || !pe.Embedded || !pe.SigntoolValid || !WitnessCodec.Hex(pe.LeafDerSha256, 64)) throw WitnessCodec.Reject("PE_TRUST");
                var rows = candidate.GetProperty("files").EnumerateArray().Where(row => WitnessCodec.Text(row, "path") == pe.Path).ToArray();
                if (rows.Length != 1 || WitnessCodec.Text(rows[0], "sha256") != HeldFile.Hash(pe.Bytes)) throw WitnessCodec.Reject("INVENTORY_MISMATCH");
                peHashes.Add(HeldFile.Hash(pe.Bytes));
            }
            if (paths.Count == 0 || candidate.GetProperty("files").GetArrayLength() != paths.Count || !WitnessCodec.Equal(candidate.GetProperty("files"), evidence.GetProperty("files"))) throw WitnessCodec.Reject("INVENTORY_MISMATCH");
            SacAdapter.Evaluate(observation.Sac, observation.AcceptedBuild, observation.AcceptedUbr, observation.PolicyId, observation.PolicySha256, peHashes);
            var after = measurements.ReadAssets(request.Assets);
            var assetRows = candidate.GetProperty("assets").EnumerateArray().ToArray();
            if (before.Count == 0 || before.Count != after.Count || assetRows.Length != before.Count || assetRows.Select(row => WitnessCodec.Text(row, "path")).Distinct(StringComparer.OrdinalIgnoreCase).Count() != assetRows.Length) throw WitnessCodec.Reject("ASSET_SET_MISMATCH");
            foreach (var asset in before)
            {
                FilePath(asset.Key);
                if (asset.Key.Contains('/') || !after.TryGetValue(asset.Key, out var actual) || HeldFile.Hash(actual) != HeldFile.Hash(asset.Value)
                    || !assetRows.Any(row => WitnessCodec.Text(row, "path") == asset.Key && WitnessCodec.Text(row, "sha256") == HeldFile.Hash(actual))) throw WitnessCodec.Reject("ASSET_SET_MISMATCH");
            }
            var files = new SortedDictionary<string, byte[]>(StringComparer.Ordinal);
            foreach (var capture in observation.Captures) { CaptureWriter.Name(capture.Key); files.Add(capture.Key, capture.Value); }
            files.Add("pe-leaves.json", EvidenceManifest.Json(writer => {
                writer.WriteStartObject(); writer.WriteNumber("schema", 1); EvidenceManifest.Binding(writer, binding); writer.WriteStartArray("files");
                foreach (var pe in observation.Installed.OrderBy(pe => pe.Path, StringComparer.Ordinal))
                {
                    writer.WriteStartObject(); writer.WriteString("path", pe.Path); writer.WriteString("sha256", HeldFile.Hash(pe.Bytes));
                    writer.WriteString("leafDerSha256", pe.LeafDerSha256); writer.WriteEndObject();
                }
                writer.WriteEndArray(); writer.WriteEndObject();
            }));
            files.Add("candidate.json", EvidenceManifest.Json(writer => candidate.WriteTo(writer)));
            if (WitnessCodec.Text(evidence, "candidateSha256") != HeldFile.Hash(files["candidate.json"])) throw WitnessCodec.Reject("CANDIDATE_BINDING");
            files.Add("evidence.json", EvidenceManifest.Json(writer => evidence.WriteTo(writer)));
            var manifest = EvidenceManifest.Create(binding, files.Select(file => new EvidenceFile(file.Key, HeldFile.Hash(file.Value), file.Value.Length)));
            authenticator.Verify(manifest, authenticationProof);
            cancellation.ThrowIfCancellationRequested();
            foreach (var file in files) writeExclusive(file.Key, file.Value);
            writeExclusive("evidence-manifest.json", manifest);
        }
    }
}
