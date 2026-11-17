// Install recovery producer owner: Builder A win-sac-sign-sa; isolated per-user install/session admission owner: MAIN.
using System;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using Microsoft.Win32;
using Microsoft.Win32.SafeHandles;

namespace Murage.Witness
{
    public sealed record InstallIdentity(string Uninstaller, string Sha256, string FileId, string RootFileId, string UserSid, uint Session, string RegistryKey);
    public interface IInstallReaperApi
    {
        string RegisteredDirectory(InstallIdentity identity);
        void Uninstall(string directory, InstallIdentity identity, int milliseconds);
    }
    public sealed class InstallReaper : BoundReaper
    {
        private readonly string root;
        private readonly IInstallReaperApi api;
        private readonly FileReaper files;
        private readonly long deadline = Environment.TickCount64 + WitnessCodec.CaseMilliseconds;
        public InstallReaper(string runNonce, string root) : this(runNonce, root, new WindowsInstallReaperApi(), new WindowsFileReaperApi()) { }
        public InstallReaper(string runNonce, string root, IInstallReaperApi api, IFileReaperApi fileApi) : base(runNonce)
        { WitnessCodec.Absolute(root); this.root = root; this.api = api; files = new FileReaper(runNonce, root, fileApi); }
        private InstallIdentity Identity(RunResource resource)
        {
            using var doc = Binding(resource, "install", "uninstaller", "sha256", "fileId", "rootFileId", "userSid", "session", "registryKey"); var row = doc.RootElement;
            WitnessCodec.Absolute(resource.Id); string uninstaller = WitnessCodec.Text(row, "uninstaller"); WitnessCodec.Absolute(uninstaller);
            var id = new InstallIdentity(uninstaller, WitnessCodec.Text(row, "sha256"), WitnessCodec.Text(row, "fileId"), WitnessCodec.Text(row, "rootFileId"), WitnessCodec.Text(row, "userSid"), row.GetProperty("session").GetUInt32(), WitnessCodec.Text(row, "registryKey"));
            const string prefix = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\";
            if (!resource.Id.Equals(root, StringComparison.OrdinalIgnoreCase) || !uninstaller.StartsWith(root + "\\", StringComparison.OrdinalIgnoreCase) || !uninstaller.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)
                || !Regex.IsMatch(id.FileId, @"\A[a-f0-9]{16}:[a-f0-9]{32}\z") || !Regex.IsMatch(id.RootFileId, @"\A[a-f0-9]{16}:[a-f0-9]{32}\z")
                || !WitnessCodec.Hex(id.Sha256, 64) || !Regex.IsMatch(id.UserSid, @"\AS-1-5-21-[0-9]+-[0-9]+-[0-9]+-[0-9]+\z")
                || !id.RegistryKey.StartsWith(prefix, StringComparison.Ordinal) || !Regex.IsMatch(id.RegistryKey.Substring(prefix.Length), @"\A[A-Za-z0-9{}_.-]+\z")) throw WitnessCodec.Reject("INSTALL_IDENTITY");
            RootResource(resource, id).Validate(); return id;
        }
        private RunResource RootResource(RunResource resource, InstallIdentity id)
        {
            using var buffer = new MemoryStream();
            using (var writer = new System.Text.Json.Utf8JsonWriter(buffer))
            { writer.WriteStartObject(); writer.WriteString("runNonce", RunNonce); writer.WriteString("fileId", id.RootFileId); writer.WriteEndObject(); }
            return new RunResource("file", resource.Id, Encoding.UTF8.GetString(buffer.ToArray()));
        }
        public override bool Absent(RunResource resource)
        {
            var id = Identity(resource); bool absent = files.Absent(RootResource(resource, id));
            string location = api.RegisteredDirectory(id);
            if (location != null && !location.Equals(resource.Id, StringComparison.OrdinalIgnoreCase)) Foreign(resource);
            return absent && (location == null || !location.Equals(resource.Id, StringComparison.OrdinalIgnoreCase));
        }
        public override void Destroy(RunResource resource)
        {
            var id = Identity(resource); var directory = RootResource(resource, id);
            if (files.Absent(directory)) { if (files.Retained.Contains(directory)) Foreign(resource); return; }
            var location = api.RegisteredDirectory(id);
            if (location != null && !location.Equals(resource.Id, StringComparison.OrdinalIgnoreCase)) { Foreign(resource); throw WitnessCodec.Reject("INSTALL_REGISTRATION_CHANGED"); }
            long remaining = deadline - Environment.TickCount64; if (remaining <= 0) throw WitnessCodec.Reject("INSTALL_CLEANUP");
            api.Uninstall(resource.Id, id, (int)remaining);
            var uninstaller = directory with { Id = id.Uninstaller, Incarnation = directory.Incarnation.Replace(id.RootFileId, id.FileId) };
            files.Destroy(uninstaller); files.Destroy(directory);
        }
    }
    public sealed class WindowsInstallReaperApi : IInstallReaperApi
    {
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] private struct Startup
        { public uint Size; public IntPtr Reserved, Desktop, Title; public uint X, Y, XSize, YSize, XCount, YCount, Fill, Flags; public ushort Show, ReservedSize; public IntPtr Reserved2, Input, Output, Error; }
        [StructLayout(LayoutKind.Sequential)] private struct ProcessInfo { public IntPtr Process, Thread; public uint Pid, Tid; }
        [DllImport("wtsapi32.dll", SetLastError = true)] private static extern bool WTSQueryUserToken(uint session, out SafeAccessTokenHandle token);
        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool CreateProcessAsUser(SafeAccessTokenHandle token, string app, StringBuilder command, IntPtr processSecurity, IntPtr threadSecurity, bool inherit, uint flags, IntPtr environment, string cwd, ref Startup startup, out ProcessInfo process);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetExitCodeProcess(IntPtr process, out uint exit);
        [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern uint ResumeThread(IntPtr thread);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern bool TerminateProcess(IntPtr handle, uint code);
        public string RegisteredDirectory(InstallIdentity identity)
        {
            if (!OperatingSystem.IsWindows()) throw WitnessCodec.Reject("WINDOWS_REQUIRED");
            using var key = Registry.Users.OpenSubKey(identity.UserSid + "\\" + identity.RegistryKey, false);
            if (key == null) return null;
            var value = key.GetValue("InstallLocation", null, RegistryValueOptions.DoNotExpandEnvironmentNames);
            if (value is not string location || key.GetValueKind("InstallLocation") != RegistryValueKind.String) throw WitnessCodec.Reject("INSTALL_REGISTRATION");
            WitnessCodec.Absolute(location); return location;
        }
        public void Uninstall(string directory, InstallIdentity identity, int milliseconds)
        {
            if (!OperatingSystem.IsWindows()) throw WitnessCodec.Reject("WINDOWS_REQUIRED");
            using var file = new WindowsFileReaperApi().Open(identity.Uninstaller, false);
            if (file == null || file.Identity != identity.FileId || file.Reparse || file.Links != 1) throw WitnessCodec.Reject("INSTALL_UNINSTALLER_IDENTITY");
            using var held = new HeldFile(identity.Uninstaller, WitnessCodec.CaptureLimit, identity.Sha256);
            if (!WTSQueryUserToken(identity.Session, out var token)) throw WitnessCodec.Reject("INSTALL_SESSION");
            using (token)
            using (var user = new WindowsIdentity(token.DangerousGetHandle()))
            {
                if (user.User?.Value != identity.UserSid) throw WitnessCodec.Reject("INSTALL_SESSION");
                new Murage.Signing.WindowsSigningProcessApi().AssertStandardTokenIdentity(token.DangerousGetHandle());
                string systemRoot = Environment.GetEnvironmentVariable("SystemRoot", EnvironmentVariableTarget.Machine);
                WitnessCodec.Absolute(systemRoot);
                string block = "SystemRoot=" + systemRoot + "\0TEMP=" + directory + "\0TMP=" + directory + "\0WINDIR=" + systemRoot + "\0\0";
                var environment = Marshal.StringToHGlobalUni(block); var startup = new Startup { Size = (uint)Marshal.SizeOf<Startup>() };
                ProcessInfo process = default;
                try
                {
                    if (!CreateProcessAsUser(token, identity.Uninstaller, new StringBuilder("\"" + identity.Uninstaller + "\" /S _?=" + directory), IntPtr.Zero, IntPtr.Zero, false, 0x08000404, environment, directory, ref startup, out process)) throw WitnessCodec.Reject("INSTALL_UNINSTALL");
                    // The image is mapped before releasing the validation handles; teardown may now remove its parent directory.
                    held.Dispose(); file.Dispose();
                    if (ResumeThread(process.Thread) == UInt32.MaxValue) { TerminateProcess(process.Process, 1); throw WitnessCodec.Reject("INSTALL_UNINSTALL"); }
                    if (WaitForSingleObject(process.Process, (uint)milliseconds) != 0)
                    { if (!TerminateProcess(process.Process, 1)) throw WitnessCodec.Reject("INSTALL_UNINSTALL"); throw WitnessCodec.Reject("INSTALL_TIMEOUT"); }
                    if (!GetExitCodeProcess(process.Process, out var code) || code != 0) throw WitnessCodec.Reject("INSTALL_UNINSTALL");
                }
                finally
                { if (process.Thread != IntPtr.Zero) CloseHandle(process.Thread); if (process.Process != IntPtr.Zero) CloseHandle(process.Process); Marshal.FreeHGlobal(environment); }
            }
        }
    }
}
