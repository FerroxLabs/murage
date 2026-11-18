// S4 launcher/evaluator producer owner: Builder B; signed-candidate mechanism acceptance owner: GrokBuild/MAIN.
using System;
using System.Collections.Generic;
using System.Linq;

namespace Murage.Witness
{
    public sealed record ProcessIdentity(uint Pid, long Creation, string ImageSha256, string ImagePath);
    public sealed record S4Measurement(ProcessIdentity Failure, ProcessIdentity TokenOwner, ProcessIdentity Success, ProcessIdentity Witness,
        string Api, uint RequestedAccess, bool NativeSucceeded, int NativeError, string RefusalCode, bool EngineSpawned, bool JobStarted, bool SuccessNativeCall, TokenMeasurement SuccessToken, bool SuccessAdjustAccessGranted, ProcessIdentity SuspendedCreatedProcess, bool OsFeasibilityOnly);
    public interface IS4ProcessApi
    {
        void AssertStandardCaller();
        void ArmContainment();
        ProcessIdentity CreateSuspended();
        string PrimaryTokenId(ProcessIdentity process);
        void DenyOwnAdjustPrivilege(ProcessIdentity process);
        void Resume(ProcessIdentity process);
        void Terminate(ProcessIdentity process);
    }
    public static class S4FaultLauncher
    {
        public static void Launch(IS4ProcessApi api, ProcessIdentity witness, ProcessIdentity success, Action<ProcessIdentity> register, Action<ProcessIdentity> observe)
        {
            api.AssertStandardCaller();
            api.ArmContainment();
            ProcessIdentity failure = api.CreateSuspended();
            try
            {
                register(failure);
                string token = api.PrimaryTokenId(failure);
                if (Same(failure, witness) || Same(failure, success) || String.IsNullOrEmpty(token)
                    || token == api.PrimaryTokenId(witness) || token == api.PrimaryTokenId(success)) throw WitnessCodec.Reject("S4_TOKEN_NOT_DISJOINT");
                api.DenyOwnAdjustPrivilege(failure); api.Resume(failure); observe(failure);
            }
            finally { api.Terminate(failure); }
        }
        private static bool Same(ProcessIdentity a, ProcessIdentity b) => a.Pid == b.Pid && a.Creation == b.Creation;
        public static void Evaluate(S4Measurement measurement, string installedImageSha256, string installedImagePath)
        {
            WitnessCodec.Absolute(installedImagePath);
            foreach (var process in new[] { measurement.Failure, measurement.TokenOwner, measurement.Success, measurement.Witness })
                if (process.Pid == 0 || process.Creation <= 0 || !WitnessCodec.Hex(process.ImageSha256, 64)) throw WitnessCodec.Reject("S4_PROCESS_BINDING");
            if (measurement.OsFeasibilityOnly || !Same(measurement.SuspendedCreatedProcess, measurement.Failure)
                || !String.Equals(measurement.Failure.ImagePath, installedImagePath, StringComparison.OrdinalIgnoreCase)
                || !String.Equals(measurement.Success.ImagePath, installedImagePath, StringComparison.OrdinalIgnoreCase)
                || !WitnessCodec.Hex(installedImageSha256, 64) || measurement.Failure.ImageSha256 != installedImageSha256 || measurement.Success.ImageSha256 != installedImageSha256
                || !Same(measurement.Failure, measurement.TokenOwner) || Same(measurement.Failure, measurement.Success)
                || Same(measurement.Failure, measurement.Witness) || Same(measurement.Success, measurement.Witness)
                || measurement.Api != "OpenProcessToken" || measurement.RequestedAccess != 0x28 || measurement.NativeSucceeded || measurement.NativeError != 5
                || measurement.RefusalCode != "EPOWER" || measurement.EngineSpawned || measurement.JobStarted
                || !measurement.SuccessAdjustAccessGranted || !measurement.SuccessNativeCall || !measurement.SuccessToken.Standard || !measurement.SuccessToken.ShutdownRemoved) throw WitnessCodec.Reject("S4_NATIVE_FAILURE_NOT_PROVEN");
        }
    }
}

