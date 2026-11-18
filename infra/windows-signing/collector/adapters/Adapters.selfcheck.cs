// Test-double producer owner: Builder B; test execution/evidence consumer owner: MAIN. Excluded from production compilation.
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Xml.Linq;
using Murage.Witness;

public static class AdapterChecks
{
    private static int count;
    private static string fixtures;
    private static string scratch;
    private static JsonElement plan, measurements, requiredSteps;
    private static string H(char c, int n = 64) => new string(c, n);
    private static JsonElement J(string value) { using var doc = WitnessCodec.Parse(Encoding.UTF8.GetBytes(value), WitnessCodec.CaptureLimit); return doc.RootElement.Clone(); }
    private static void Check(bool value, [System.Runtime.CompilerServices.CallerLineNumber] int line = 0) { if (!value) throw new Exception("ADAPTER_MUTANT_SURVIVED line=" + line); ++count; }
    private static void Reject(Action action, string code = null)
    {
        try { action(); }
        catch (InvalidOperationException error) { if (code != null) Check(error.Message == code); ++count; return; }
        catch (JsonException) { Check(code == null); ++count; return; }
        throw new Exception("ADAPTER_MUTANT_SURVIVED");
    }
    private static OperationBinding Binding => new OperationBinding(H('a'), H('b'), "preflight", H('c'), H('d', 32));
    private static JsonElement Adapters(string unaccepted = null) => J("{" + String.Join(",", SeamStatus.Names.Select(name => "\"" + name + "\":" + (name == unaccepted ? "\"unaccepted\"" : "{\"accepted\":\"FIXTURE-RULING\",\"sha256\":\"" + H('e') + "\"}"))) + "}");
    private static JsonElement Enrollment(JsonElement adapters) => J("{\"sourceRevision\":\"" + H('f', 40) + "\",\"identity\":{\"version\":\"1.0.19\",\"runId\":\"10\"},\"inputs\":{},\"adapters\":" + adapters.GetRawText() + "}");
    private static byte[] Request(string id, string nonce = null) => Encoding.UTF8.GetBytes("{\"schema\":1,\"caseId\":\"" + id + "\",\"runNonce\":\"" + H('a') + "\",\"nonce\":\"" + (nonce ?? H('b')) + "\",\"sourceRevision\":\"" + H('f', 40) + "\",\"identity\":{\"version\":\"1.0.19\",\"runId\":\"10\"},\"inputs\":{}}");
    private sealed class Duplex : Stream
    {
        private readonly MemoryStream incoming;
        public readonly MemoryStream Sent = new MemoryStream();
        public Duplex(byte[] bytes) { incoming = new MemoryStream(bytes); }
        public override bool CanRead => true;
        public override bool CanWrite => true;
        public override bool CanSeek => false;
        public override long Length => incoming.Length;
        public override long Position { get => incoming.Position; set => throw new NotSupportedException(); }
        public override int Read(byte[] b, int o, int n) => incoming.Read(b, o, Math.Min(n, 3));
        public override void Write(byte[] b, int o, int n) => Sent.Write(b, o, n);
        public override void Flush() { }
        public override long Seek(long o, SeekOrigin s) => throw new NotSupportedException();
        public override void SetLength(long n) => throw new NotSupportedException();
    }
    private sealed class Peer : IObservationPeer
    {
        public bool Trusted = true, Disposed;
        public int Reads;
        public Stream Wire = System.IO.Stream.Null;
        public Stream Stream { get { ++Reads; return Wire; } }
        public long Authenticate() => Trusted ? 123 : throw WitnessCodec.Reject("OBSERVER_PEER");
        public void Dispose() { Disposed = true; }
    }
    private static byte[] Response(OperationBinding binding, long sequence = 1) => EvidenceManifest.Json(writer => {
        writer.WriteStartObject(); EvidenceManifest.Binding(writer, binding); writer.WriteNumber("sequence", sequence); writer.WriteNumber("observerCreation", 123);
        writer.WriteStartObject("measurement"); writer.WriteBoolean("acted", true); writer.WriteEndObject(); writer.WriteEndObject();
    });
    private static byte[] Frames(params JsonElement[] measurements)
    {
        using var output = new MemoryStream(); long sequence = 0;
        foreach (var value in measurements)
        {
            var bytes = EvidenceManifest.Json(writer => {
                writer.WriteStartObject(); EvidenceManifest.Binding(writer, Binding); writer.WriteNumber("sequence", ++sequence); writer.WriteNumber("observerCreation", 123);
                writer.WritePropertyName("measurement"); value.WriteTo(writer); writer.WriteEndObject();
            });
            output.Write(BitConverter.GetBytes(bytes.Length)); output.Write(bytes);
        }
        return output.ToArray();
    }
    private static SacSnapshot Snapshot(string kind = "DWord", string state = "1", string toolSha256 = null, string argv = null)
    {
        var build = J("{\"build\":26100,\"ubr\":100,\"boot\":\"neutral-boot\"}");
        var policy = J("{\"kind\":\"" + kind + "\",\"state\":" + state + "}");
        var policies = J("{\"toolSha256\":\"" + (toolSha256 ?? H('a')) + "\",\"argv\":" + (argv ?? "[\"--list-policies\",\"--json\"]") + ",\"policies\":[{\"id\":\"neutral-policy\",\"sha256\":\"" + H('a') + "\",\"enforced\":true}],\"capacity\":1048576,\"retention\":true}");
        var flow = new Duplex(Frames(build, policy, policies));
        using var channel = new ObservationChannel(new Peer { Wire = flow });
        var snapshot = SacAdapter.Snapshot(channel, Binding, H('a'), CancellationToken.None);
        using var sent = new MemoryStream(flow.Sent.ToArray());
        foreach (string verb in new[] { "ci-build", "ci-policy-state", "ci-policies" })
        {
            var prefix = new byte[4]; sent.ReadExactly(prefix); var bytes = new byte[BitConverter.ToInt32(prefix)]; sent.ReadExactly(bytes);
            using var doc = WitnessCodec.Parse(bytes, WitnessCodec.CaptureLimit); Check(WitnessCodec.Text(doc.RootElement, "verb") == verb);
        }
        Check(sent.Position == sent.Length); return snapshot;
    }
    private sealed class FlushFile : FileStream
    {
        public bool Durable;
        public FlushFile(string path) : base(path, FileMode.CreateNew, FileAccess.Write, FileShare.None) { }
        public override void Flush(bool flushToDisk) { Durable = flushToDisk; base.Flush(flushToDisk); }
    }
    private sealed class Reaper : IResourceReaper
    {
        public readonly HashSet<RunResource> Live = new HashSet<RunResource>();
        public int Queries;
        public bool Resurrect;
        public void Destroy(RunResource r) => throw new Exception("case must restore before independent absence check");
        public bool Absent(RunResource r) { ++Queries; return !Resurrect && !Live.Contains(r); }
    }
    private sealed class Output : ICollectionOutput
    {
        public readonly Dictionary<string, byte[]> Files = new Dictionary<string, byte[]>();
        public bool FailCapture, FailFlush, FailPublish;
        public CaseCapture Capture(string kind, Stream bytes)
        {
            if (FailCapture) throw WitnessCodec.Reject("CAPTURE_FAILED");
            using var buffer = new MemoryStream(); string hash = CaptureWriter.Copy(bytes, buffer); var data = buffer.ToArray(); Files.Add(kind + ".json", data);
            return new CaseCapture(kind, kind + ".json", hash, data.Length);
        }
        public void Publish(byte[] result, byte[] manifest)
        {
            if (FailFlush) throw WitnessCodec.Reject("RESULT_FLUSH");
            Files.Add("evidence-manifest.json", manifest);
            if (FailPublish) throw WitnessCodec.Reject("RESULT_PUBLISH");
            Files.Add("result.json", result);
        }
        public void Dispose() { }
    }
    private sealed class Operations : ICaseOperations
    {
        private readonly string id;
        private readonly Reaper reaper;
        public bool Armed, Begun, SkipEffect, BadBinding, DirtyInput, FailFinalize, FailRestore, BadMeasurement;
        public ResourceJournal Journal;
        public int Finalized, InputChecks;
        public readonly List<string> Acted = new List<string>();
        public readonly List<OperationBinding> Bindings = new List<OperationBinding>();
        private readonly Dictionary<OperationBinding, RunResource> resources = new Dictionary<OperationBinding, RunResource>();
        private readonly HashSet<OperationBinding> exclusive = new HashSet<OperationBinding>();
        public Operations(string id, Reaper reaper) { this.id = id; this.reaper = reaper; }
        public void ArmSupervisor(OperationBinding b, CancellationToken c) { Armed = true; }
        public void Begin(OperationBinding b, CancellationToken c) { if (!Armed) throw WitnessCodec.Reject("SUPERVISOR_NOT_ARMED"); Begun = true; }
        public IReadOnlyList<RunResource> Reserve(CaseStep step, OperationBinding b, CancellationToken c)
        {
            if (!Begun) throw WitnessCodec.Reject("OBSERVATION_NOT_BEGUN");
            var r = new RunResource("file", b.OperationId, "neutral-generation"); resources.Add(b, r); Bindings.Add(b); return new[] { r };
        }
        public void AssertExclusive(CaseStep s, OperationBinding b, IReadOnlyList<RunResource> r, CancellationToken c) { exclusive.Add(b); }
        public void Act(CaseStep step, OperationBinding b, CancellationToken c)
        {
            if (step.Exclusive && !exclusive.Contains(b)) throw WitnessCodec.Reject("EXCLUSIVITY_UNPROVEN_R_COL_10");
            var r = resources[b];
            // Replaying the live journal independently proves registration precedes the effect.
            var state = Journal.State;
            if (!state.Created.Contains(r)) throw WitnessCodec.Reject("ACT_BEFORE_REGISTER");
            if (!SkipEffect) { reaper.Live.Add(r); Acted.Add(step.Name); }
        }
        public BoundObservation Observe(CaseStep s, OperationBinding b, CancellationToken c)
        {
            if (!reaper.Live.Contains(resources[b])) throw WitnessCodec.Reject("EFFECT_NOT_MEASURED");
            return new BoundObservation(BadBinding ? b with { CaseNonce = H('e') } : b, J("{\"measured\":true}"));
        }
        public void Restore(CaseStep s, OperationBinding b, CancellationToken c) { if (FailRestore) throw WitnessCodec.Reject("RESTORE_FAILED"); reaper.Live.Remove(resources[b]); }
        public BoundObservation Complete(OperationBinding b, CancellationToken c)
        {
            if (!Acted.SequenceEqual(requiredSteps.GetProperty(id).EnumerateArray().Select(step => step.GetString()))) throw WitnessCodec.Reject("VARIANTS_INCOMPLETE");
            var values = measurements.GetProperty(id);
            if (BadMeasurement) values = J("{}");
            return new BoundObservation(b, values);
        }
        public Stream Capture(string kind, OperationBinding b, CancellationToken c) => new MemoryStream(Response(b));
        public void Finalize(OperationBinding b) { if (FailFinalize) throw WitnessCodec.Reject("FINALIZE_FAILED"); ++Finalized; }
        public void AssertEnrolledInputsUnchanged() { ++InputChecks; if (DirtyInput) throw WitnessCodec.Reject("ENROLLED_INPUT_CHANGED_R_COL_12"); }
    }
    private static void ResetJournal() { string path = Path.Combine(scratch, "journal"); if (File.Exists(path)) File.Delete(path); }
    private static Output RunCase(string id, Action<Operations, Reaper, Output> configure = null, JsonElement? enrollment = null, byte[] request = null)
    {
        ResetJournal(); var reaper = new Reaper(); var operations = new Operations(id, reaper); var output = new Output(); configure?.Invoke(operations, reaper, output);
        var enrolled = enrollment ?? Enrollment(Adapters()); var requestBytes = request ?? Request(id);
        using (var admitted = WitnessCodec.Parse(requestBytes, 8 * 1024 * 1024)) WitnessCodec.Request(admitted.RootElement, enrolled, id, plan);
        SeamStatus.Require(id, SeamStatus.Adapters(enrolled));
        using var journal = ResourceJournal.Open(Path.Combine(scratch, "journal"), H('a')); operations.Journal = journal;
        CaseRunner.Run(requestBytes, enrolled, plan, id, journal, operations, new ReaperRegistry().Add("file", reaper), output);
        Check(operations.Armed && operations.Begun && operations.Acted.Count == requiredSteps.GetProperty(id).GetArrayLength() && operations.Finalized == operations.Acted.Count + 1);
        Check(reaper.Queries >= operations.Acted.Count * 2 && reaper.Live.Count == 0);
        Check(operations.Bindings.Select(b => b.OperationId).Distinct().Count() == operations.Bindings.Count);
        if (id == "locked-build") Check(operations.InputChecks == operations.Acted.Count * 2);
        using var result = WitnessCodec.Parse(output.Files["result.json"], WitnessCodec.CaptureLimit);
        Check(WitnessCodec.Text(result.RootElement, "status") == "PASS" && WitnessCodec.Text(result.RootElement, "caseId") == id);
        using (var requested = WitnessCodec.Parse(requestBytes, 8 * 1024 * 1024))
            foreach (string name in new[] { "schema", "caseId", "runNonce", "nonce", "sourceRevision", "identity" }) Check(WitnessCodec.Equal(result.RootElement.GetProperty(name), requested.RootElement.GetProperty(name)));
        Check(WitnessCodec.Equal(result.RootElement.GetProperty("observed"), measurements.GetProperty(id)));
        foreach (var row in result.RootElement.GetProperty("captures").EnumerateArray()) Check(HeldFile.Hash(output.Files[WitnessCodec.Text(row, "file")]) == WitnessCodec.Text(row, "sha256"));
        return output;
    }
    private static SacInterval Interval()
    {
        var snapshot = new SacSnapshot(26100, 100, 1, "neutral-boot", new[] { new SacPolicy("neutral-policy", H('a'), true) }, 1024 * 1024, true);
        var start = DateTimeOffset.Parse("2026-01-01T00:00:00Z");
        var record = SacAdapter.ParseEvent(File.ReadAllText(Path.Combine(fixtures, "ci.xml")));
        return new SacInterval(snapshot, snapshot, 100, 101, start, start.AddSeconds(2), new[] { record }, true, true, false, false);
    }
    private static void Evaluate(SacInterval interval) => SacAdapter.Evaluate(interval, 26100, 100, "neutral-policy", H('a'), new[] { H('a') });
    private static TokenMeasurement Standard() => TokenObserver.Parse(J(File.ReadAllText(Path.Combine(fixtures, "token.json"))));
    private static S4Measurement S4()
    {
        var fail = new ProcessIdentity(10, 100, H('a'), @"C:\Installed\Murage.exe"); return new S4Measurement(fail, fail, new ProcessIdentity(20, 200, H('a'), @"C:\Installed\Murage.exe"), new ProcessIdentity(30, 300, H('b'), @"C:\Witness\collector.exe"),
            "OpenProcessToken", 0x28, false, 5, "EPOWER", false, false, true, Standard(), true, fail, false);
    }
    private sealed class S4Api : IS4ProcessApi
    {
        public string ChildToken = "child";
        public bool Denied, Resumed, Terminated, Elevated, Contained, CrashDuringCreate, Live;
        public void ArmContainment() { Contained = true; }
        public void CollectorDied() { if (Contained) Live = false; }
        public void AssertStandardCaller() { if (Elevated) throw WitnessCodec.Reject("S4_CALLER_NOT_STANDARD"); }
        public ProcessIdentity CreateSuspended()
        {
            Live = true;
            if (CrashDuringCreate) { CollectorDied(); throw WitnessCodec.Reject("S4_CREATION_CRASH"); }
            return new ProcessIdentity(10, 100, H('a'), @"C:\Installed\Murage.exe");
        }
        public string PrimaryTokenId(ProcessIdentity p) => p.Pid == 10 ? ChildToken : "token-" + p.Pid;
        public void DenyOwnAdjustPrivilege(ProcessIdentity p) { Denied = true; }
        public void Resume(ProcessIdentity p) { if (!Denied) throw WitnessCodec.Reject("S4_NOT_DENIED"); Resumed = true; }
        public void Terminate(ProcessIdentity p) { Terminated = true; }
    }
    private sealed class Assets : IAssetsMeasurements
    {
        public bool Rewritten = false, FaultReached = false;
        public AssetsObservation Observation;
        public readonly byte[] Pe = { 77, 90, 0, 1 };
        public AssetsObservation Measure(AssetsRequest request, OperationBinding binding, CancellationToken c) => Observation with { Binding = binding };
        public IReadOnlyDictionary<string, byte[]> ReadAssets(string directory) => new Dictionary<string, byte[]> { { "neutral.exe", Rewritten ? new byte[] { 77, 90, 1, 2 } : Pe } };
    }
    private static Assets Workflow()
    {
        var assets = new Assets(); string hash = HeldFile.Hash(assets.Pe);
        var candidate = J("{\"schema\":1,\"sourceRevision\":\"" + H('f', 40) + "\",\"version\":\"1.0.19\",\"target\":\"win32-x64\",\"runId\":\"10\",\"runAttempt\":\"1\",\"files\":[{\"path\":\"neutral.image\",\"sha256\":\"" + hash + "\"}],\"assets\":[{\"path\":\"neutral.exe\",\"sha256\":\"" + hash + "\"}]}");
        string candidateHash = HeldFile.Hash(EvidenceManifest.Json(writer => candidate.WriteTo(writer)));
        var evidence = J(candidate.GetRawText().TrimEnd('}') + ",\"candidateSha256\":\"" + candidateHash + "\"}");
        assets.Observation = new AssetsObservation(Binding, candidate, evidence, new[] { new MeasuredPe("neutral.image", assets.Pe, H('a'), true, true, true) },
            new Dictionary<string, byte[]> { { "policy.json", Encoding.UTF8.GetBytes("neutral-policy-capture") } }, Interval(), 26100, 100, "neutral-policy", H('a'));
        return assets;
    }
    private sealed class PinAfterMeasure : IEvidenceAuthenticator
    {
        public void Verify(byte[] manifest, byte[] proof) { new PinnedManifestAuthenticator(HeldFile.Hash(manifest)).Verify(manifest, proof); }
    }
    public static int Run(string group, string fixtureDirectory, string scratchDirectory, string planFile, string project)
    {
        count = 0; fixtures = fixtureDirectory; scratch = scratchDirectory;
        plan = J(File.ReadAllText(planFile)); measurements = J(File.ReadAllText(Path.Combine(fixtures, "measurements.json")));
        requiredSteps = J(File.ReadAllText(Path.Combine(fixtures, "steps.json")));
        Directory.CreateDirectory(scratch);
        if (group == "all" || group == "M-B1")
        {
            Check(SeamStatus.Cases.Length == 21 && requiredSteps.EnumerateObject().Count() == 21);
            foreach (string id in SeamStatus.Cases) Check(CaseRunner.Steps(id).Select(step => step.Name).SequenceEqual(requiredSteps.GetProperty(id).EnumerateArray().Select(step => step.GetString())));
            foreach (string id in SeamStatus.Cases) { RunCase(id); Reject(() => RunCase(id, (op, r, o) => op.SkipEffect = true)); Reject(() => RunCase(id, (op, r, o) => op.BadMeasurement = true)); }
            var expectedSeams = J(File.ReadAllText(Path.Combine(fixtures, "seams.json")));
            foreach (string id in SeamStatus.Cases)
            {
                var expected = expectedSeams.GetProperty(id);
                Check(SeamStatus.Required(id).Select(seam => seam.Name + ":" + seam.Code).SequenceEqual(expected.EnumerateObject().Select(row => row.Name + ":" + row.Value.GetString())));
            }
            foreach (string id in SeamStatus.Cases)
            foreach (string seam in SeamStatus.Names)
            {
                string required = expectedSeams.GetProperty(id).TryGetProperty(seam, out var expectedCode) ? expectedCode.GetString() : null;
                var adapters = Adapters(seam);
                if (required == null) { SeamStatus.Require(id, adapters); ++count; }
                else
                {
                    ResetJournal(); var reaper = new Reaper(); var operations = new Operations(id, reaper); var output = new Output();
                    Reject(() => CaseRunner.Run(Request(id), Enrollment(adapters), plan, id, Path.Combine(scratch, "journal"), operations, new ReaperRegistry().Add("file", reaper), output), required);
                    Check(!File.Exists(Path.Combine(scratch, "journal")) && !operations.Armed && output.Files.Count == 0);
                }
            }
        }
        if (group == "all" || group == "M-B2")
        {
            using var channel = new ObservationChannel(new Peer()); var response = Response(Binding);
            Reject(() => channel.Accept(response, Binding with { CaseNonce = H('e') }));
            channel.Accept(response, Binding); Reject(() => channel.Accept(response, Binding));
            var bytes = Encoding.UTF8.GetBytes("neutral"); var manifest = EvidenceManifest.Create(Binding, new[] { new EvidenceFile("policy.json", HeldFile.Hash(bytes), bytes.Length) });
            var pin = new PinnedManifestAuthenticator(HeldFile.Hash(manifest));
            EvidenceManifest.Verify(manifest, Binding, pin, Array.Empty<byte>(), name => bytes); ++count;
            foreach (var binding in new[] { Binding with { RunNonce = H('e') }, Binding with { CaseNonce = H('e') }, Binding with { CaseId = "cleanup" }, Binding with { RequestSha256 = H('e') }, Binding with { OperationId = H('e', 32) } })
                Reject(() => EvidenceManifest.Verify(manifest, binding, pin, Array.Empty<byte>(), name => bytes));
            Reject(() => new PinnedManifestAuthenticator(H('f')).Verify(manifest, Array.Empty<byte>()));
            Reject(() => EvidenceManifest.Verify(manifest, Binding, pin, Array.Empty<byte>(), name => Encoding.UTF8.GetBytes("changed")));
        }
        if (group == "all" || group == "M-B3")
        {
            var altered = Encoding.UTF8.GetBytes(Encoding.UTF8.GetString(Request("preflight")).Replace("\"runId\":\"10\"", "\"runId\":\"11\""));
            ResetJournal(); Reject(() => RunCase("preflight", request: altered)); Check(!File.Exists(Path.Combine(scratch, "journal")));
            Reject(() => RunCase("preflight", (op, r, o) => op.BadBinding = true));
        }
        if (group == "all" || group == "M-B4")
        {
            var peer = new Peer { Trusted = false }; Reject(() => { using var channel = new ObservationChannel(peer); }); Check(peer.Disposed && peer.Reads == 0);
            using var channel = new ObservationChannel(new Peer());
            Reject(() => channel.Accept(Response(Binding with { RequestSha256 = H('e') }), Binding));
            channel.Accept(Response(Binding), Binding); Reject(() => channel.Accept(Response(Binding), Binding));
            Reject(() => channel.Accept(Response(Binding, 3), Binding)); channel.Finalize(Binding); Reject(() => channel.Accept(Response(Binding, 2), Binding));
        }
        if (group == "all" || group == "M-B5")
        {
            var snapshot = Snapshot(); Check(snapshot.State == 1 && snapshot.Build == 26100 && snapshot.Ubr == 100);
            Reject(() => Snapshot(toolSha256: H('b'))); Reject(() => Snapshot(kind: "String")); Reject(() => Snapshot(state: "\"1\""));
            Reject(() => Snapshot(argv: "[\"--list-policies\",\"--json\",\"--extra\"]"));
            var interval = Interval(); Evaluate(interval); ++count;
            Reject(() => Evaluate(interval with { SubscriptionStartedBeforeInstall = false }));
            Reject(() => Evaluate(interval with { Events = Array.Empty<CiEvent>() }));
            Reject(() => Evaluate(interval with { Events = new[] { interval.Events[0] with { RecordId = 102 } }, LastRecord = 102 }));
            Reject(() => Evaluate(interval with { After = interval.After with { State = 2 } }));
            Reject(() => Evaluate(interval with { After = interval.After with { State = 0 } }));
            Reject(() => Evaluate(interval with { After = interval.After with { Boot = "other-boot" } }));
            Reject(() => Evaluate(interval with { Events = new[] { interval.Events[0] with { Id = 9999 } } }));
            Reject(() => Evaluate(interval with { LostRecords = true })); Reject(() => Evaluate(interval with { RolloverRisk = true })); Reject(() => Evaluate(interval with { ObserverAlive = false }));
            Reject(() => Evaluate(interval with { After = interval.After with { Ubr = 101 } }));
            Reject(() => Evaluate(interval with { Before = interval.Before with { Build = 26200 }, After = interval.After with { Build = 26200 } }));
            Reject(() => Evaluate(interval with { Events = new[] { interval.Events[0] with { Id = 3099 } } }));
            foreach (int id in new[] { 3033, 3034, 3076, 3077 }) Reject(() => Evaluate(interval with { Events = new[] { interval.Events[0] with { Id = id } } }));
        }
        if (group == "all" || group == "M-B6")
        {
            var token = Standard(); Check(token.Standard && token.ShutdownRemoved);
            Check(!(token with { Groups = new[] { new TokenGroup("S-1-5-32-544", 0x10) } }).Standard);
            Check(!(token with { Privileges = new[] { new TokenPrivilege("SeShutdownPrivilege", 0) } }).ShutdownRemoved);
            Check(!(token with { Privileges = new[] { new TokenPrivilege("SeRemoteShutdownPrivilege", 0) } }).ShutdownRemoved);
            Check(!(token with { Elevated = true }).Standard); Check(!(token with { ElevationType = "Limited" }).Standard); Check(!(token with { IntegrityLevel = "High" }).Standard);
        }
        if (group == "all" || group == "M-B7")
        {
            var measurement = S4(); S4FaultLauncher.Evaluate(measurement, H('a'), @"C:\Installed\Murage.exe"); ++count;
            Reject(() => S4FaultLauncher.Evaluate(measurement with { SuccessAdjustAccessGranted = false }, H('a'), @"C:\Installed\Murage.exe"));
            Reject(() => S4FaultLauncher.Evaluate(measurement with { NativeSucceeded = true }, H('a'), @"C:\Installed\Murage.exe"));
            Reject(() => S4FaultLauncher.Evaluate(measurement with { NativeError = 0 }, H('a'), @"C:\Installed\Murage.exe"));
            Reject(() => S4FaultLauncher.Evaluate(measurement with { EngineSpawned = true }, H('a'), @"C:\Installed\Murage.exe"));
            Reject(() => S4FaultLauncher.Evaluate(measurement with { JobStarted = true }, H('a'), @"C:\Installed\Murage.exe"));
            Reject(() => S4FaultLauncher.Evaluate(measurement with { TokenOwner = measurement.Witness }, H('a'), @"C:\Installed\Murage.exe"));
            Reject(() => S4FaultLauncher.Evaluate(measurement with { Success = measurement.Failure }, H('a'), @"C:\Installed\Murage.exe"));
            Reject(() => S4FaultLauncher.Evaluate(measurement with { OsFeasibilityOnly = true }, H('a'), @"C:\Installed\Murage.exe"));
            Reject(() => S4FaultLauncher.Evaluate(measurement with { SuspendedCreatedProcess = measurement.Success }, H('a'), @"C:\Installed\Murage.exe"));
            Reject(() => S4FaultLauncher.Evaluate(measurement with { Failure = measurement.Failure with { ImagePath = @"C:\Temp\Murage.exe" } }, H('a'), @"C:\Installed\Murage.exe"));
            Reject(() => S4FaultLauncher.Evaluate(measurement with { Failure = measurement.Failure with { ImageSha256 = H('b') } }, H('a'), @"C:\Installed\Murage.exe"));
            Check(WindowsS4ProcessApi.Remaining(100, 90) == 10);
            Check(WindowsS4ProcessApi.Remaining(100, 100) == 0 && WindowsS4ProcessApi.Remaining(100, 101) == 0);
            var api = new S4Api { Elevated = true }; Reject(() => S4FaultLauncher.Launch(api, measurement.Witness, measurement.Success, p => { }, p => { })); Check(!api.Denied && !api.Resumed);
            api = new S4Api(); S4FaultLauncher.Launch(api, measurement.Witness, measurement.Success, p => { }, p => { }); Check(api.Denied && api.Resumed && api.Terminated);
            api = new S4Api { CrashDuringCreate = true };
            Reject(() => S4FaultLauncher.Launch(api, measurement.Witness, measurement.Success, p => { throw new Exception("registered after crash"); }, p => { }), "WINDOWS_WITNESS_S4_CREATION_CRASH");
            Check(api.Contained && !api.Live && !api.Terminated && !api.Resumed);
            api = new S4Api { ChildToken = "token-30" }; Reject(() => S4FaultLauncher.Launch(api, measurement.Witness, measurement.Success, p => { }, p => { })); Check(!api.Denied && !api.Resumed && api.Terminated);
        }
        if (group == "all" || group == "M-B8")
        {
            byte[] bytes = Encoding.UTF8.GetBytes("neutral-capture"); using var output = new MemoryStream();
            string hash = CaptureWriter.Copy(new MemoryStream(bytes), output); Check(hash == HeldFile.Hash(bytes) && output.ToArray().SequenceEqual(bytes));
            Reject(() => CaptureWriter.Copy(new MemoryStream(), Stream.Null));
            foreach (var name in new[] { "../escape", "result.json", "request.json", "collector.log", "con", "nul.json", "file.", "a:b" }) Reject(() => CaptureWriter.Name(name));
            using var key = RSA.Create(3072); byte[] manifest = EvidenceManifest.Create(Binding, new[] { new EvidenceFile("policy.json", hash, bytes.Length) });
            using var auth = new PublicKeyManifestAuthenticator(key.ExportSubjectPublicKeyInfo()); var signature = key.SignData(manifest, HashAlgorithmName.SHA256, RSASignaturePadding.Pss);
            auth.Verify(manifest, signature); ++count; signature[0] ^= 1; Reject(() => auth.Verify(manifest, signature));
            Reject(() => new UnenrolledEvidenceAuthenticator().Verify(manifest, Array.Empty<byte>()));
        }
        if (group == "all" || group == "M-B9")
        {
            foreach (string name in new[] { "tool", "endpoint", "key", "adapters" })
            {
                string raw = Encoding.UTF8.GetString(Request("preflight")).Replace("\"inputs\":{}", "\"inputs\":{\"" + name + "\":\"selected\"}");
                ResetJournal(); Reject(() => RunCase("preflight", request: Encoding.UTF8.GetBytes(raw))); Check(!File.Exists(Path.Combine(scratch, "journal")));
            }
            foreach (string id in SeamStatus.Cases)
            {
                string path = Path.Combine(scratch, "result.json"); if (File.Exists(path)) File.Delete(path);
                Reject(() => CollectionEntry.Witness(Request(id), Enrollment(Adapters()), plan, id, scratch), "WINDOWS_WITNESS_OBSERVATION_AUTH_UNENROLLED");
                Check(!File.Exists(path));
            }
            var enrollment = Enrollment(Adapters()); using var doc = JsonDocument.Parse("{}");
            Reject(() => SeamStatus.Require("preflight", SeamStatus.Adapters(doc.RootElement)), "WINDOWS_WITNESS_SAC_ADAPTER_UNACCEPTED_R_COL_8");
        }
        if (group == "all" || group == "M-B10")
        {
            RunCase("preflight");
            string flushPath = Path.Combine(scratch, "flush"); if (File.Exists(flushPath)) File.Delete(flushPath);
            using (var flushing = new FlushFile(flushPath)) { ResultWriter.Write(flushing, new byte[] { 1 }); Check(flushing.Durable); }
            File.Delete(flushPath);
            foreach (var point in new[] { "cleanup", "restore", "capture", "finalize", "flush", "publish" })
            {
                Output output = null;
                Reject(() => RunCase("preflight", (op, r, o) => { output = o; r.Resurrect = point == "cleanup"; op.FailRestore = point == "restore"; o.FailCapture = point == "capture"; op.FailFinalize = point == "finalize"; o.FailFlush = point == "flush"; o.FailPublish = point == "publish"; }));
                Check(output != null && !output.Files.ContainsKey("result.json"));
            }
            string file = Path.Combine(scratch, "exclusive-result"); if (File.Exists(file)) File.Delete(file);
            ResultWriter.WriteExclusive(file, Encoding.UTF8.GetBytes("first"));
            bool rejected = false; try { ResultWriter.WriteExclusive(file, Encoding.UTF8.GetBytes("second")); } catch (IOException) { rejected = true; }
            Check(rejected && File.ReadAllText(file) == "first"); File.Delete(file);
        }
        if (group == "all" || group == "M-B11")
        {
            var doc = XDocument.Load(project); var excludes = doc.Descendants("Compile").Attributes("Remove").SelectMany(a => a.Value.Split(';')).ToArray();
            Check(excludes.Contains("**/*.selfcheck.cs") && excludes.Contains("adapters/fixtures/**"));
            Check(!doc.Descendants("Compile").Attributes("Include").Any(a => a.Value.Contains("selfcheck") || a.Value.Contains("fixtures")));
        }
        if (group == "all" || group == "M-B12")
        {
            var assets = Workflow(); var output = new Dictionary<string, byte[]>();
            var request = new AssetsRequest(@"C:\Workflow\assets", @"C:\Workflow\signing", H('f', 40), Path.Combine(scratch, "workflow-output"));
            Directory.CreateDirectory(request.Output);
            string retained = Path.Combine(request.Output, "retained.txt"); File.WriteAllText(retained, "owned-read-only-fixture");
            CaseRunner.RunAssets(request, assets, Binding, new PinAfterMeasure(), Array.Empty<byte>(), (name, bytes) => output.Add(name, bytes));
            Check(output.Keys.OrderBy(x => x).SequenceEqual(new[] { "candidate.json", "evidence-manifest.json", "evidence.json", "pe-leaves.json", "policy.json" }));
            Check(!assets.FaultReached && !output.ContainsKey("result.json") && File.ReadAllText(retained) == "owned-read-only-fixture");
            using (var leaves = WitnessCodec.Parse(output["pe-leaves.json"], WitnessCodec.CaptureLimit))
            {
                var leaf = leaves.RootElement.GetProperty("files")[0];
                Check(WitnessCodec.Text(leaf, "path") == "neutral.image" && WitnessCodec.Text(leaf, "sha256") == HeldFile.Hash(assets.Pe)
                    && WitnessCodec.Text(leaf, "leafDerSha256") == H('a'));
                using var manifest = WitnessCodec.Parse(output["evidence-manifest.json"], WitnessCodec.CaptureLimit);
                Check(manifest.RootElement.GetProperty("files").EnumerateArray().Any(row => WitnessCodec.Text(row, "name") == "pe-leaves.json"
                    && WitnessCodec.Text(row, "sha256") == HeldFile.Hash(output["pe-leaves.json"])));
            }
            Check(AssetsCollector.IsPe("neutral.image", assets.Pe));
            Check(!typeof(IAssetsMeasurements).GetMethods().Any(m => System.Text.RegularExpressions.Regex.IsMatch(m.Name, "Fault|Destroy|Revoke|Stop")));
            Reject(() => CollectionEntry.Assets(new[] { "--assets", request.Assets, "--signing-output", request.SigningOutput, "--source", request.Source, "--output", @"C:\Workflow\output" }, true), "WINDOWS_WITNESS_WORKFLOW_ON_WITNESS_HOST");
            foreach (var pe in new[] { assets.Observation.Installed[0] with { SigntoolValid = false }, assets.Observation.Installed[0] with { NativeValid = false }, assets.Observation.Installed[0] with { Embedded = false }, assets.Observation.Installed[0] with { LeafDerSha256 = "declared" } })
            {
                var invalid = Workflow(); invalid.Observation = invalid.Observation with { Installed = new[] { pe } };
                Reject(() => CaseRunner.RunAssets(request, invalid, Binding, new PinAfterMeasure(), Array.Empty<byte>(), (name, bytes) => { throw new Exception("wrote before validation"); }));
            }
            var bad = Workflow(); bad.Observation = bad.Observation with { Sac = bad.Observation.Sac with { SubscriptionStartedBeforeInstall = false } };
            Reject(() => CaseRunner.RunAssets(request, bad, Binding, new PinAfterMeasure(), Array.Empty<byte>(), (name, bytes) => { throw new Exception("wrote before validation"); }));
        }
        if (group == "all" || group == "M-B13")
        {
            Reject(() => RunCase("locked-build", (op, r, o) => op.DirtyInput = true), "WINDOWS_WITNESS_ENROLLED_INPUT_CHANGED_R_COL_12");
            RunCase("locked-build");
        }
        return count;
    }
}
