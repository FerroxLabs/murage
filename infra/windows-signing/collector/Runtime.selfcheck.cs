// Portable journal/recovery check producer owner: win-sac-sign; native/deployed witness consumer owner: MAIN.
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.Json;
using Murage.Witness;

public static class RuntimeChecks
{
    private sealed class Reaper : IResourceReaper
    {
        public readonly HashSet<RunResource> Live = new HashSet<RunResource>();
        public readonly List<RunResource> Destroyed = new List<RunResource>();
        public RunResource Survives, Throws;
        public void Destroy(RunResource resource)
        {
            Destroyed.Add(resource);
            if (resource == Throws) throw new IOException("neutral failure");
            if (resource != Survives) Live.Remove(resource);
        }
        public bool Absent(RunResource resource) => !Live.Contains(resource);
    }
    private sealed class Generated : Stream
    {
        private long remaining;
        public Generated(long length) { remaining = length; }
        public override int Read(byte[] buffer, int offset, int count)
        {
            int read = (int)Math.Min(count, remaining); Array.Clear(buffer, offset, read); remaining -= read; return read;
        }
        public override bool CanRead => true;
        public override bool CanWrite => false;
        public override bool CanSeek => false;
        public override long Length => throw new NotSupportedException();
        public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
        public override void Flush() => throw new NotSupportedException();
        public override void Write(byte[] b, int o, int c) => throw new NotSupportedException();
        public override long Seek(long o, SeekOrigin s) => throw new NotSupportedException();
        public override void SetLength(long l) => throw new NotSupportedException();
    }
    private sealed class CountingStream : MemoryStream
    {
        public long ReadBytes;
        public override int Read(byte[] bytes, int offset, int count) { int n = base.Read(bytes, offset, count); ReadBytes += n; return n; }
        public override int Read(Span<byte> bytes) { int n = base.Read(bytes); ReadBytes += n; return n; }
    }
    private sealed class ProcessApi : IProcessReaperApi
    {
        public long Creation = 1234; public bool Gone; public int Kills;
        private sealed class Instance : IProcessIncarnation
        {
            private readonly ProcessApi api; public Instance(ProcessApi api) { this.api = api; }
            public long Creation => api.Creation;
            public bool Exited => api.Gone;
            public void Terminate(int milliseconds) { if (milliseconds <= 0) throw new Exception("deadline"); ++api.Kills; api.Gone = true; }
            public void Dispose() { }
        }
        public IProcessIncarnation Open(uint pid, bool terminate) => new Instance(this);
    }
    private sealed class FileApi : IFileReaperApi
    {
        public string Id = new string('1', 16) + ":" + new string('2', 32); public bool Gone, Reparse; public uint Links = 1; public int Deletes;
        private sealed class File : IRecoveryFile
        {
            private readonly FileApi api; private readonly string id;
            public File(FileApi api) { this.api = api; id = api.Id; }
            public string Identity => id; public bool Reparse => api.Reparse; public uint Links => api.Links;
            public void Delete() { ++api.Deletes; if (api.Id == id) api.Gone = true; }
            public void Dispose() { }
        }
        public IRecoveryFile Open(string path, bool delete) => Gone ? null : new File(this);
    }
    private sealed class JobApi : IJobReaperApi, IRecoveryJob
    {
        public uint Active = 1; public IReadOnlyList<uint> Members = new uint[] { 100 }; public bool Missing; public int Kills;
        public uint ActiveProcesses => Active; public IReadOnlyList<uint> Pids => Members;
        public IRecoveryJob Open(string name, bool terminate) => Missing ? null : this;
        public void Terminate(int milliseconds) { ++Kills; Active = 0; }
        public void Dispose() { }
    }
    private sealed class TaskApi : ITaskReaperApi
    {
        public string Actual = new string('1', 32); public int Deletes;
        public string Nonce(string path) => Actual;
        public void Delete(string path, string nonce) { if (Actual == nonce) { ++Deletes; Actual = null; } }
    }
    private sealed class ServiceApi : IServiceStateReaperApi
    {
        public ServiceBaseline State = new ServiceBaseline(3, 4, @"C:\neutral\service.exe", new string('1', 64)); public int Restores;
        public ServiceBaseline Read(string name) => State;
        public void Restore(string name, ServiceBaseline baseline, int milliseconds) { ++Restores; State = baseline; }
    }
    private sealed class WfpApi : IWfpReaperApi
    {
        public FilterIdentity State = new FilterIdentity(new Guid("11111111-1111-1111-1111-111111111111"), new Guid("22222222-2222-2222-2222-222222222222")); public int Deletes;
        public FilterIdentity Read(Guid key) => State;
        public void Delete(Guid key, FilterIdentity expected) { if (State == expected) { State = null; ++Deletes; } }
    }
    private sealed class LeaseApi : ILeaseReaperApi
    {
        public bool Accepted = true, IsUnknown; public int Closes;
        public void RequireAuthenticatedObserver() { if (!Accepted) throw WitnessCodec.Reject("OBSERVATION_AUTH_UNENROLLED_R_COL_6"); }
        public bool Unknown(string nonce, LeaseIncarnation incarnation) => IsUnknown;
        public void CloseOwningSession(LeaseIncarnation incarnation) { ++Closes; IsUnknown = true; }
    }
    private sealed class InstallApi : IInstallReaperApi
    {
        public string Location = @"C:\neutral\install"; public int Uninstalls; public FileApi Files;
        public string RegisteredDirectory(InstallIdentity identity) => Location;
        public void Uninstall(string directory, InstallIdentity identity, int milliseconds) { ++Uninstalls; Location = null; Files.Gone = true; }
    }
    private sealed class Lifetime : ICollectorLifetime
    {
        public bool Exited = true, Waited; public Action BeforeSignal;
        public bool WaitUntil(DateTimeOffset expires) { BeforeSignal?.Invoke(); Waited = true; return Exited; }
        public void Dispose() { }
    }
    private static int ReaperChecks()
    {
        int count = 0;
        void Check(bool value) { if (!value) throw new Exception("COLLECTOR_RUNTIME_MUTANT_SURVIVED"); ++count; }
        void Reject(Action action) { try { action(); } catch (InvalidOperationException) { ++count; return; } throw new Exception("COLLECTOR_RUNTIME_MUTANT_SURVIVED"); }
        string run = new string('a', 64), root = @"C:\neutral\scratch";
        string Json(object value) => JsonSerializer.Serialize(value);
        var process = new RunResource("process", "100", "1234"); var pApi = new ProcessApi(); var pReaper = new ProcessReaper(pApi);
        Check(!pReaper.Absent(process)); pApi.Creation = 5678;
        Check(pReaper.Absent(process) && pReaper.Retained.Contains(process)); Reject(() => pReaper.Destroy(process)); Check(pApi.Kills == 0);
        pApi.Creation = 1234; pReaper.Destroy(process); Check(pReaper.Absent(process) && pApi.Kills == 1);
        var registry = new ReaperRegistry().Add("process", pReaper);
        Check(ResourceRecovery.ConfirmAbsent(new[] { process }, registry));
        Check(!ResourceRecovery.ConfirmAbsent(new[] { new RunResource("job", "neutral", "neutral") }, registry));
        Reject(() => registry.For("job"));
        Reject(() => registry.Destroy(new RunResource("job", "neutral", "neutral"))); Check(pApi.Kills == 1);
        var fApi = new FileApi(); var file = new RunResource("file", root + @"\file", Json(new { runNonce = run, fileId = fApi.Id })); var fReaper = new FileReaper(run, root, fApi);
        Check(!fReaper.Absent(file)); fApi.Id = new string('3', 16) + ":" + new string('4', 32);
        Check(fReaper.Absent(file)); fReaper.Destroy(file); Check(fApi.Deletes == 0 && fReaper.Retained.Contains(file));
        fApi.Id = new string('1', 16) + ":" + new string('2', 32); fApi.Reparse = true; Reject(() => fReaper.Destroy(file)); fApi.Reparse = false;
        fApi.Links = 2; Reject(() => fReaper.Destroy(file)); fApi.Links = 1; fReaper.Destroy(file); Check(fReaper.Absent(file) && fApi.Deletes == 1);
        Reject(() => fReaper.Destroy(file with { Id = @"C:\foreign\file" }));
        registry.Add("file", fReaper); Check(registry.Retained.Contains(file) && registry.Retained.Contains(process));
        var jobApi = new JobApi(); var members = new Reaper(); members.Live.Add(process);
        var job = new RunResource("job", @"Global\MurageWitness-" + run + "-1", Json(new { runNonce = run, members = new[] { new { pid = "100", creation = "1234" } }, membersSha256 = HeldFile.Hash(Encoding.UTF8.GetBytes("100:1234")) }));
        var jReaper = new JobReaper(run, jobApi, members);
        Check(!jReaper.Absent(job)); members.Live.Clear(); Check(!jReaper.Absent(job)); jobApi.Active = 0; members.Live.Add(process); Check(!jReaper.Absent(job));
        jobApi.Active = 1; jobApi.Members = new uint[] { 200 }; Reject(() => jReaper.Destroy(job)); Check(jobApi.Kills == 0);
        jobApi.Members = new uint[] { 100 };
        members.Live.Clear(); var reusedMember = process with { Incarnation = "5678" }; members.Live.Add(reusedMember);
        Reject(() => jReaper.Destroy(job)); Check(jobApi.Kills == 0 && members.Live.Contains(reusedMember));
        members.Live.Remove(reusedMember); members.Live.Add(process);
        jReaper.Destroy(job); Check(jReaper.Absent(job) && jobApi.Kills == 1);
        jobApi.Missing = true; members.Live.Add(process); Check(!jReaper.Absent(job)); jReaper.Destroy(job); Check(jReaper.Absent(job));
        var taskApi = new TaskApi(); var task = new RunResource("task", @"\MurageWitness\" + run + @"\supervisor", Json(new { runNonce = run, nonce = taskApi.Actual })); var tReaper = new TaskReaper(run, taskApi);
        Check(!tReaper.Absent(task)); taskApi.Actual = new string('2', 32); tReaper.Destroy(task); Check(tReaper.Absent(task) && taskApi.Deletes == 0 && tReaper.Retained.Contains(task));
        taskApi.Actual = new string('1', 32); tReaper.Destroy(task); Check(tReaper.Absent(task) && taskApi.Deletes == 1);
        var serviceApi = new ServiceApi(); var baseline = serviceApi.State;
        var service = new RunResource("service-state", "neutral-service", Json(new { runNonce = run, startType = baseline.StartType, state = baseline.State, binaryPath = baseline.BinaryPath, sha256 = baseline.Sha256, exclusiveRunNonce = run }));
        var sReaper = new ServiceStateReaper(run, serviceApi); Check(sReaper.Absent(service)); serviceApi.State = baseline with { StartType = 4 };
        Check(!sReaper.Absent(service)); sReaper.Destroy(service); Check(sReaper.Absent(service) && serviceApi.Restores == 1);
        serviceApi.State = baseline with { Sha256 = new string('2', 64) }; Reject(() => sReaper.Destroy(service)); Check(serviceApi.Restores == 1);
        var wfpApi = new WfpApi(); var filterId = wfpApi.State;
        var filter = new RunResource("wfp-filter", "33333333-3333-3333-3333-333333333333", Json(new { runNonce = run, provider = filterId.Provider.ToString(), sublayer = filterId.Sublayer.ToString() })); var wReaper = new WfpReaper(run, wfpApi);
        Check(!wReaper.Absent(filter)); wfpApi.State = filterId with { Provider = Guid.Empty }; wReaper.Destroy(filter); Check(wReaper.Absent(filter) && wfpApi.Deletes == 0 && wReaper.Retained.Contains(filter));
        wfpApi.State = filterId; wReaper.Destroy(filter); Check(wReaper.Absent(filter) && wfpApi.Deletes == 1);
        var leaseApi = new LeaseApi(); var leaseProcesses = new Reaper();
        var serviceProcess = new RunResource("process", "200", "2345"); var childProcess = new RunResource("process", "300", "3456"); leaseProcesses.Live.UnionWith(new[] { serviceProcess, childProcess });
        foreach (string type in new[] { "lease", "capability" })
        {
            var lease = new RunResource(type, new string('b', 64), Json(new { runNonce = run, servicePid = "200", serviceCreation = "2345", ownerPid = "100", ownerCreation = "1234", childPid = "300", childCreation = "3456", instance = new string('c', 32) }));
            var lReaper = new LeaseReaper(run, type, leaseApi, leaseProcesses); leaseApi.IsUnknown = false;
            Check(!lReaper.Absent(lease)); leaseProcesses.Live.Remove(childProcess); Check(!lReaper.Absent(lease));
            leaseApi.Accepted = false; int closes = leaseApi.Closes; Reject(() => lReaper.Destroy(lease)); Check(leaseApi.Closes == closes);
            leaseApi.Accepted = true; lReaper.Destroy(lease); Check(lReaper.Absent(lease)); leaseProcesses.Live.Add(childProcess); Check(!lReaper.Absent(lease));
            leaseProcesses.Live.Remove(serviceProcess); Check(lReaper.Absent(lease)); leaseProcesses.Live.Add(serviceProcess);
        }
        var installFiles = new FileApi(); var installApi = new InstallApi { Files = installFiles }; var iReaper = new InstallReaper(run, installApi.Location, installApi, installFiles);
        var install = new RunResource("install", installApi.Location, Json(new { runNonce = run, uninstaller = installApi.Location + @"\uninstall.exe", sha256 = new string('1', 64), fileId = installFiles.Id, rootFileId = installFiles.Id, userSid = "S-1-5-21-1-2-3-1000", session = 1, registryKey = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\neutral" }));
        Check(!iReaper.Absent(install)); installFiles.Id = new string('3', 16) + ":" + new string('4', 32); iReaper.Destroy(install); Check(installApi.Uninstalls == 0);
        installFiles.Id = new string('1', 16) + ":" + new string('2', 32); iReaper.Destroy(install); Check(iReaper.Absent(install) && installApi.Uninstalls == 1);
        foreach (var pair in new[] { (Resource: file, Reaper: (IResourceReaper)fReaper), (job, jReaper), (task, tReaper), (service, sReaper), (filter, wReaper), (install, iReaper) })
        {
            var foreign = pair.Resource with { Incarnation = pair.Resource.Incarnation.Replace(run, new string('e', 64)) };
            Reject(() => pair.Reaper.Absent(foreign)); Reject(() => pair.Reaper.Destroy(foreign));
        }
        int reaped = 0, expired = 0; var lifetime = new Lifetime(); lifetime.BeforeSignal = () => Check(reaped == 0 && expired == 0);
        Check(Supervisor.Run(lifetime, DateTimeOffset.UtcNow.AddMinutes(1), () => false, () => { Check(lifetime.Waited); ++reaped; return true; }, () => ++expired));
        Check(reaped == 1 && expired == 0);
        lifetime = new Lifetime(); Check(Supervisor.Run(lifetime, DateTimeOffset.UtcNow.AddMinutes(1), () => true, () => { ++reaped; return false; }, () => ++expired)); Check(reaped == 1);
        lifetime = new Lifetime { Exited = false }; Check(Supervisor.Run(lifetime, DateTimeOffset.UtcNow, () => true, () => { Check(expired == 1); ++reaped; return true; }, () => ++expired)); Check(reaped == 2 && expired == 1);
        Reject(() => Supervisor.Arguments(new[] { "--supervise", run, "--collector-pid", "0", "--collector-creation", "1234", "--expires", "2026-01-01T00:00:00Z" }));
        Console.WriteLine("M-A5..M-A13 process/job/file/task/service/WFP/install/lease/capability/supervisor independent OS checks GREEN");
        return count;
    }
    public static int Run()
    {
        int count = 0;
        void Check(bool value) { if (!value) throw new Exception("COLLECTOR_RUNTIME_MUTANT_SURVIVED"); ++count; }
        void Reject(Action action)
        {
            try { action(); } catch (InvalidOperationException) { ++count; return; } catch (System.Text.Json.JsonException) { ++count; return; }
            catch (Exception error) { throw new Exception("COLLECTOR_RUNTIME_MUTANT_SURVIVED", error); }
            throw new Exception("COLLECTOR_RUNTIME_MUTANT_SURVIVED");
        }
        foreach (var name in new[] { "../escape", "request.json", "result.json", "collector.log", "con", "nul.json", "capture.", "CAPTURE", "a/b", "a:b", new string('a', 102) })
            Reject(() => CaptureWriter.Name(name));
        CaptureWriter.Name("policy.json"); ++count;
        using (var input = new MemoryStream(Encoding.UTF8.GetBytes("neutral observation")))
        using (var output = new MemoryStream())
        {
            var hash = CaptureWriter.Copy(input, output);
            Check(hash == HeldFile.Hash(output.ToArray()) && output.ToArray().SequenceEqual(Encoding.UTF8.GetBytes("neutral observation")));
        }
        Reject(() => CaptureWriter.Copy(new MemoryStream(), Stream.Null));
        Check(WitnessCodec.Hex(CaptureWriter.Copy(new Generated(WitnessCodec.CaptureLimit), Stream.Null), 64));
        Reject(() => CaptureWriter.Copy(new Generated(WitnessCodec.CaptureLimit + 1L), Stream.Null));
        var root = Path.Combine(Path.GetTempPath(), "collector-check-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(root);
        string run = new string('a', 64), nonce = new string('b', 64), request = new string('c', 64);
        var binding = new OperationBinding(run, nonce, "preflight", request, new string('d', 32));
        var process = new RunResource("process", "100", "1234");
        var vm = new RunResource("vm", "neutral-vm", "neutral-generation");
        byte[] bytes;
        try
        {
            using (var journal = new ResourceJournal(new FileStream(Path.Combine(root, "journal"), FileMode.CreateNew, FileAccess.ReadWrite, FileShare.Read), run))
            {
                Check(journal.State.Sequence == 0 && journal.State.Created.Count == 0);
                Reject(() => journal.Register(process, binding with { CaseNonce = run }));
                Reject(() => journal.Register(process, binding with { RequestSha256 = "wrong" }));
                Reject(() => journal.Register(new RunResource("unknown", "neutral", "neutral"), binding));
                Reject(() => journal.Register(new RunResource("file", "\n", "neutral"), binding));
                journal.Register(process, binding); Check(journal.State.Created.Count == 1);
                Reject(() => journal.Register(process, binding));
                Reject(() => journal.Register(process with { Incarnation = "9999" }, binding));
                journal.Register(vm, binding);
                Reject(() => journal.ConfirmDestroyed(process with { Incarnation = "9999" }, binding));
                journal.ConfirmDestroyed(process, binding);
                Reject(() => journal.ConfirmDestroyed(process, binding));
                Check(journal.State.Sequence == 3 && journal.State.Created.Count == 2 && journal.State.Remaining.SequenceEqual(new[] { vm }));
            }
            using (var stream = new MemoryStream())
            using (var journal = new ResourceJournal(stream, run))
            {
                journal.Register(process, binding);
                var before = stream.ToArray();
                foreach (var other in new[] { binding with { CaseNonce = new string('e', 64), CaseId = "cleanup" }, binding with { CaseId = "cleanup" }, binding with { RequestSha256 = new string('e', 64) }, binding with { OperationId = new string('e', 32) } })
                {
                    Reject(() => journal.ConfirmDestroyed(process, other));
                    Check(before.SequenceEqual(stream.ToArray()));
                }
                journal.ConfirmDestroyed(process, binding);
                Reject(() => journal.ConfirmDestroyed(process, binding));
                journal.Finalize(binding);
                Reject(() => journal.Register(vm, binding));
            }
            Console.WriteLine("W-J1 W-J2 cross-case/digest/operation rejection; unchanged bytes GREEN");
            using (var stream = new CountingStream())
            using (var journal = new ResourceJournal(stream, run))
            {
                long reads = stream.ReadBytes;
                for (int i = 0; i < 10000; ++i) journal.Register(new RunResource("process", (i + 1).ToString(), "1234"), binding);
                Check(stream.ReadBytes == reads && journal.State.Sequence == 10000);
            }
            Console.WriteLine("W-J3 10000 appends; bytes read after open = 0 GREEN");
            using (var stream = new MemoryStream())
            using (var journal = new ResourceJournal(stream, run))
            {
                journal.Register(process, binding); stream.Position = stream.Length; stream.WriteByte(123);
                Reject(() => journal.Register(vm, binding));
                long length = stream.Length; stream.SetLength(length - 1);
                Reject(() => journal.Register(vm, binding)); Check(stream.Length == length - 1);
            }
            Console.WriteLine("W-J4 external append poisons journal GREEN");
            using (var stream = new MemoryStream())
            using (var journal = new ResourceJournal(stream, run))
            {
                var random = new Random(813); var live = new List<RunResource>();
                for (int i = 0; i < 1000; ++i)
                {
                    if (live.Count == 0 || random.Next(2) == 0)
                    {
                        var resource = new RunResource("file", "neutral-" + i, "generation-" + i);
                        journal.Register(resource, binding); live.Add(resource);
                    }
                    else
                    {
                        int n = random.Next(live.Count); journal.ConfirmDestroyed(live[n], binding); live.RemoveAt(n);
                    }
                    var replay = ResourceJournal.Read(new MemoryStream(stream.ToArray()), run);
                    Check(replay.Sequence == journal.State.Sequence && replay.Previous == journal.State.Previous && replay.Length == journal.State.Length
                        && replay.Created.SequenceEqual(journal.State.Created) && replay.Remaining.SequenceEqual(journal.State.Remaining)
                        && replay.Outstanding == journal.State.Outstanding && replay.Pending.OrderBy(e => e.Key).SequenceEqual(journal.State.Pending.OrderBy(e => e.Key)));
                }
            }
            Console.WriteLine("W-J5 1000 seeded transitions; replay equals incremental GREEN");
            using (var stream = new MemoryStream())
            using (var journal = new ResourceJournal(stream, run))
            {
                journal.Register(process, binding); journal.ConfirmReaped(process, "operator");
                Check(journal.State.Remaining.Count == 0); Reject(() => journal.Finalize(binding));
                Reject(() => journal.ConfirmDestroyed(process, binding));
            }
            bytes = File.ReadAllBytes(Path.Combine(root, "journal"));
            JournalState Read(byte[] input, string binding = null) => ResourceJournal.Read(new MemoryStream(input), binding ?? run);
            var state = Read(bytes); Check(!state.TornTail && state.Sequence == 3);
            var lines = Encoding.UTF8.GetString(bytes).Split('\n');
            byte[] AlterLast(string before, string after) => Encoding.UTF8.GetBytes(lines[0] + "\n" + lines[1] + "\n" + lines[2].Replace(before, after) + "\n");
            Reject(() => Read(AlterLast("\"sequence\":3", "\"sequence\":9")));
            Reject(() => Read(AlterLast("\"requestSha256\":\"" + request, "\"requestSha256\":\"wrong")));
            Reject(() => Read(AlterLast("\"incarnation\":\"1234\"", "\"incarnation\":\"9999\"")));
            string duplicate = lines[0].Replace("\"sequence\":1", "\"sequence\":2").Replace(new string('0', 64), HeldFile.Hash(Encoding.UTF8.GetBytes(lines[0])));
            Reject(() => Read(Encoding.UTF8.GetBytes(lines[0] + "\n" + duplicate + "\n")));

            Reject(() => Read(bytes, request));
            Reject(() => Read(Encoding.UTF8.GetBytes(Encoding.UTF8.GetString(bytes).Replace("\"sequence\":2", "\"sequence\":9"))));
            Reject(() => Read(Encoding.UTF8.GetBytes(Encoding.UTF8.GetString(bytes).Replace("\"previous\":\"" + new string('0', 64), "\"previous\":\"" + run))));
            // Editing an earlier record breaks the next record's chain even if the edited record parses.
            Reject(() => Read(Encoding.UTF8.GetBytes(Encoding.UTF8.GetString(bytes).Replace("\"id\":\"100\"", "\"id\":\"101\""))));
            Reject(() => Read(Encoding.UTF8.GetBytes(Encoding.UTF8.GetString(bytes).Replace("\"schema\":1", "\"schema\":1,\"schema\":1"))));
            Reject(() => Read(new byte[ResourceJournal.Limit + 1]));
            var torn = Read(bytes.Concat(Encoding.UTF8.GetBytes("{\"schema\":" )).ToArray());
            Check(torn.TornTail && torn.Created.Count == 2);
            File.WriteAllBytes(Path.Combine(root, "torn"), bytes.Concat(new byte[] { 123 }).ToArray());
            using (var file = new FileStream(Path.Combine(root, "torn"), FileMode.Open, FileAccess.ReadWrite, FileShare.Read))
                Reject(() => { using var journal = new ResourceJournal(file, run); });
            using (var journal = new ResourceJournal(new FileStream(Path.Combine(root, "journal"), FileMode.Open, FileAccess.ReadWrite, FileShare.Read), run))
            { journal.ConfirmDestroyed(vm, binding); Check(journal.State.Remaining.Count == 0); }
            var reaper = new Reaper(); reaper.Live.UnionWith(new[] { process, vm });
            var foreign = new RunResource("process", "200", "5678"); reaper.Live.Add(foreign);
            Check(ResourceRecovery.Reap(state, reaper));
            Check(reaper.Destroyed.SequenceEqual(new[] { vm, process }) && reaper.Live.SetEquals(new[] { foreign }));
            Check(ResourceRecovery.Reap(state, reaper) && reaper.Destroyed.Count == 2);
            reaper.Live.UnionWith(new[] { process, vm }); reaper.Survives = vm;
            Check(!ResourceRecovery.Reap(state, reaper) && !reaper.Live.Contains(process));
            reaper.Survives = null; reaper.Throws = vm; reaper.Live.Add(process);
            var previousError = Console.Error; var diagnostics = new StringWriter();
            try
            {
                Console.SetError(diagnostics);
                Check(!ResourceRecovery.Reap(state, reaper) && !reaper.Live.Contains(process));
                Check(diagnostics.ToString().Length > 0);
                var diagnostic = JsonDocument.Parse(diagnostics.ToString().Trim()).RootElement;
                Check(diagnostic.GetProperty("resource").GetProperty("type").GetString() == vm.Type);
                Check(diagnostic.GetProperty("resource").GetProperty("id").GetString() == vm.Id);
                Check(diagnostic.GetProperty("resource").GetProperty("incarnation").GetString() == vm.Incarnation);
                Check(diagnostic.GetProperty("error").GetString() == "IOException");
                Check(!diagnostics.ToString().Contains("neutral failure"));
            }
            finally { Console.SetError(previousError); }
            reaper.Throws = null;
            Check(!ResourceRecovery.Reap(torn, reaper) && !reaper.Live.Contains(vm));
            // A destroyed journal receipt is never independent absence proof.
            var allDestroyed = Read(File.ReadAllBytes(Path.Combine(root, "journal")));
            reaper.Live.Add(process); Check(ResourceRecovery.Reap(allDestroyed, reaper) && !reaper.Live.Contains(process));
            using (var closed = new FileStream(Path.Combine(root, "closed"), FileMode.CreateNew, FileAccess.ReadWrite, FileShare.Read))
            {
                using var journal = new ResourceJournal(closed, run); closed.Dispose();
                bool failed = false;
                try { journal.Register(process, binding); } catch (ObjectDisposedException) { failed = true; }
                Check(failed && journal.State.Created.Count == 0);
            }
        }
        finally { Directory.Delete(root, true); }
        return count + ReaperChecks();
    }
}

// Native self-check only; excluded from the production project with Runtime.selfcheck.cs.
public static class NativeRecoveryChecks
{
    [System.Runtime.InteropServices.DllImport("kernel32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode, SetLastError = true)]
    private static extern Microsoft.Win32.SafeHandles.SafeFileHandle CreateJobObject(IntPtr security, string name);
    [System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(Microsoft.Win32.SafeHandles.SafeFileHandle job, int type, IntPtr information, uint size);
    [System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(Microsoft.Win32.SafeHandles.SafeFileHandle job, IntPtr process);
    public static int Run(string root, string pwsh)
    {
        int count = 0;
        void Check(bool value) { if (!value) throw new Exception("COLLECTOR_NATIVE_MUTANT_SURVIVED"); ++count; }
        string run = new string('a', 64);
        string Json(object value) => JsonSerializer.Serialize(value);
        var api = new WindowsFileReaperApi(); var files = new FileReaper(run, root, api);
        string path = Path.Combine(root, "reaper-file.json"); File.WriteAllText(path, "neutral file");
        string id; using (var held = api.Open(path, false)) { Check(held != null && !held.Reparse && held.Links == 1); id = held.Identity; }
        var resource = new RunResource("file", path, Json(new { runNonce = run, fileId = id }));
        Check(!files.Absent(resource)); File.Move(path, path + ".old"); File.WriteAllText(path, "foreign file");
        Check(files.Absent(resource)); files.Destroy(resource); Check(File.ReadAllText(path) == "foreign file" && files.Retained.Contains(resource));
        using (var held = api.Open(path, false)) resource = resource with { Incarnation = Json(new { runNonce = run, fileId = held.Identity }) };
        files.Destroy(resource); Check(files.Absent(resource) && !File.Exists(path));
        string jobName = @"Global\MurageWitness-" + run + "-" + System.Diagnostics.Process.GetCurrentProcess().Id.ToString(System.Globalization.CultureInfo.InvariantCulture);
        using var job = CreateJobObject(IntPtr.Zero, jobName); Check(!job.IsInvalid && System.Runtime.InteropServices.Marshal.GetLastWin32Error() != 183);
        var limits = System.Runtime.InteropServices.Marshal.AllocHGlobal(144);
        try
        {
            for (int i = 0; i < 144; ++i) System.Runtime.InteropServices.Marshal.WriteByte(limits, i, 0);
            System.Runtime.InteropServices.Marshal.WriteInt32(limits, 16, 0x2000);
            Check(SetInformationJobObject(job, 9, limits, 144));
        }
        finally { System.Runtime.InteropServices.Marshal.FreeHGlobal(limits); }
        var start = new System.Diagnostics.ProcessStartInfo(pwsh) { UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = root };
        foreach (var arg in new[] { "-NoProfile", "-NonInteractive", "-Command", "Start-Sleep -Seconds 30" }) start.ArgumentList.Add(arg);
        start.Environment.Clear(); start.Environment["SystemRoot"] = Environment.GetEnvironmentVariable("SystemRoot"); start.Environment["WINDIR"] = Environment.GetEnvironmentVariable("SystemRoot"); start.Environment["TEMP"] = root; start.Environment["TMP"] = root;
        using var child = System.Diagnostics.Process.Start(start);
        try
        {
            string pid = child.Id.ToString(System.Globalization.CultureInfo.InvariantCulture), creation = child.StartTime.ToUniversalTime().ToFileTimeUtc().ToString(System.Globalization.CultureInfo.InvariantCulture);
            using (var lifetime = new CollectorLifetime((uint)child.Id, Int64.Parse(creation))) Check(!lifetime.WaitUntil(DateTimeOffset.UtcNow.AddMilliseconds(20)));
            using (var foreign = new CollectorLifetime((uint)child.Id, Int64.Parse(creation) + 1)) Check(foreign.WaitUntil(DateTimeOffset.UtcNow.AddMinutes(1)));
            Check(!child.HasExited); Check(AssignProcessToJobObject(job, child.Handle));
            var member = new RunResource("process", pid, creation);
            var jobResource = new RunResource("job", jobName, Json(new { runNonce = run, members = new[] { new { pid, creation } }, membersSha256 = HeldFile.Hash(Encoding.UTF8.GetBytes(pid + ":" + creation)) }));
            var reaper = new JobReaper(run); Check(!reaper.Absent(jobResource)); reaper.Destroy(jobResource); Check(reaper.Absent(jobResource));
            using var exited = new CollectorLifetime((uint)child.Id, Int64.Parse(creation)); Check(exited.WaitUntil(DateTimeOffset.UtcNow.AddMinutes(1)));
            int reaped = 0; Check(Supervisor.Run(exited, DateTimeOffset.UtcNow.AddMinutes(1), () => false, () => { ++reaped; return true; }, () => Check(false))); Check(reaped == 1);
        }
        finally { if (!child.HasExited) { child.Kill(); child.WaitForExit(); } }
        return count;
    }
}