namespace Murage.Witness
{
    public sealed class WindowsS4ProcessApi : IS4ProcessApi, IDisposable
    {
        [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential, CharSet = System.Runtime.InteropServices.CharSet.Unicode)]
        private struct Startup { public int Size; public string Reserved, Desktop, Title; public uint X, Y, Width, Height, CharsX, CharsY, Fill, Flags; public short Show, ReservedSize; public IntPtr ReservedBytes, Input, Output, Error; }
        [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
        private struct Child { public IntPtr Process, Thread; public uint Pid, Tid; }
        [System.Runtime.InteropServices.DllImport("kernel32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode, SetLastError = true)]
        private static extern bool CreateProcess(string application, System.Text.StringBuilder command, IntPtr processSecurity, IntPtr threadSecurity, bool inherit, uint flags, byte[] environment, string directory, ref StartupExtended startup, out Child child);
        [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
        private struct StartupExtended { public Startup Startup; public IntPtr Attributes; }
        [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
        private struct JobLimits
        {
            public long ProcessTime, JobTime; public uint Flags;
            public UIntPtr MinWorkingSet, MaxWorkingSet; public uint ActiveProcesses;
            public UIntPtr Affinity; public uint Priority, Scheduling;
        }
        [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
        private struct JobExtendedLimits
        {
            public JobLimits Basic; public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes;
            public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
        }
        [System.Runtime.InteropServices.DllImport("kernel32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode, SetLastError = true)] private static extern IntPtr CreateJobObject(IntPtr security, string name);
        [System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError = true)] private static extern bool SetInformationJobObject(IntPtr job, int kind, ref JobExtendedLimits limits, uint size);
        [System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError = true)] private static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, uint flags, ref UIntPtr size);
        [System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError = true)] private static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, UIntPtr attribute, IntPtr value, UIntPtr size, IntPtr previous, IntPtr returned);
        [System.Runtime.InteropServices.DllImport("kernel32.dll")] private static extern void DeleteProcThreadAttributeList(IntPtr list);
        [System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetProcessTimes(IntPtr process, out long creation, out long exit, out long kernel, out long user);
        [System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError = true)] private static extern uint ResumeThread(IntPtr thread);
        [System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError = true)] private static extern bool TerminateProcess(IntPtr process, uint code);
        [System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
        [System.Runtime.InteropServices.DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
        [System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError = true)] private static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
        [System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetExitCodeProcess(IntPtr process, out uint code);
        [System.Runtime.InteropServices.DllImport("kernel32.dll")] private static extern IntPtr LocalFree(IntPtr value);
        [System.Runtime.InteropServices.DllImport("advapi32.dll", SetLastError = true)] private static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
        [System.Runtime.InteropServices.DllImport("advapi32.dll", SetLastError = true)] private static extern bool GetTokenInformation(IntPtr token, int kind, IntPtr data, int length, out int needed);
        [System.Runtime.InteropServices.DllImport("advapi32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode, SetLastError = true)] private static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(string text, uint revision, out IntPtr descriptor, out uint size);
        [System.Runtime.InteropServices.DllImport("advapi32.dll", SetLastError = true)] private static extern bool SetKernelObjectSecurity(IntPtr handle, uint information, IntPtr descriptor);
        private readonly string path, directory;
        private readonly HeldFile image;
        private readonly byte[] environment;
        private readonly long deadline;
        private IntPtr containment;
        private readonly Dictionary<ProcessIdentity, Child> children = new Dictionary<ProcessIdentity, Child>();
        public WindowsS4ProcessApi(string sealedImagePath, string imageSha256, string directory, IReadOnlyDictionary<string, string> environment, long deadline)
        {
            if (deadline <= Environment.TickCount64 || deadline - Environment.TickCount64 > WitnessCodec.CaseMilliseconds) throw WitnessCodec.Reject("S4_DEADLINE");
            this.deadline = deadline;
            WitnessCodec.Absolute(sealedImagePath); WitnessCodec.Absolute(directory);
            this.path = sealedImagePath; this.directory = directory;
            if (!environment.ContainsKey("SystemRoot") || environment.Keys.Any(name => name != "SystemRoot" && name != "WINDIR" && name != "TEMP" && name != "TMP")) throw WitnessCodec.Reject("S4_ENVIRONMENT");
            foreach (var entry in environment) { if (entry.Value == null || entry.Value.Contains('\0')) throw WitnessCodec.Reject("S4_ENVIRONMENT"); WitnessCodec.Absolute(entry.Value); }
            this.environment = System.Text.Encoding.Unicode.GetBytes(String.Join("\0", environment.OrderBy(entry => entry.Key, StringComparer.OrdinalIgnoreCase).Select(entry => entry.Key + "=" + entry.Value)) + "\0\0");
            image = new HeldFile(path, WitnessCodec.CaptureLimit, imageSha256);
        }
        public void AssertStandardCaller()
        {
            if (!TokenObserver.Current().Standard) throw WitnessCodec.Reject("S4_CALLER_NOT_STANDARD");
        }
        public void ArmContainment()
        {
            if (containment != IntPtr.Zero) throw WitnessCodec.Reject("S4_CONTAINMENT");
            var job = CreateJobObject(IntPtr.Zero, null);
            if (job == IntPtr.Zero) throw WitnessCodec.Reject("S4_CONTAINMENT");
            var limits = new JobExtendedLimits { Basic = new JobLimits { Flags = 0x2000 } };
            if (!SetInformationJobObject(job, 9, ref limits, (uint)System.Runtime.InteropServices.Marshal.SizeOf<JobExtendedLimits>()))
            { CloseHandle(job); throw WitnessCodec.Reject("S4_CONTAINMENT"); }
            containment = job;
        }
        public ProcessIdentity CreateSuspended()
        {
            if (containment == IntPtr.Zero) throw WitnessCodec.Reject("S4_CONTAINMENT");
            UIntPtr size = UIntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
            if (size == UIntPtr.Zero || size.ToUInt64() > 1024 * 1024) throw WitnessCodec.Reject("S4_CONTAINMENT");
            var list = System.Runtime.InteropServices.Marshal.AllocHGlobal(checked((int)size.ToUInt64()));
            var jobValue = System.Runtime.InteropServices.Marshal.AllocHGlobal(IntPtr.Size);
            bool initialized = false;
            try
            {
                if (!InitializeProcThreadAttributeList(list, 1, 0, ref size)) throw WitnessCodec.Reject("S4_CONTAINMENT");
                initialized = true; System.Runtime.InteropServices.Marshal.WriteIntPtr(jobValue, containment);
                // JOB_LIST makes ownership atomic with creation; a later AssignProcessToJobObject leaves a crash window.
                if (!UpdateProcThreadAttribute(list, 0, new UIntPtr(0x2000D), jobValue, new UIntPtr((uint)IntPtr.Size), IntPtr.Zero, IntPtr.Zero)) throw WitnessCodec.Reject("S4_CONTAINMENT");
                var startup = new StartupExtended { Startup = new Startup { Size = System.Runtime.InteropServices.Marshal.SizeOf<StartupExtended>() }, Attributes = list };
                if (!CreateProcess(path, new System.Text.StringBuilder("\"" + path + "\""), IntPtr.Zero, IntPtr.Zero, false, 0x08080404, environment, directory, ref startup, out var child)) throw WitnessCodec.Reject("S4_CREATE");
                try
                {
                    if (!GetProcessTimes(child.Process, out long creation, out _, out _, out _) || creation <= 0) throw WitnessCodec.Reject("S4_CREATE");
                    var identity = new ProcessIdentity(child.Pid, creation, HeldFile.Hash(image.Bytes), path); children.Add(identity, child); return identity;
                }
                catch { TerminateProcess(child.Process, 1); CloseHandle(child.Thread); CloseHandle(child.Process); throw; }
            }
            finally
            {
                if (initialized) DeleteProcThreadAttributeList(list);
                System.Runtime.InteropServices.Marshal.FreeHGlobal(jobValue); System.Runtime.InteropServices.Marshal.FreeHGlobal(list);
            }
        }
        private static T Token<T>(ProcessIdentity identity, uint access, Func<IntPtr, T> action)
        {
            var process = OpenProcess(0x1000, false, identity.Pid);
            if (process == IntPtr.Zero) throw WitnessCodec.Reject("S4_PROCESS_BINDING");
            try
            {
                if (!GetProcessTimes(process, out long creation, out _, out _, out _) || creation != identity.Creation || !OpenProcessToken(process, access, out var token)) throw WitnessCodec.Reject("S4_PROCESS_BINDING");
                try { return action(token); } finally { CloseHandle(token); }
            }
            finally { CloseHandle(process); }
        }
        public string PrimaryTokenId(ProcessIdentity identity) => Token(identity, 8, token => {
            var data = System.Runtime.InteropServices.Marshal.AllocHGlobal(256);
            try
            {
                if (!GetTokenInformation(token, 10, data, 256, out int length) || length < 8) throw WitnessCodec.Reject("S4_TOKEN_QUERY");
                return System.Runtime.InteropServices.Marshal.ReadInt64(data).ToString(System.Globalization.CultureInfo.InvariantCulture);
            }
            finally { System.Runtime.InteropServices.Marshal.FreeHGlobal(data); }
        });
        public void DenyOwnAdjustPrivilege(ProcessIdentity identity)
        {
            if (!children.ContainsKey(identity)) throw WitnessCodec.Reject("S4_PROCESS_BINDING");
            Token(identity, 0x40008, token => {
                using var owner = new System.Security.Principal.WindowsIdentity(token);
                string sid = owner.User?.Value ?? throw WitnessCodec.Reject("S4_TOKEN_QUERY");
                string sddl = "D:P(D;;0x20;;;" + sid + ")(A;;0x20008;;;" + sid + ")(A;;GA;;;SY)";
                if (!ConvertStringSecurityDescriptorToSecurityDescriptor(sddl, 1, out var descriptor, out _)) throw WitnessCodec.Reject("S4_TOKEN_DACL");
                try { if (!SetKernelObjectSecurity(token, 4, descriptor)) throw WitnessCodec.Reject("S4_TOKEN_DACL"); }
                finally { LocalFree(descriptor); }
                return true;
            });
        }
        public void Resume(ProcessIdentity identity) { if (!children.TryGetValue(identity, out var child) || ResumeThread(child.Thread) != 1) throw WitnessCodec.Reject("S4_RESUME"); }
        public uint WaitForExit(ProcessIdentity identity, int remainingMilliseconds)
        {
            if (remainingMilliseconds < 0 || remainingMilliseconds > WitnessCodec.CaseMilliseconds || !children.TryGetValue(identity, out var child)
                || WaitForSingleObject(child.Process, (uint)remainingMilliseconds) != 0 || !GetExitCodeProcess(child.Process, out uint code)) throw WitnessCodec.Reject("S4_WAIT");
            return code;
        }
        public void Terminate(ProcessIdentity identity)
        {
            if (!children.Remove(identity, out var child)) throw WitnessCodec.Reject("S4_PROCESS_BINDING");
            try
            {
                if (WaitForSingleObject(child.Process, 0) != 0 && !TerminateProcess(child.Process, 1)) throw WitnessCodec.Reject("S4_TERMINATE");
                if (WaitForSingleObject(child.Process, (uint)Remaining(deadline, Environment.TickCount64)) != 0) throw WitnessCodec.Reject("S4_TERMINATE");
            }
            finally { CloseHandle(child.Thread); CloseHandle(child.Process); }
        }
        internal static int Remaining(long deadline, long now) => (int)Math.Clamp(deadline - now, 0, WitnessCodec.CaseMilliseconds);
        public void Dispose()
        {
            try { foreach (var identity in children.Keys.ToArray()) Terminate(identity); }
            finally { if (containment != IntPtr.Zero) { CloseHandle(containment); containment = IntPtr.Zero; } image.Dispose(); }
        }
    }
}
