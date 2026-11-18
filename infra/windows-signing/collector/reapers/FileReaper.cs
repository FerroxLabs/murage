// File recovery producer owner: Builder A win-sac-sign-sa; protected scratch-root admission and native execution owner: MAIN.
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace Murage.Witness
{
    public interface IRecoveryFile : IDisposable
    {
        string Identity { get; }
        bool Reparse { get; }
        uint Links { get; }
        void Delete();
    }
    public interface IFileReaperApi { IRecoveryFile Open(string path, bool delete); }
    public sealed class FileReaper : BoundReaper
    {
        private readonly string root;
        private readonly IFileReaperApi api;
        public FileReaper(string runNonce, string root) : this(runNonce, root, new WindowsFileReaperApi()) { }
        public FileReaper(string runNonce, string root, IFileReaperApi api) : base(runNonce)
        { WitnessCodec.Absolute(root); this.root = root; this.api = api ?? throw new ArgumentNullException(nameof(api)); }
        private string Identity(RunResource resource)
        {
            using var doc = Binding(resource, "file", "fileId"); WitnessCodec.Absolute(resource.Id);
            if (!resource.Id.Equals(root, StringComparison.OrdinalIgnoreCase) && !resource.Id.StartsWith(root + "\\", StringComparison.OrdinalIgnoreCase)) throw WitnessCodec.Reject("FILE_ROOT");
            var identity = WitnessCodec.Text(doc.RootElement, "fileId");
            if (identity.Length != 49 || identity[16] != ':' || !WitnessCodec.Hex(identity.Substring(0, 16), 16) || !WitnessCodec.Hex(identity.Substring(17), 32)) throw WitnessCodec.Reject("FILE_IDENTITY");
            return identity;
        }
        private static void Regular(IRecoveryFile file)
        { if (file.Reparse || file.Links != 1) throw WitnessCodec.Reject("REGULAR_FILE_REQUIRED"); }
        public override bool Absent(RunResource resource)
        {
            string identity = Identity(resource); using var file = api.Open(resource.Id, false);
            if (file == null) return true;
            if (file.Identity != identity) return Foreign(resource);
            Regular(file); return false;
        }
        public override void Destroy(RunResource resource)
        {
            string identity = Identity(resource); using var file = api.Open(resource.Id, true);
            if (file == null) return;
            if (file.Identity != identity) { Foreign(resource); return; }
            Regular(file); file.Delete();
        }
    }
    public sealed class WindowsFileReaperApi : IFileReaperApi
    {
        [StructLayout(LayoutKind.Sequential)] private struct FileId { public ulong Volume, Low, High; }
        [StructLayout(LayoutKind.Sequential)] private struct Information
        {
            public uint Attributes; public System.Runtime.InteropServices.ComTypes.FILETIME Creation, Access, Write; public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
        }
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern SafeFileHandle CreateFile(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetFileInformationByHandle(SafeFileHandle file, out Information info);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetFileInformationByHandleEx(SafeFileHandle file, int type, out FileId id, uint size);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern bool SetFileInformationByHandle(SafeFileHandle file, int type, ref uint flags, uint size);
        private sealed class OpenFile : IRecoveryFile
        {
            private readonly HeldFile parents;
            private readonly SafeFileHandle handle;
            public string Identity { get; }
            public bool Reparse { get; }
            public uint Links { get; }
            public OpenFile(HeldFile parents, SafeFileHandle handle)
            {
                this.parents = parents; this.handle = handle;
                if (!GetFileInformationByHandle(handle, out var info) || !GetFileInformationByHandleEx(handle, 18, out var id, 24)) throw WitnessCodec.Reject("FILE_QUERY");
                Identity = id.Volume.ToString("x16", CultureInfo.InvariantCulture) + ":" + Convert.ToHexString(BitConverter.GetBytes(id.Low)).ToLowerInvariant() + Convert.ToHexString(BitConverter.GetBytes(id.High)).ToLowerInvariant();
                Reparse = (info.Attributes & 0x400) != 0; Links = info.Links;
            }
            public void Delete()
            {
                uint flags = 1 | 2 | 16;
                if (!SetFileInformationByHandle(handle, 21, ref flags, 4)) throw WitnessCodec.Reject("FILE_DELETE");
            }
            public void Dispose() { handle.Dispose(); parents.Dispose(); }
        }
        public IRecoveryFile Open(string path, bool delete)
        {
            if (!OperatingSystem.IsWindows()) throw WitnessCodec.Reject("WINDOWS_REQUIRED");
            WitnessCodec.Absolute(path);
            HeldFile parents;
            try { parents = HeldFile.HoldDirectory(Path.GetDirectoryName(path)); }
            catch
            {
                // A missing ancestor proves absence only after the nearest existing ancestor is held and checked.
                var parent = Path.GetDirectoryName(path);
                while (parent != null && !Directory.Exists(parent)) parent = Path.GetDirectoryName(parent);
                if (parent == null) throw;
                using var held = HeldFile.HoldDirectory(parent);
                var missing = CreateFile(path, 0x80, 7, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);
                int error = Marshal.GetLastWin32Error(); bool invalid = missing.IsInvalid; missing.Dispose();
                if (invalid && (error == 2 || error == 3)) return null;
                throw;
            }
            var handle = CreateFile(path, 0x80u | (delete ? 0x10000u : 0u), 7, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);
            if (handle.IsInvalid)
            {
                int error = Marshal.GetLastWin32Error(); handle.Dispose(); parents.Dispose();
                if (error == 2 || error == 3) return null;
                throw WitnessCodec.Reject("FILE_QUERY");
            }
            try { return new OpenFile(parents, handle); }
            catch { handle.Dispose(); parents.Dispose(); throw; }
        }
    }
}
