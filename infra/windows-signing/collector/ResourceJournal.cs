// Journal/recovery API owner: Builder A win-sac-sign-sa; case-runner caller owner: Builder B win-sac-sign-sb; protected store/deployment owner: MAIN.
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;

namespace Murage.Witness
{
    public sealed record OperationBinding(string RunNonce, string CaseNonce, string CaseId, string RequestSha256, string OperationId)
    {
        public void Validate()
        {
            if (!WitnessCodec.Hex(RunNonce, 64) || !WitnessCodec.Hex(CaseNonce, 64) || CaseNonce == RunNonce
                || !WitnessCodec.Hex(RequestSha256, 64) || !WitnessCodec.Hex(OperationId, 32)
                || String.IsNullOrEmpty(CaseId) || CaseId.Length > 128 || CaseId.Any(c => !(c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '-')))
                throw WitnessCodec.Reject("JOURNAL_BINDING");
        }
    }
    public sealed record RunResource(string Type, string Id, string Incarnation)
    {
        public void Validate()
        {
            if (!new[] { "process", "job", "lease", "capability", "file", "task", "service-state", "wfp-filter", "install", "vm", "os-disk", "data-disk", "nic" }.Contains(Type)
                || String.IsNullOrEmpty(Id) || Id.Length > 4096 || String.IsNullOrEmpty(Incarnation) || Incarnation.Length > 4096
                || Id.Any(Char.IsControl) || Incarnation.Any(Char.IsControl)) throw WitnessCodec.Reject("RESOURCE");
        }
    }
    public sealed class JournalState
    {
        internal sealed record Entry(RunResource Resource, OperationBinding Binding, bool Destroyed, bool Reaped);
        internal readonly Dictionary<string, Entry> Entries = new Dictionary<string, Entry>(StringComparer.Ordinal);
        internal readonly Dictionary<(string, string, string), int> Pending = new Dictionary<(string, string, string), int>();
        internal readonly HashSet<(string, string, string)> Finalized = new HashSet<(string, string, string)>();
        internal static string Key(RunResource r) => r.Type + "\0" + r.Id.ToUpperInvariant();
        internal static (string, string, string) Case(OperationBinding b) => (b.CaseNonce, b.CaseId, b.RequestSha256);
        public IReadOnlyList<RunResource> Created => Entries.Values.Select(e => e.Resource).ToArray();
        public IReadOnlyList<RunResource> Remaining => Entries.Values.Where(e => !e.Destroyed && !e.Reaped).Select(e => e.Resource).ToArray();
        public bool TornTail { get; internal set; }
        public bool RunFinalized { get; internal set; }
        public int Sequence { get; internal set; }
        public string Previous { get; internal set; } = new string('0', 64);
        public long Length { get; internal set; }
        internal int Outstanding;
        internal int CaseOutstanding;
    }
    public sealed class ResourceJournal : IDisposable
    {
        public const int Limit = 8 * 1024 * 1024;
        private readonly Stream file;
        private readonly string runNonce;
        private bool poisoned;
        public JournalState State { get; }
        public static ResourceJournal Open(string path, string runNonce)
        {
            if (!WitnessCodec.Hex(runNonce, 64)) throw WitnessCodec.Reject("JOURNAL_BINDING");
            var stream = new FileStream(path, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
            try { return new ResourceJournal(stream, runNonce); }
            catch { stream.Dispose(); throw; }
        }
        public ResourceJournal(FileStream file, string runNonce) : this((Stream)file, runNonce) { }
        internal ResourceJournal(Stream file, string runNonce)
        {
            if (!WitnessCodec.Hex(runNonce, 64) || !file.CanRead || !file.CanWrite || !file.CanSeek) throw WitnessCodec.Reject("JOURNAL");
            this.file = file; this.runNonce = runNonce;
            State = Read(file, runNonce);
            if (State.TornTail) throw WitnessCodec.Reject("JOURNAL_TORN");
        }
        private sealed record Row(int Sequence, string RunNonce, string Previous, string Event, RunResource Resource, OperationBinding Binding, string Reaper);
        private static Row Decode(byte[] bytes)
        {
            using var doc = WitnessCodec.Parse(bytes, 16 * 1024); var row = doc.RootElement;
            WitnessCodec.Fields(row, "schema", "sequence", "runNonce", "previous", "event", "resource", "binding");
            if (row.GetProperty("schema").GetRawText() != "1") throw WitnessCodec.Reject("JOURNAL_BINDING");
            RunResource resource = null;
            var value = row.GetProperty("resource");
            if (value.ValueKind != JsonValueKind.Null)
            {
                WitnessCodec.Fields(value, "type", "id", "incarnation");
                resource = new RunResource(WitnessCodec.Text(value, "type"), WitnessCodec.Text(value, "id"), WitnessCodec.Text(value, "incarnation"));
            }
            var binding = row.GetProperty("binding"); OperationBinding operation = null; string reaper = null;
            if (WitnessCodec.Text(row, "event") == "reaped")
            {
                WitnessCodec.Fields(binding, "reaper", "runNonce"); reaper = WitnessCodec.Text(binding, "reaper");
                if (WitnessCodec.Text(binding, "runNonce") != WitnessCodec.Text(row, "runNonce")) throw WitnessCodec.Reject("JOURNAL_BINDING_MISMATCH");
            }
            else
            {
                WitnessCodec.Fields(binding, "runNonce", "caseNonce", "caseId", "requestSha256", "operationId");
                operation = new OperationBinding(WitnessCodec.Text(binding, "runNonce"), WitnessCodec.Text(binding, "caseNonce"), WitnessCodec.Text(binding, "caseId"), WitnessCodec.Text(binding, "requestSha256"), WitnessCodec.Text(binding, "operationId"));
            }
            return new Row(row.GetProperty("sequence").GetInt32(), WitnessCodec.Text(row, "runNonce"), WitnessCodec.Text(row, "previous"), WitnessCodec.Text(row, "event"), resource, operation, reaper);
        }
        private static Action Apply(JournalState state, Row row, string runNonce, byte[] bytes)
        {
            if (row.Sequence != state.Sequence + 1 || row.RunNonce != runNonce || row.Previous != state.Previous || state.RunFinalized)
                throw WitnessCodec.Reject("JOURNAL_BINDING");
            if (row.Event == "reaped")
            {
                if (row.Reaper != "supervisor" && row.Reaper != "operator") throw WitnessCodec.Reject("JOURNAL_REAPER");
            }
            else
            {
                if (row.Binding == null) throw WitnessCodec.Reject("JOURNAL_BINDING");
                row.Binding.Validate();
                if (row.Binding.RunNonce != runNonce) throw WitnessCodec.Reject("JOURNAL_BINDING_MISMATCH");
                if (row.Event != "run-finalized" && state.Finalized.Contains(JournalState.Case(row.Binding))) throw WitnessCodec.Reject("CASE_FINALIZED");
            }
            Action transition;
            if (row.Event == "case-finalized" || row.Event == "run-finalized")
            {
                if (row.Resource != null || state.Pending.GetValueOrDefault(JournalState.Case(row.Binding)) != 0
                    || row.Event == "run-finalized" && (state.Outstanding != 0 || state.CaseOutstanding != 0)) throw WitnessCodec.Reject("RESOURCE_TRANSITION");
                transition = () => { state.Finalized.Add(JournalState.Case(row.Binding)); state.RunFinalized = row.Event == "run-finalized"; };
            }
            else
            {
                if (row.Resource == null) throw WitnessCodec.Reject("RESOURCE");
                row.Resource.Validate(); var key = JournalState.Key(row.Resource);
                state.Entries.TryGetValue(key, out var entry);
                if (row.Event == "registered")
                {
                    if (entry != null) throw WitnessCodec.Reject("RESOURCE_REPLAY");
                    transition = () =>
                    {
                        state.Entries.Add(key, new JournalState.Entry(row.Resource, row.Binding, false, false));
                        var caseKey = JournalState.Case(row.Binding); state.Pending[caseKey] = state.Pending.GetValueOrDefault(caseKey) + 1; ++state.Outstanding; ++state.CaseOutstanding;
                    };
                }
                else
                {
                    if (row.Event != "destroyed" && row.Event != "reaped" || entry == null || entry.Resource != row.Resource || entry.Destroyed || entry.Reaped)
                        throw WitnessCodec.Reject("RESOURCE_TRANSITION");
                    if (row.Event == "destroyed" && entry.Binding != row.Binding) throw WitnessCodec.Reject("JOURNAL_BINDING_MISMATCH");
                    transition = () =>
                    {
                        bool destroyed = row.Event == "destroyed";
                        state.Entries[key] = entry with { Destroyed = destroyed, Reaped = !destroyed }; --state.Outstanding;
                        // Reaping never satisfies the registering case's own destruction requirement.
                        if (destroyed) { --state.Pending[JournalState.Case(entry.Binding)]; --state.CaseOutstanding; }
                    };
                }
            }
            return () => { transition(); state.Sequence = row.Sequence; state.Previous = HeldFile.Hash(bytes); state.Length += bytes.Length + 1; };
        }
        public static JournalState Read(Stream file, string runNonce)
        {
            if (!WitnessCodec.Hex(runNonce, 64) || file.Length > Limit) throw WitnessCodec.Reject("JOURNAL");
            file.Position = 0; var bytes = new byte[(int)file.Length]; file.ReadExactly(bytes);
            var state = new JournalState(); int start = 0;
            for (int end = 0; end < bytes.Length; ++end)
            {
                if (bytes[end] != 10) continue;
                var line = bytes.AsSpan(start, end - start).ToArray(); start = end + 1;
                Apply(state, Decode(line), runNonce, line)();
            }
            state.TornTail = start != bytes.Length; return state;
        }
        public void Register(RunResource resource, OperationBinding binding) => Append("registered", resource, binding, null);
        public void ConfirmDestroyed(RunResource resource, OperationBinding binding) => Append("destroyed", resource, binding, null);
        public void Finalize(OperationBinding binding) => Append("case-finalized", null, binding, null);
        public void FinalizeRun(OperationBinding binding) => Append("run-finalized", null, binding, null);
        internal void ConfirmReaped(RunResource resource, string reaper) => Append("reaped", resource, null, reaper);
        private void Append(string action, RunResource resource, OperationBinding binding, string reaper)
        {
            if (poisoned) throw WitnessCodec.Reject("JOURNAL_POISONED");
            var row = new Row(State.Sequence + 1, runNonce, State.Previous, action, resource, binding, reaper);
            using var buffer = new MemoryStream();
            using (var writer = new Utf8JsonWriter(buffer))
            {
                writer.WriteStartObject(); writer.WriteNumber("schema", 1); writer.WriteNumber("sequence", row.Sequence);
                writer.WriteString("runNonce", runNonce); writer.WriteString("previous", row.Previous); writer.WriteString("event", action);
                if (resource == null) writer.WriteNull("resource");
                else
                {
                    writer.WriteStartObject("resource"); writer.WriteString("type", resource.Type); writer.WriteString("id", resource.Id); writer.WriteString("incarnation", resource.Incarnation); writer.WriteEndObject();
                }
                writer.WriteStartObject("binding"); writer.WriteString("runNonce", binding?.RunNonce ?? runNonce);
                if (reaper != null) writer.WriteString("reaper", reaper);
                else
                {
                    writer.WriteString("caseNonce", binding?.CaseNonce); writer.WriteString("caseId", binding?.CaseId);
                    writer.WriteString("requestSha256", binding?.RequestSha256); writer.WriteString("operationId", binding?.OperationId);
                }
                writer.WriteEndObject(); writer.WriteEndObject();
            }
            var bytes = buffer.ToArray();
            var transition = Apply(State, row, runNonce, bytes);
            if (bytes.Length > 16 * 1024 || State.Length + bytes.Length + 1 > Limit) throw WitnessCodec.Reject("JOURNAL_SIZE");
            try
            {
                if (file.Length != State.Length) { poisoned = true; throw WitnessCodec.Reject("JOURNAL_CHANGED"); }
                file.Position = State.Length; file.Write(bytes); file.WriteByte(10);
                if (file is FileStream disk) disk.Flush(true); else file.Flush();
                transition();
            }
            catch { poisoned = true; throw; }
        }
        public void Dispose() => file.Dispose();
    }
    public interface IResourceReaper
    {
        void Destroy(RunResource resource);
        bool Absent(RunResource resource);
    }
    public static class ResourceRecovery
    {
        private static void Failure(RunResource resource, string phase, Exception error = null)
        {
            string code = error == null ? "STILL_PRESENT" : error.GetType().Name;
            if (error is InvalidOperationException && System.Text.RegularExpressions.Regex.IsMatch(error.Message, @"\AWINDOWS_WITNESS_[A-Z_]+\z")) code = error.Message;
            Console.Error.WriteLine(JsonSerializer.Serialize(new { @event = "recovery-failed", resource = new { type = resource.Type, id = resource.Id, incarnation = resource.Incarnation }, phase, error = code }));
        }
        public static bool ConfirmAbsent(IEnumerable<RunResource> resources, ReaperRegistry registry)
        {
            bool complete = true;
            foreach (var resource in resources)
            {
                try { if (!registry.For(resource.Type).Absent(resource)) { complete = false; Failure(resource, "confirm-absent"); } }
                catch (Exception error) { complete = false; Failure(resource, "confirm-absent", error); }
            }
            return complete;
        }
        public static bool Reap(JournalState state, IResourceReaper reaper)
        {
            bool complete = !state.TornTail;
            foreach (var resource in state.Created.Reverse().OrderBy(r => r.Type == "task" && r.Id.EndsWith(@"\supervisor", StringComparison.OrdinalIgnoreCase) ? 1 : 0))
            {
                try
                {
                    if (!reaper.Absent(resource)) reaper.Destroy(resource);
                    if (!reaper.Absent(resource)) { complete = false; Failure(resource, "reap"); }
                }
                catch (Exception error) { complete = false; Failure(resource, "reap", error); }
            }
            return complete;
        }
    }
}
