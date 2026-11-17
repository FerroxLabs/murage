// Native process implementation owner: win-sac-sign; standard signing account and image enrollment owner: MAIN.
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace Murage.Signing
{
    public sealed class WindowsSigningProcessApi : ISigningProcessApi
    {
        [StructLayout(LayoutKind.Sequential)] private struct SecurityAttributes { public int Length; public IntPtr Descriptor; [MarshalAs(UnmanagedType.Bool)] public bool Inherit; }
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] private struct StartupInfo
        {
            public int Size; public string Reserved, Desktop, Title;
            public uint X, Y, XSize, YSize, XCount, YCount, Fill, Flags;
            public ushort Show, ReservedSize; public IntPtr ReservedBytes, Input, Output, Error;
        }
        [StructLayout(LayoutKind.Sequential)] private struct ProcessInfo { public IntPtr Process, Thread; public uint Pid, Tid; }
        [StructLayout(LayoutKind.Sequential)] private struct JobLimits
        {
            public long ProcessTime, JobTime; public uint Flags;
            public UIntPtr MinWorkingSet, MaxWorkingSet; public uint ActiveProcesses;
            public UIntPtr Affinity; public uint Priority, Scheduling;
        }
        [StructLayout(LayoutKind.Sequential)] private struct IoCounters { public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes; }
        [StructLayout(LayoutKind.Sequential)] private struct JobExtendedLimits
        {
            public JobLimits Basic; public IoCounters Io;
            public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
        }
        [StructLayout(LayoutKind.Sequential)] private struct SidAttributes { public IntPtr Sid; public uint Attributes; }
        [StructLayout(LayoutKind.Sequential)] private struct TokenGroups { public uint Count; public SidAttributes First; }
        [StructLayout(LayoutKind.Sequential)] private struct Luid { public uint Low; public int High; }
        [StructLayout(LayoutKind.Sequential)] private struct LuidAttributes { public Luid Luid; public uint Attributes; }
        [StructLayout(LayoutKind.Sequential)] private struct TokenPrivileges { public uint Count; public LuidAttributes First; }

        [DllImport("advapi32.dll", SetLastError = true)] private static extern bool GetTokenInformation(IntPtr token, int type, IntPtr buffer, int size, out int needed);
        [DllImport("advapi32.dll", SetLastError = true)] private static extern bool IsWellKnownSid(IntPtr sid, int type);
        [DllImport("advapi32.dll", SetLastError = true)] private static extern IntPtr GetSidSubAuthorityCount(IntPtr sid);
        [DllImport("advapi32.dll", SetLastError = true)] private static extern IntPtr GetSidSubAuthority(IntPtr sid, uint index);
        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool LookupPrivilegeName(string system, ref Luid luid, StringBuilder name, ref uint length);
        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(string text, uint revision, out IntPtr descriptor, out uint size);
        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool CreateProcessAsUser(IntPtr token, string application, StringBuilder command,
            ref SecurityAttributes processAttributes, ref SecurityAttributes threadAttributes, bool inherit, uint flags, IntPtr environment, string cwd, ref StartupInfo startup, out ProcessInfo info);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern IntPtr CreateJobObject(IntPtr attributes, string name);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern bool SetInformationJobObject(IntPtr job, int type, ref JobExtendedLimits information, uint size);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern uint ResumeThread(IntPtr thread);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetExitCodeProcess(IntPtr process, out uint code);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern bool TerminateProcess(IntPtr process, uint code);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern bool CloseHandle(IntPtr handle);
        [DllImport("kernel32.dll")] private static extern IntPtr LocalFree(IntPtr value);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool SetDllDirectory(string directory);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern bool SetDefaultDllDirectories(uint flags);

        public WindowsSigningProcessApi()
        {
            if (!RuntimeInformation.IsOSPlatform(OSPlatform.Windows)) throw SigningProcessSpec.Reject();
            // SetDllDirectory("") also removes CWD from ordinary child-process DLL search.
            if (!SetDefaultDllDirectories(0xA00) || !SetDllDirectory("")) throw SigningProcessSpec.Reject();
        }
        private static IntPtr TokenInfo(IntPtr token, int type)
        {
            int size;
            GetTokenInformation(token, type, IntPtr.Zero, 0, out size);
            if (size <= 0 || size > 1024 * 1024) throw SigningProcessSpec.Reject();
            var buffer = Marshal.AllocHGlobal(size);
            if (!GetTokenInformation(token, type, buffer, size, out size)) { Marshal.FreeHGlobal(buffer); throw SigningProcessSpec.Reject(); }
            return buffer;
        }
        public void AssertTokenSid(IntPtr token, string sid)
        {
            var info = TokenInfo(token, 1);
            try
            {
                var user = Marshal.PtrToStructure<SidAttributes>(info);
                if (new System.Security.Principal.SecurityIdentifier(user.Sid).Value != sid) throw SigningProcessSpec.Reject();
            }
            finally { Marshal.FreeHGlobal(info); }
        }
        public void AssertStandardTokenIdentity(IntPtr token)
        {
            foreach (var pair in new[] { (Type: 18, Value: 1), (Type: 20, Value: 0) })
            {
                var info = TokenInfo(token, pair.Type);
                try { if (Marshal.ReadInt32(info) != pair.Value) throw SigningProcessSpec.Reject(); }
                finally { Marshal.FreeHGlobal(info); }
            }
            var groups = TokenInfo(token, 2);
            try
            {
                int count = Marshal.ReadInt32(groups), offset = Marshal.OffsetOf<TokenGroups>(nameof(TokenGroups.First)).ToInt32();
                for (int i = 0; i < count; ++i)
                {
                    var group = Marshal.PtrToStructure<SidAttributes>(IntPtr.Add(groups, offset + i * Marshal.SizeOf<SidAttributes>()));
                    if (IsWellKnownSid(group.Sid, 26)) throw SigningProcessSpec.Reject(); // Includes a deny-only filtered admin group.
                }
            }
            finally { Marshal.FreeHGlobal(groups); }
            var integrity = TokenInfo(token, 25);
            try
            {
                var sid = Marshal.PtrToStructure<SidAttributes>(integrity).Sid;
                byte count = Marshal.ReadByte(GetSidSubAuthorityCount(sid));
                if (count == 0 || Marshal.ReadInt32(GetSidSubAuthority(sid, (uint)(count - 1))) != 0x2000) throw SigningProcessSpec.Reject();
            }
            finally { Marshal.FreeHGlobal(integrity); }
        }
        public void AssertStandardToken(IntPtr token)
        {
            AssertStandardTokenIdentity(token);
            var privileges = TokenInfo(token, 3);
            try
            {
                int count = Marshal.ReadInt32(privileges), offset = Marshal.OffsetOf<TokenPrivileges>(nameof(TokenPrivileges.First)).ToInt32();
                for (int i = 0; i < count; ++i)
                {
                    var privilege = Marshal.PtrToStructure<LuidAttributes>(IntPtr.Add(privileges, offset + i * Marshal.SizeOf<LuidAttributes>()));
                    var name = new StringBuilder(256); uint length = 256;
                    if (!LookupPrivilegeName(null, ref privilege.Luid, name, ref length)
                        || !new HashSet<string> { "SeChangeNotifyPrivilege", "SeIncreaseWorkingSetPrivilege", "SeTimeZonePrivilege" }.Contains(name.ToString())) throw SigningProcessSpec.Reject();
                }
            }
            finally { Marshal.FreeHGlobal(privileges); }
        }
        public IntPtr CreateJob()
        {
            var job = CreateJobObject(IntPtr.Zero, null);
            if (job == IntPtr.Zero) throw SigningProcessSpec.Reject();
            var limits = new JobExtendedLimits { Basic = new JobLimits { Flags = 0x2000 } }; // KILL_ON_JOB_CLOSE; no breakaway.
            if (!SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf<JobExtendedLimits>()))
            { CloseHandle(job); throw SigningProcessSpec.Reject(); }
            return job;
        }
        public SigningProcessHandles CreateSuspended(IntPtr token, SigningProcessSpec spec, byte[] environment)
        {
            if (environment == null || environment.Length < 4 || (environment.Length & 1) != 0) throw SigningProcessSpec.Reject();
            IntPtr descriptor = IntPtr.Zero, block = IntPtr.Zero;
            try
            {
                uint size;
                if (!ConvertStringSecurityDescriptorToSecurityDescriptor("O:SYG:SYD:P(A;;GA;;;SY)", 1, out descriptor, out size)) throw SigningProcessSpec.Reject();
                var attributes = new SecurityAttributes { Length = Marshal.SizeOf<SecurityAttributes>(), Descriptor = descriptor, Inherit = false };
                block = Marshal.AllocHGlobal(environment.Length); Marshal.Copy(environment, 0, block, environment.Length);
                var startup = new StartupInfo { Size = Marshal.SizeOf<StartupInfo>() };
                ProcessInfo info;
                if (!CreateProcessAsUser(token, spec.Executable, new StringBuilder("\"" + spec.Executable + "\" " + spec.Arguments), ref attributes, ref attributes,
                    false, 0x08000404, block, spec.WorkingDirectory, ref startup, out info)) throw SigningProcessSpec.Reject();
                return new SigningProcessHandles(info.Process, info.Thread);
            }
            finally
            {
                if (block != IntPtr.Zero) { for (int i = 0; i < environment.Length; ++i) Marshal.WriteByte(block, i, 0); Marshal.FreeHGlobal(block); }
                if (descriptor != IntPtr.Zero) LocalFree(descriptor);
            }
        }
        public void Assign(IntPtr job, IntPtr process) { if (!AssignProcessToJobObject(job, process)) throw SigningProcessSpec.Reject(); }
        public void Resume(IntPtr thread) { if (ResumeThread(thread) != 1) throw SigningProcessSpec.Reject(); }
        public async Task<int> WaitAsync(IntPtr process, CancellationToken cancellation)
        {
            while (true)
            {
                cancellation.ThrowIfCancellationRequested();
                uint wait = WaitForSingleObject(process, 0);
                if (wait == 0) { uint code; if (!GetExitCodeProcess(process, out code)) throw SigningProcessSpec.Reject(); return unchecked((int)code); }
                if (wait != 258) throw SigningProcessSpec.Reject();
                await Task.Delay(50, cancellation).ConfigureAwait(false);
            }
        }
        public void Terminate(IntPtr process)
        {
            if (WaitForSingleObject(process, 0) == 258 && !TerminateProcess(process, 1)) throw SigningProcessSpec.Reject();
        }
        public void Close(IntPtr handle) { if (!CloseHandle(handle)) throw SigningProcessSpec.Reject(); }
    }
}
