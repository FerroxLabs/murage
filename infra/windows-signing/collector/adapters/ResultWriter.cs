// Result publication producer owner: Builder B; evidence retention consumer owner: MAIN.
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;

namespace Murage.Witness
{
    public sealed record CaseCapture(string Kind, string File, string Sha256, long Size);
    public sealed record AbsentResource(RunResource Resource, DateTimeOffset MeasuredAt);
    public interface ICollectionOutput : IDisposable
    {
        CaseCapture Capture(string kind, Stream bytes);
        void Publish(byte[] result, byte[] manifest);
    }
    public static class ResultWriter
    {
        public static byte[] Create(JsonElement request, JsonElement observed, IReadOnlyList<CaseCapture> captures, IReadOnlyList<AbsentResource> absent)
        {
            return EvidenceManifest.Json(writer => {
                writer.WriteStartObject();
                foreach (string name in new[] { "schema", "caseId", "runNonce", "nonce", "sourceRevision", "identity" }) { writer.WritePropertyName(name); request.GetProperty(name).WriteTo(writer); }
                writer.WriteString("status", "PASS"); writer.WritePropertyName("observed"); observed.WriteTo(writer); writer.WriteStartArray("captures");
                foreach (var capture in captures)
                {
                    writer.WriteStartObject(); writer.WriteString("kind", capture.Kind); writer.WriteString("file", capture.File); writer.WriteString("name", capture.File);
                    writer.WriteString("sha256", capture.Sha256); writer.WriteNumber("size", capture.Size); writer.WriteEndObject();
                }
                writer.WriteEndArray(); writer.WriteStartObject("resources");
                foreach (string name in new[] { "created", "destroyed" })
                {
                    writer.WriteStartArray(name); foreach (var entry in absent) { writer.WriteStartObject(); writer.WriteString("type", entry.Resource.Type); writer.WriteString("id", entry.Resource.Id); writer.WriteEndObject(); } writer.WriteEndArray();
                }
                writer.WriteStartArray("remaining"); writer.WriteEndArray(); writer.WriteEndObject();
                writer.WriteStartObject("cleanup"); writer.WriteStartArray("resources");
                foreach (var entry in absent)
                {
                    writer.WriteStartObject(); writer.WriteString("type", entry.Resource.Type); writer.WriteString("id", entry.Resource.Id);
                    writer.WriteString("incarnation", entry.Resource.Incarnation); writer.WriteString("absentMeasuredAt", entry.MeasuredAt); writer.WriteEndObject();
                }
                writer.WriteEndArray(); writer.WriteEndObject(); writer.WriteEndObject();
            });
        }
        public static void WriteExclusive(string path, byte[] bytes)
        {
            using var file = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.None); Write(file, bytes);
        }
        public static void Write(FileStream file, byte[] bytes) { file.Write(bytes); file.Flush(true); }
    }
    public sealed class DirectoryCollectionOutput : ICollectionOutput
    {
        private readonly string directory;
        private readonly CaptureWriter captures;
        private readonly List<HeldFile> held = new List<HeldFile>();
        public DirectoryCollectionOutput(string directory) { this.directory = directory; captures = new CaptureWriter(directory); }
        public CaseCapture Capture(string kind, Stream bytes)
        {
            var file = kind + ".json"; var capture = captures.Write(file, bytes); held.Add(capture);
            return new CaseCapture(kind, file, HeldFile.Hash(capture.Bytes), capture.Bytes.LongLength);
        }
        public void Publish(byte[] result, byte[] manifest)
        {
            string pending = Path.Combine(directory, ".result-" + Guid.NewGuid().ToString("N"));
            try
            {
                ResultWriter.WriteExclusive(pending, result);
                ResultWriter.WriteExclusive(Path.Combine(directory, "evidence-manifest.json"), manifest);
                File.Move(pending, Path.Combine(directory, "result.json"), false);
            }
            finally { if (File.Exists(pending)) File.Delete(pending); }
        }
        public void Dispose() { foreach (var file in held.AsEnumerable().Reverse()) file.Dispose(); captures.Dispose(); }
    }
}
