// Job recovery producer owner: Builder A win-sac-sign-sa; boundary naming/member admission and deployment owner: MAIN.
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Win32.SafeHandles;

namespace Murage.Witness
{
    public interface IRecoveryJob : IDisposable
    {
        uint ActiveProcesses { get; }
        IReadOnlyList<uint> Pids { get; }
        void Terminate(int milliseconds);
    }
    public interface IJobReaperApi { IRecoveryJob Open(string name, bool terminate); }
    public sealed class JobReaper : BoundReaper
    {
        private readonly IJobReaperApi api;
        private readonly IResourceReaper processes;
        private readonly long deadline = Environment.TickCount64 + WitnessCodec.CaseMilliseconds;
        public JobReaper(string runNonce) : this(runNonce, new WindowsJobReaperApi(), new ProcessReaper()) { }
        public JobReaper(string runNonce, IJobReaperApi api, IResourceReaper processes) : base(runNonce) { this.api = api; this.processes = processes; }
        private List<RunResource> Members(RunResource resource)
        {
            using var doc = Binding(resource, "job", "members", "membersSha256");
            if (!Regex.IsMatch(resource.Id, @"\AGlobal\\MurageWitness-" + RunNonce + @"-[0-9]+\z")) throw WitnessCodec.Reject("JOB_IDENTITY");
            var result = new List<RunResource>(); var seen = new HashSet<string>();
            foreach (var member in doc.RootElement.GetProperty("members").EnumerateArray())
            {
                WitnessCodec.Fields(member, "pid", "creation"); string pid = WitnessCodec.Text(member, "pid"), creation = WitnessCodec.Text(member, "creation");
                if (!Regex.IsMatch(pid, @"\A[1-9][0-9]*\z") || !UInt32.TryParse(pid, out _) || !Regex.IsMatch(creation, @"\A[1-9][0-9]*\z") || !Int64.TryParse(creation, out _) || !seen.Add(pid)) throw WitnessCodec.Reject("JOB_MEMBERS");
                result.Add(new RunResource("process", pid, creation));
            }
            string canonical = String.Join("\n", result.Select(r => r.Id + ":" + r.Incarnation));
            if (HeldFile.Hash(Encoding.UTF8.GetBytes(canonical)) != WitnessCodec.Text(doc.RootElement, "membersSha256")) throw WitnessCodec.Reject("JOB_MEMBERS");
            return result;
        }
        public override bool Absent(RunResource resource)
        {
            var members = Members(resource); using var job = api.Open(resource.Id, false);
            bool empty = job == null || job.ActiveProcesses == 0;
            bool gone = true; foreach (var member in members) if (!processes.Absent(member)) gone = false;
            return empty && gone;
        }
        public override void Destroy(RunResource resource)
        {
            var members = Members(resource); using var job = api.Open(resource.Id, true);
            if (job == null) { foreach (var member in members) if (!processes.Absent(member)) processes.Destroy(member); return; }
            if (job.Pids.Any(pid =>
            {
                var member = members.SingleOrDefault(r => r.Id == pid.ToString(CultureInfo.InvariantCulture));
                return member == null || processes.Absent(member);
            }) || job.ActiveProcesses > members.Count) throw WitnessCodec.Reject("JOB_MEMBERS_CHANGED");
            long remaining = deadline - Environment.TickCount64;
            if (remaining <= 0) throw WitnessCodec.Reject("JOB_CLEANUP");
            job.Terminate((int)remaining);
            foreach (var member in members) if (!processes.Absent(member)) processes.Destroy(member);
        }
    }
    public sealed class WindowsJobReaperApi : IJobReaperApi
    {
        [StructLayout(LayoutKind.Sequential)] private struct Accounting { public long User, Kernel, PeriodUser, PeriodKernel; public uint Faults, Total, Active, Terminated; }
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern SafeFileHandle OpenJobObject(uint access, bool inherit, string name);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern bool QueryInformationJobObject(SafeFileHandle job, int type, IntPtr info, uint size, out uint returned);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern bool TerminateJobObject(SafeFileHandle job, uint exitCode);
        private sealed class Job : IRecoveryJob
        {
            private readonly SafeFileHandle handle;
            public Job(SafeFileHandle handle) { this.handle = handle; }
            public uint ActiveProcesses
            {
                get
                {
                    int size = Marshal.SizeOf<Accounting>(); var buffer = Marshal.AllocHGlobal(size);
                    try
                    {
                        if (!QueryInformationJobObject(handle, 1, buffer, (uint)size, out _)) throw WitnessCodec.Reject("JOB_QUERY");
                        return Marshal.PtrToStructure<Accounting>(buffer).Active;
                    }
                    finally { Marshal.FreeHGlobal(buffer); }
                }
            }
            public IReadOnlyList<uint> Pids
            {
                get
                {
                    const int size = 16 * 1024; var buffer = Marshal.AllocHGlobal(size);
                    try
                    {
                        if (!QueryInformationJobObject(handle, 3, buffer, size, out _)) throw WitnessCodec.Reject("JOB_QUERY");
                        uint assigned = (uint)Marshal.ReadInt32(buffer), count = (uint)Marshal.ReadInt32(buffer, 4);
                        if (count != assigned || count > (size - 8) / IntPtr.Size) throw WitnessCodec.Reject("JOB_QUERY");
                        var pids = new List<uint>(); for (int i = 0; i < count; ++i) pids.Add(checked((uint)Marshal.ReadIntPtr(buffer, 8 + i * IntPtr.Size).ToInt64()));
                        return pids;
                    }
                    finally { Marshal.FreeHGlobal(buffer); }
                }
            }
            public void Terminate(int milliseconds)
            {
                if (!TerminateJobObject(handle, 1)) throw WitnessCodec.Reject("JOB_CLEANUP");
                long until = Environment.TickCount64 + milliseconds;
                while (ActiveProcesses != 0)
                { if (Environment.TickCount64 >= until) throw WitnessCodec.Reject("JOB_CLEANUP"); System.Threading.Thread.Sleep(10); }
            }
            public void Dispose() => handle.Dispose();
        }
        public IRecoveryJob Open(string name, bool terminate)
        {
            if (!OperatingSystem.IsWindows()) throw WitnessCodec.Reject("WINDOWS_REQUIRED");
            var handle = OpenJobObject(4u | (terminate ? 8u : 0u), false, name);
            if (!handle.IsInvalid) return new Job(handle);
            int error = Marshal.GetLastWin32Error(); handle.Dispose();
            if (error == 2) return null;
            throw WitnessCodec.Reject("JOB_QUERY");
        }
    }
}
