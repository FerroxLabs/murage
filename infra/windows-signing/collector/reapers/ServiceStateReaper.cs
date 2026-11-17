// Service restoration producer owner: Builder A win-sac-sign-sa; protected exclusive-service/baseline admission owner: MAIN.
using System;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;

namespace Murage.Witness
{
    public sealed record ServiceBaseline(uint StartType, uint State, string BinaryPath, string Sha256);
    public interface IServiceStateReaperApi
    {
        ServiceBaseline Read(string name);
        void Restore(string name, ServiceBaseline baseline, int milliseconds);
    }
    public sealed class ServiceStateReaper : BoundReaper
    {
        private readonly IServiceStateReaperApi api;
        private readonly long deadline = Environment.TickCount64 + WitnessCodec.CaseMilliseconds;
        public ServiceStateReaper(string runNonce) : this(runNonce, new WindowsServiceStateReaperApi()) { }
        public ServiceStateReaper(string runNonce, IServiceStateReaperApi api) : base(runNonce) { this.api = api; }
        private ServiceBaseline Baseline(RunResource resource)
        {
            using var doc = Binding(resource, "service-state", "startType", "state", "binaryPath", "sha256", "exclusiveRunNonce"); var row = doc.RootElement;
            if (!Regex.IsMatch(resource.Id, @"\A[A-Za-z0-9_.-]{1,256}\z") || WitnessCodec.Text(row, "exclusiveRunNonce") != RunNonce) throw WitnessCodec.Reject("SERVICE_EXCLUSIVITY");
            var baseline = new ServiceBaseline(row.GetProperty("startType").GetUInt32(), row.GetProperty("state").GetUInt32(), WitnessCodec.Text(row, "binaryPath"), WitnessCodec.Text(row, "sha256"));
            if (baseline.StartType < 2 || baseline.StartType > 4 || baseline.State != 1 && baseline.State != 4 && baseline.State != 7 || !WitnessCodec.Hex(baseline.Sha256, 64)) throw WitnessCodec.Reject("SERVICE_BASELINE");
            WindowsServiceStateReaperApi.Executable(baseline.BinaryPath); return baseline;
        }
        public override bool Absent(RunResource resource)
        { var baseline = Baseline(resource); return api.Read(resource.Id) == baseline; }
        public override void Destroy(RunResource resource)
        {
            var baseline = Baseline(resource); var current = api.Read(resource.Id);
            if (current == baseline) return;
            if (current == null || current.BinaryPath != baseline.BinaryPath || current.Sha256 != baseline.Sha256) throw WitnessCodec.Reject("SERVICE_IDENTITY_CHANGED");
            long remaining = deadline - Environment.TickCount64;
            if (remaining <= 0) throw WitnessCodec.Reject("SERVICE_RESTORE");
            api.Restore(resource.Id, baseline, (int)remaining);
        }
    }
    public sealed class WindowsServiceStateReaperApi : IServiceStateReaperApi
    {
        [StructLayout(LayoutKind.Sequential)] private struct Config
        { public uint Type, Start, Error; public IntPtr Binary, Group; public uint Tag; public IntPtr Dependencies, Account, Display; }
        [StructLayout(LayoutKind.Sequential)] private struct Status { public uint Type, State, Controls, WinExit, Exit, Checkpoint, Hint; }
        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern IntPtr OpenSCManager(string machine, string database, uint access);
        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern IntPtr OpenService(IntPtr manager, string name, uint access);
        [DllImport("advapi32.dll")] private static extern bool CloseServiceHandle(IntPtr handle);
        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool QueryServiceConfig(IntPtr service, IntPtr config, uint size, out uint needed);
        [DllImport("advapi32.dll", SetLastError = true)] private static extern bool QueryServiceStatus(IntPtr service, out Status status);
        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool ChangeServiceConfig(IntPtr service, uint type, uint start, uint error, string binary, string group, IntPtr tag, string dependencies, string account, string password, string display);
        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool StartService(IntPtr service, uint argc, IntPtr argv);
        [DllImport("advapi32.dll", SetLastError = true)] private static extern bool ControlService(IntPtr service, uint control, out Status status);
        internal static string Executable(string binary)
        {
            if (String.IsNullOrEmpty(binary)) throw WitnessCodec.Reject("SERVICE_BINARY");
            string path;
            if (binary[0] == '"') { int end = binary.IndexOf('"', 1); if (end < 0) throw WitnessCodec.Reject("SERVICE_BINARY"); path = binary.Substring(1, end - 1); }
            else { if (binary.Contains(' ') || binary.Contains('\t')) throw WitnessCodec.Reject("SERVICE_BINARY"); path = binary; }
            WitnessCodec.Absolute(path); if (!path.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)) throw WitnessCodec.Reject("SERVICE_BINARY"); return path;
        }
        private static IntPtr Open(string name, uint access)
        {
            if (!OperatingSystem.IsWindows()) throw WitnessCodec.Reject("WINDOWS_REQUIRED");
            var manager = OpenSCManager(null, null, 1); if (manager == IntPtr.Zero) throw WitnessCodec.Reject("SERVICE_QUERY");
            try
            {
                var service = OpenService(manager, name, access);
                if (service == IntPtr.Zero && Marshal.GetLastWin32Error() != 1060) throw WitnessCodec.Reject("SERVICE_QUERY");
                return service;
            }
            finally { CloseServiceHandle(manager); }
        }
        private static ServiceBaseline Read(IntPtr service)
        {
            QueryServiceConfig(service, IntPtr.Zero, 0, out var needed);
            if (Marshal.GetLastWin32Error() != 122 || needed == 0 || needed > 8192) throw WitnessCodec.Reject("SERVICE_QUERY");
            var buffer = Marshal.AllocHGlobal((int)needed);
            try
            {
                if (!QueryServiceConfig(service, buffer, needed, out _) || !QueryServiceStatus(service, out var status)) throw WitnessCodec.Reject("SERVICE_QUERY");
                var config = Marshal.PtrToStructure<Config>(buffer); string binary = Marshal.PtrToStringUni(config.Binary);
                using var held = new HeldFile(Executable(binary), WitnessCodec.CaptureLimit);
                return new ServiceBaseline(config.Start, status.State, binary, HeldFile.Hash(held.Bytes));
            }
            finally { Marshal.FreeHGlobal(buffer); }
        }
        public ServiceBaseline Read(string name)
        { var service = Open(name, 1 | 4); if (service == IntPtr.Zero) return null; try { return Read(service); } finally { CloseServiceHandle(service); } }
        private static uint State(IntPtr service)
        { if (!QueryServiceStatus(service, out var status)) throw WitnessCodec.Reject("SERVICE_QUERY"); return status.State; }
        private static void Wait(IntPtr service, uint state, long deadline)
        {
            while (State(service) != state)
            { if (Environment.TickCount64 >= deadline) throw WitnessCodec.Reject("SERVICE_RESTORE"); System.Threading.Thread.Sleep(10); }
        }
        public void Restore(string name, ServiceBaseline baseline, int milliseconds)
        {
            var service = Open(name, 1 | 2 | 4 | 16 | 32 | 64); if (service == IntPtr.Zero) throw WitnessCodec.Reject("SERVICE_QUERY");
            bool temporaryStartType = false;
            try
            {
                using var held = new HeldFile(Executable(baseline.BinaryPath), WitnessCodec.CaptureLimit, baseline.Sha256);
                var current = Read(service);
                if (current.BinaryPath != baseline.BinaryPath || current.Sha256 != baseline.Sha256) throw WitnessCodec.Reject("SERVICE_IDENTITY_CHANGED");
                long deadline = Environment.TickCount64 + milliseconds;
                // A disabled baseline may have been running; enable only for the restoration start, then restore the exact type.
                uint state = State(service);
                while (state == 2 || state == 3 || state == 5 || state == 6)
                {
                    if (Environment.TickCount64 >= deadline) throw WitnessCodec.Reject("SERVICE_RESTORE");
                    System.Threading.Thread.Sleep(10); state = State(service);
                }
                if (state != 1 && state != 4 && state != 7) throw WitnessCodec.Reject("SERVICE_QUERY");
                uint interim = baseline.State != 1 && baseline.StartType == 4 ? 3u : baseline.StartType;
                if (!ChangeServiceConfig(service, UInt32.MaxValue, interim, UInt32.MaxValue, null, null, IntPtr.Zero, null, null, null, null)) throw WitnessCodec.Reject("SERVICE_RESTORE");
                temporaryStartType = interim != baseline.StartType;
                if (baseline.State == 1 && state != 1)
                { if (!ControlService(service, 1, out _)) throw WitnessCodec.Reject("SERVICE_RESTORE"); Wait(service, 1, deadline); }
                else if (baseline.State != 1)
                {
                    if (state == 1) { if (!StartService(service, 0, IntPtr.Zero)) throw WitnessCodec.Reject("SERVICE_RESTORE"); Wait(service, 4, deadline); }
                    if (baseline.State == 4 && State(service) == 7) { if (!ControlService(service, 3, out _)) throw WitnessCodec.Reject("SERVICE_RESTORE"); Wait(service, 4, deadline); }
                    if (baseline.State == 7 && State(service) == 4) { if (!ControlService(service, 2, out _)) throw WitnessCodec.Reject("SERVICE_RESTORE"); Wait(service, 7, deadline); }
                }
                if (!ChangeServiceConfig(service, UInt32.MaxValue, baseline.StartType, UInt32.MaxValue, null, null, IntPtr.Zero, null, null, null, null)) throw WitnessCodec.Reject("SERVICE_RESTORE");
                temporaryStartType = false;
                if (Read(service) != baseline) throw WitnessCodec.Reject("SERVICE_RESTORE");
            }
            finally
            {
                try
                {
                    if (temporaryStartType && !ChangeServiceConfig(service, UInt32.MaxValue, baseline.StartType, UInt32.MaxValue, null, null, IntPtr.Zero, null, null, null, null))
                        throw WitnessCodec.Reject("SERVICE_RESTORE");
                }
                finally { CloseServiceHandle(service); }
            }
        }
    }
}
