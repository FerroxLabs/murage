// Pipe implementation owner: win-sac-sign; service installation and peer enrollment owner: MAIN.
using System;
using System.ComponentModel;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.Principal;
using Microsoft.Win32.SafeHandles;

namespace Murage.Signing
{
    public static class BoundaryPipe
    {
        [StructLayout(LayoutKind.Sequential)] private struct SecurityAttributes
        {
            public int Length;
            public IntPtr Descriptor;
            [MarshalAs(UnmanagedType.Bool)] public bool Inherit;
        }
        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(string text, uint revision, out IntPtr descriptor, out uint size);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern SafePipeHandle CreateNamedPipe(string name, uint access, uint mode, uint instances, uint output, uint input, uint timeout, ref SecurityAttributes attributes);
        [DllImport("kernel32.dll")] private static extern IntPtr LocalFree(IntPtr value);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetNamedPipeClientProcessId(SafePipeHandle pipe, out uint pid);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern uint GetProcessId(SafeProcessHandle process);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetProcessTimes(SafeProcessHandle process, out long creation, out long exit, out long kernel, out long user);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern uint WaitForSingleObject(SafeProcessHandle process, uint timeout);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern bool IsProcessInJob(SafeProcessHandle process, SafeFileHandle job, out bool member);

        // A first-instance pipe prevents name squatting; PIPE_REJECT_REMOTE_CLIENTS denies remote callers.
        public static NamedPipeServerStream Create(string workerSid, string bootstrapSid)
        {
            if (!RuntimeInformation.IsOSPlatform(OSPlatform.Windows)
                || !Sid(workerSid) || !Sid(bootstrapSid) || workerSid == bootstrapSid) throw new InvalidOperationException("WINDOWS_SIGNING_PIPE_REJECTED");
            IntPtr descriptor;
            uint size;
            string dacl = "O:SYG:SYD:P(A;;GA;;;SY)(A;;GRGW;;;" + workerSid + ")(A;;GRGW;;;" + bootstrapSid + ")";
            if (!ConvertStringSecurityDescriptorToSecurityDescriptor(dacl, 1, out descriptor, out size)) throw new Win32Exception();
            try
            {
                var attributes = new SecurityAttributes { Length = Marshal.SizeOf<SecurityAttributes>(), Descriptor = descriptor, Inherit = false };
                var handle = CreateNamedPipe(@"\\.\pipe\MurageSigningBoundary", 0x40080003, 0x8, 1, 65536, 65536, 0, ref attributes);
                if (handle.IsInvalid) { handle.Dispose(); throw new Win32Exception(); }
                try { return new NamedPipeServerStream(PipeDirection.InOut, true, false, handle); }
                catch { handle.Dispose(); throw; }
            }
            finally { LocalFree(descriptor); }
        }
        private static bool Sid(string value)
        {
            return value != null && System.Text.RegularExpressions.Regex.IsMatch(value, @"\AS-1-5-21-\d+-\d+-\d+-\d+\z");
        }
        public static uint ClientProcessId(NamedPipeServerStream pipe)
        {
            uint pid;
            if (!GetNamedPipeClientProcessId(pipe.SafePipeHandle, out pid) || pid == 0) throw new Win32Exception();
            return pid;
        }
        // The supervisor retains these handles from suspended creation through pipe disconnect.
        public static long AuthenticateClient(NamedPipeServerStream pipe, SafeProcessHandle expectedProcess, SafeFileHandle expectedJob, string expectedSid)
        {
            if (!RuntimeInformation.IsOSPlatform(OSPlatform.Windows) || !Sid(expectedSid)
                || expectedProcess == null || expectedProcess.IsInvalid || expectedProcess.IsClosed
                || expectedJob == null || expectedJob.IsInvalid || expectedJob.IsClosed) throw new InvalidOperationException("WINDOWS_SIGNING_PEER_REJECTED");
            uint pid = ClientProcessId(pipe);
            long creation, exit, kernel, user; bool member;
            if (WaitForSingleObject(expectedProcess, 0) != 258 || pid != GetProcessId(expectedProcess)
                || !GetProcessTimes(expectedProcess, out creation, out exit, out kernel, out user) || creation <= 0
                || !IsProcessInJob(expectedProcess, expectedJob, out member) || !member) throw new InvalidOperationException("WINDOWS_SIGNING_PEER_REJECTED");
            string actualSid = null;
            pipe.RunAsClient(() => { using (var identity = WindowsIdentity.GetCurrent(true)) actualSid = identity?.User?.Value; });
            if (actualSid != expectedSid) throw new InvalidOperationException("WINDOWS_SIGNING_PEER_REJECTED");
            return creation;
        }
    }
}
