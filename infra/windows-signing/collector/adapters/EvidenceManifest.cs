// Manifest/verifier producer owner: Builder B; protected off-box pins and public-key custody owner: MAIN.
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text.Json;

namespace Murage.Witness
{
    public interface IEvidenceAuthenticator { void Verify(byte[] manifest, byte[] proof); }
    public sealed class UnenrolledEvidenceAuthenticator : IEvidenceAuthenticator
    {
        public void Verify(byte[] manifest, byte[] proof) => throw WitnessCodec.Reject("OBSERVATION_AUTH_UNENROLLED");
    }
    public sealed class PinnedManifestAuthenticator : IEvidenceAuthenticator
    {
        private readonly string protectedPin;
        public PinnedManifestAuthenticator(string protectedPin)
        {
            if (!WitnessCodec.Hex(protectedPin, 64)) throw WitnessCodec.Reject("MANIFEST_PIN");
            this.protectedPin = protectedPin;
        }
        public void Verify(byte[] manifest, byte[] proof)
        {
            if (proof.Length != 0 || HeldFile.Hash(manifest) != protectedPin) throw WitnessCodec.Reject("MANIFEST_AUTH");
        }
    }
    public sealed class PublicKeyManifestAuthenticator : IEvidenceAuthenticator, IDisposable
    {
        private readonly RSA key = RSA.Create();
        public PublicKeyManifestAuthenticator(byte[] protectedSubjectPublicKeyInfo)
        {
            try
            {
                key.ImportSubjectPublicKeyInfo(protectedSubjectPublicKeyInfo, out int read);
                if (read != protectedSubjectPublicKeyInfo.Length || key.KeySize < 3072) throw WitnessCodec.Reject("MANIFEST_KEY");
            }
            catch { key.Dispose(); throw; }
        }
        public void Verify(byte[] manifest, byte[] proof)
        {
            if (!key.VerifyData(manifest, proof, HashAlgorithmName.SHA256, RSASignaturePadding.Pss)) throw WitnessCodec.Reject("MANIFEST_AUTH");
        }
        public void Dispose() => key.Dispose();
    }
    public sealed record EvidenceFile(string Name, string Sha256, long Size);
    public static class EvidenceManifest
    {
        public static byte[] Json(Action<Utf8JsonWriter> write)
        {
            using var output = new MemoryStream();
            using (var writer = new Utf8JsonWriter(output)) { write(writer); writer.Flush(); }
            return output.ToArray();
        }
        public static void Binding(Utf8JsonWriter writer, OperationBinding binding)
        {
            writer.WriteStartObject("binding"); writer.WriteString("runNonce", binding.RunNonce); writer.WriteString("caseNonce", binding.CaseNonce);
            writer.WriteString("caseId", binding.CaseId); writer.WriteString("requestSha256", binding.RequestSha256); writer.WriteString("operationId", binding.OperationId); writer.WriteEndObject();
        }
        public static bool Matches(JsonElement value, OperationBinding binding)
        {
            WitnessCodec.Fields(value, "runNonce", "caseNonce", "caseId", "requestSha256", "operationId");
            return WitnessCodec.Text(value, "runNonce") == binding.RunNonce && WitnessCodec.Text(value, "caseNonce") == binding.CaseNonce
                && WitnessCodec.Text(value, "caseId") == binding.CaseId && WitnessCodec.Text(value, "requestSha256") == binding.RequestSha256
                && WitnessCodec.Text(value, "operationId") == binding.OperationId;
        }
        public static byte[] Create(OperationBinding binding, IEnumerable<EvidenceFile> files)
        {
            var rows = files.OrderBy(row => row.Name, StringComparer.Ordinal).ToArray();
            if (rows.Length == 0 || rows.Select(row => row.Name).Distinct(StringComparer.OrdinalIgnoreCase).Count() != rows.Length) throw WitnessCodec.Reject("MANIFEST_FILES");
            foreach (var row in rows)
            {
                if (row.Name != "result.json" && row.Name != "candidate.json" && row.Name != "evidence.json") CaptureWriter.Name(row.Name);
                if (!WitnessCodec.Hex(row.Sha256, 64) || row.Size <= 0 || row.Size > WitnessCodec.CaptureLimit) throw WitnessCodec.Reject("MANIFEST_FILES");
            }
            return Json(writer => {
                writer.WriteStartObject(); writer.WriteNumber("schema", 1); Binding(writer, binding); writer.WriteStartArray("files");
                foreach (var row in rows)
                {
                    writer.WriteStartObject(); writer.WriteString("name", row.Name); writer.WriteString("sha256", row.Sha256); writer.WriteNumber("size", row.Size); writer.WriteEndObject();
                }
                writer.WriteEndArray(); writer.WriteEndObject();
            });
        }
        public static void Verify(byte[] bytes, OperationBinding binding, IEvidenceAuthenticator authenticator, byte[] proof, Func<string, byte[]> read)
        {
            authenticator.Verify(bytes, proof);
            using var doc = WitnessCodec.Parse(bytes, 1024 * 1024); var value = doc.RootElement;
            WitnessCodec.Fields(value, "schema", "binding", "files");
            if (value.GetProperty("schema").GetRawText() != "1" || !Matches(value.GetProperty("binding"), binding)) throw WitnessCodec.Reject("MANIFEST_BINDING");
            var files = new List<EvidenceFile>();
            foreach (var row in value.GetProperty("files").EnumerateArray())
            {
                WitnessCodec.Fields(row, "name", "sha256", "size");
                var file = new EvidenceFile(WitnessCodec.Text(row, "name"), WitnessCodec.Text(row, "sha256"), row.GetProperty("size").GetInt64()); files.Add(file);
            }
            if (!bytes.SequenceEqual(Create(binding, files))) throw WitnessCodec.Reject("MANIFEST_CANONICAL");
            foreach (var file in files)
            {
                var actual = read(file.Name);
                if (actual.LongLength != file.Size || HeldFile.Hash(actual) != file.Sha256) throw WitnessCodec.Reject("MANIFEST_FILE_MISMATCH");
            }
        }
    }
}
