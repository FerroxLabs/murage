// Native process adapter producer owner: win-sac-sign; protected admission and independent supervisor consumer owner: MAIN.
using System;
using System.Globalization;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace Murage.Witness
{
    public interface IProcessIncarnation : IDisposable
    {
        long Creation { get; }
        bool Exited { get; }
        void Terminate(int milliseconds);
    }
    public interface IProcessReaperApi { IProcessIncarnation Open(uint pid, bool terminate); }
    public sealed class ProcessReaper : IResourceReaper
    {
        [DllImport("kernel32.dll", SetLastError = true)] private static extern SafeProcessHandle OpenProcess(uint access, bool inherit, uint pid);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetProcessTimes(SafeProcessHandle process, out long creation, out long exit, out long kernel, out long user);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern uint WaitForSingleObject(SafeProcessHandle process, uint milliseconds);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern bool TerminateProcess(SafeProcessHandle process, uint exitCode);
        private readonly long deadline = Environment.TickCount64 + WitnessCodec.CaseMilliseconds;
        private readonly IProcessReaperApi api;
        public readonly HashSet<RunResource> Retained = new HashSet<RunResource>();
        public ProcessReaper() : this(new NativeApi()) { }
        public ProcessReaper(IProcessReaperApi api) { this.api = api ?? throw new ArgumentNullException(nameof(api)); }
        private sealed class NativeProcess : IProcessIncarnation
        {
            private readonly SafeProcessHandle handle;
            public long Creation { get; }
            public NativeProcess(SafeProcessHandle handle)
            {
                this.handle = handle;
                if (!GetProcessTimes(handle, out var creation, out _, out _, out _)) { handle.Dispose(); throw WitnessCodec.Reject("PROCESS_QUERY"); }
                Creation = creation;
            }
            public bool Exited
            {
                get { uint result = WaitForSingleObject(handle, 0); if (result != 0 && result != 258) throw WitnessCodec.Reject("PROCESS_QUERY"); return result == 0; }
            }
            public void Terminate(int milliseconds)
            {
                if (milliseconds <= 0 || !TerminateProcess(handle, 1) || WaitForSingleObject(handle, (uint)milliseconds) != 0) throw WitnessCodec.Reject("PROCESS_CLEANUP");
            }
            public void Dispose() => handle.Dispose();
        }
        private sealed class NativeApi : IProcessReaperApi
        {
            public IProcessIncarnation Open(uint pid, bool terminate)
            {
                if (!OperatingSystem.IsWindows()) throw WitnessCodec.Reject("WINDOWS_REQUIRED");
                var handle = OpenProcess(0x100000 | 0x1000u | (terminate ? 1u : 0u), false, pid);
                if (!handle.IsInvalid) return new NativeProcess(handle);
                int error = Marshal.GetLastWin32Error(); handle.Dispose();
                if (error == 87) return null;
                throw WitnessCodec.Reject("PROCESS_QUERY");
            }
        }
        private static (uint Pid, long Creation) Identity(RunResource resource)
        {
            resource.Validate();
            if (resource.Type != "process"
                || !UInt32.TryParse(resource.Id, NumberStyles.None, CultureInfo.InvariantCulture, out var pid) || pid == 0 || pid.ToString(CultureInfo.InvariantCulture) != resource.Id
                || !Int64.TryParse(resource.Incarnation, NumberStyles.None, CultureInfo.InvariantCulture, out var creation) || creation <= 0 || creation.ToString(CultureInfo.InvariantCulture) != resource.Incarnation)
                throw WitnessCodec.Reject("PROCESS_IDENTITY");
            return (pid, creation);
        }
        public bool Absent(RunResource resource)
        {
            var id = Identity(resource); using var process = api.Open(id.Pid, false);
            if (process == null) return true;
            if (process.Creation != id.Creation) { Retained.Add(resource); return true; }
            return process.Exited;
        }
        public void Destroy(RunResource resource)
        {
            var id = Identity(resource); using var process = api.Open(id.Pid, true);
            if (process == null) return;
            if (process.Creation != id.Creation) { Retained.Add(resource); throw WitnessCodec.Reject("PROCESS_REUSED"); }
            if (process.Exited) return;
            long remaining = deadline - Environment.TickCount64;
            if (remaining <= 0) throw WitnessCodec.Reject("PROCESS_CLEANUP");
            process.Terminate((int)remaining);
        }
    }
}
