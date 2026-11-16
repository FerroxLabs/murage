// Held-file validation producer: win-sac-sign; protected directory/ACL deployment consumer: MAIN.
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using Microsoft.Win32.SafeHandles;

namespace Murage.Witness
{
    public sealed class HeldFile : IDisposable
    {
        [StructLayout(LayoutKind.Sequential)] private struct Information
        {
            public uint Attributes; public System.Runtime.InteropServices.ComTypes.FILETIME Creation, Access, Write;
            public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
        }
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern SafeFileHandle CreateFile(string path, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetFileInformationByHandle(SafeFileHandle handle, out Information information);
        private readonly List<SafeFileHandle> handles = new List<SafeFileHandle>();
        public byte[] Bytes { get; private set; }
        public static string Hash(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
        private HeldFile() { }
        public static HeldFile HoldDirectory(string directory)
        {
            WitnessCodec.Absolute(directory);
            if (!OperatingSystem.IsWindows()) throw WitnessCodec.Reject("WINDOWS_REQUIRED");
            var held = new HeldFile();
            try
            {
                var ancestors = new Stack<string>();
                for (var current = directory; current != null; current = Path.GetDirectoryName(current)) ancestors.Push(current);
                foreach (var current in ancestors) held.Open(current, true);
                return held;
            }
            catch { held.Dispose(); throw; }
        }
        public HeldFile(string file, int limit, string expected = null)
        {
            WitnessCodec.Absolute(file);
            if (!OperatingSystem.IsWindows()) throw WitnessCodec.Reject("WINDOWS_REQUIRED");
            try
            {
                var ancestors = new Stack<string>();
                for (var parent = Path.GetDirectoryName(file); parent != null; parent = Path.GetDirectoryName(parent)) ancestors.Push(parent);
                foreach (var parent in ancestors) Open(parent, true);
                var leaf = Open(file, false);
                var length = RandomAccess.GetLength(leaf);
                if (length <= 0 || length > limit) throw WitnessCodec.Reject("INPUT_SIZE");
                Bytes = new byte[(int)length];
                for (int offset = 0; offset < Bytes.Length;)
                {
                    int read = RandomAccess.Read(leaf, Bytes.AsSpan(offset), offset);
                    if (read == 0) throw WitnessCodec.Reject("FILE_CHANGED");
                    offset += read;
                }
                if (expected != null && (!WitnessCodec.Hex(expected, 64) || Hash(Bytes) != expected)) throw WitnessCodec.Reject("PIN_MISMATCH");
            }
            catch { Dispose(); throw; }
        }
        private SafeFileHandle Open(string file, bool directory)
        {
            // Hold ancestors without delete sharing; reject the reparse object itself.
            var handle = CreateFile(file, 0x80000000, 1, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);
            handles.Add(handle);
            if (handle.IsInvalid || !GetFileInformationByHandle(handle, out var info)
                || (info.Attributes & 0x400) != 0 || ((info.Attributes & 0x10) != 0) != directory
                || !directory && (info.Links != 1 || (info.Attributes & 0x40) != 0)) throw WitnessCodec.Reject("REGULAR_FILE_REQUIRED");
            return handle;
        }
        public void Dispose() { for (int i = handles.Count - 1; i >= 0; --i) handles[i].Dispose(); handles.Clear(); }
    }
}
