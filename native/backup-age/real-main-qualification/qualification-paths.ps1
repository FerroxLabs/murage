# Link-target lease for the Windows qualification registrars (PS1-REPARSE-DESIGN-r2 sections 2.1-2.5).
# Every check runs on an open no-follow handle, never on a name. The kernel32 layer is never stubbed in native witnesses.
if (-not ('MurageQualification.Lease' -as [type])) {
Add-Type -Language CSharp -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;

namespace MurageQualification {
  public sealed class LeaseRefused : Exception {
    public LeaseRefused(string message) : base(message) {}
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct ByHandleInfo {
    public uint Attributes; public uint C1; public uint C2; public uint A1; public uint A2; public uint W1; public uint W2;
    public uint VolumeSerial; public uint SizeHigh; public uint SizeLow; public uint Links; public uint IndexHigh; public uint IndexLow;
  }

  public static class Native {
    public const uint GENERIC_READ = 0x80000000, GENERIC_WRITE = 0x40000000, DELETE = 0x00010000, SYNCHRONIZE = 0x00100000;
    public const uint FILE_LIST_DIRECTORY = 0x1, FILE_READ_ATTRIBUTES = 0x80;
    public const uint SHARE_READ = 1, SHARE_WRITE = 2, SHARE_DELETE = 4;
    public const uint CREATE_NEW = 1, OPEN_EXISTING = 3;
    public const uint FLAG_BACKUP_SEMANTICS = 0x02000000, FLAG_OPEN_REPARSE_POINT = 0x00200000, FLAG_SEQUENTIAL_SCAN = 0x08000000, FLAG_OVERLAPPED = 0x40000000;
    public const uint ATTR_DIRECTORY = 0x10, ATTR_REPARSE = 0x400;
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool GetFileInformationByHandle(SafeFileHandle h, out ByHandleInfo info);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool GetFileInformationByHandleEx(SafeFileHandle h, int cls, IntPtr buffer, uint size);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool SetFileInformationByHandle(SafeFileHandle h, int cls, ref byte info, uint size);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern uint GetFinalPathNameByHandleW(SafeFileHandle h, StringBuilder path, uint length, uint flags);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool ReadFile(SafeFileHandle h, byte[] buffer, int count, out int read, IntPtr overlapped);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool WriteFile(SafeFileHandle h, byte[] buffer, int count, out int written, IntPtr overlapped);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool SetFilePointerEx(SafeFileHandle h, long distance, IntPtr newPosition, uint method);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool SetEndOfFile(SafeFileHandle h);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool FlushFileBuffers(SafeFileHandle h);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool ReadDirectoryChangesW(SafeFileHandle h, IntPtr buffer, int length, bool subtree, uint filter, IntPtr returned, IntPtr overlapped, IntPtr routine);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool GetOverlappedResult(SafeFileHandle h, IntPtr overlapped, out int transferred, bool wait);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool CancelIoEx(SafeFileHandle h, IntPtr overlapped);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr CreateEventW(IntPtr security, bool manual, bool initial, string name);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr CreateJobObjectW(IntPtr security, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool SetInformationJobObject(IntPtr job, int cls, IntPtr info, uint length);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool QueryInformationJobObject(IntPtr job, int cls, IntPtr info, uint length, IntPtr returned);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool CloseHandle(IntPtr h);
  }

  public sealed class Held {
    public string Relative; public string Expected; public SafeFileHandle Handle; public bool Directory;
    public string Kind; public uint Volume; public ulong FileId; public bool Used;
  }

  public sealed class Lease : IDisposable {
    public readonly string Admitted;
    readonly string profile;
    public readonly List<Held> Items = new List<Held>();
    readonly Dictionary<string, Held> byPath = new Dictionary<string, Held>(StringComparer.OrdinalIgnoreCase);
    public readonly List<string> ScanDirectories = new List<string>();
    public readonly HashSet<string> PinnedExecutables = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
    public readonly List<string> WorkPrefixes = new List<string>();
    public readonly HashSet<string> WorkNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
    public readonly List<string> Events = new List<string>();
    readonly object gate = new object();
    SafeFileHandle watchHandle; Thread watchThread; IntPtr watchBuffer, watchOverlapped, watchEvent; volatile bool watchStopping; bool watchFailed, watchBusy;
    // Witness-only (WRP_WITNESS=1): hold each completion before Record so L3 meets a completed, unprocessed notification (W-RP7c drain).
    public static int WitnessWatchDelayMs;
    int watchDelayMs;

    public Lease(string profileRoot, string admitted) {
      profile = Canonical(profileRoot); Admitted = Canonical(admitted);
      if (!Admitted.StartsWith(profile + "\\", StringComparison.Ordinal)) throw new LeaseRefused("Admitted directory is outside the verified profile");
      string[] parts = Admitted.Split('\\');
      string cursor = parts[0];
      for (int i = 1; i < parts.Length; i++) { cursor = cursor + "\\" + parts[i]; HoldDirectory(cursor, i == parts.Length - 1 ? "admitted" : "ancestor"); }
    }

    public static string Canonical(string path) {
      if (path == null || path.Contains("/") || path.StartsWith("\\\\")) throw new LeaseRefused("Unsafe admitted path");
      string full = Path.GetFullPath(path);
      if (!System.Text.RegularExpressions.Regex.IsMatch(full, @"^[A-Za-z]:\\[^\\]") || !string.Equals(full, path, StringComparison.Ordinal) || full.EndsWith("\\")) throw new LeaseRefused("Unsafe admitted path");
      foreach (string part in full.Substring(3).Split('\\')) if (part.Length == 0 || part == "." || part == ".." || part.Contains(":")) throw new LeaseRefused("Unsafe admitted path");
      return full;
    }

    public string Name(string full) {
      if (string.Equals(full, Admitted, StringComparison.OrdinalIgnoreCase)) return "<admitted>";
      if (full.StartsWith(Admitted + "\\", StringComparison.OrdinalIgnoreCase)) return "<admitted>\\" + full.Substring(Admitted.Length + 1);
      if (string.Equals(full, profile, StringComparison.OrdinalIgnoreCase)) return "<profile>";
      if (full.StartsWith(profile + "\\", StringComparison.OrdinalIgnoreCase)) return "<profile>\\" + full.Substring(profile.Length + 1);
      return "<above-profile>";
    }

    public string Full(string relative) {
      if (relative.Length == 0) return Admitted;
      foreach (string part in relative.Split('\\')) if (part.Length == 0 || part == "." || part == ".." || part.Contains(":") || part.Contains("/")) throw new LeaseRefused("Unsafe admitted path");
      return Admitted + "\\" + relative;
    }

    static int Error() { return Marshal.GetLastWin32Error(); }

    SafeFileHandle Open(string full, uint access, uint share, uint disposition, uint flags) {
      SafeFileHandle h = Native.CreateFileW("\\\\?\\" + full, access, share, IntPtr.Zero, disposition, flags, IntPtr.Zero);
      if (h.IsInvalid) {
        int e = Error();
        if (e == 2 || e == 3) throw new LeaseRefused("Admitted path not found: " + Name(full));
        if (e == 80 || e == 183) throw new LeaseRefused("Output name already exists: " + Name(full));
        throw new LeaseRefused("Admitted path open failed (" + e + "): " + Name(full));
      }
      return h;
    }

    public static string FinalPath(SafeFileHandle h) {
      StringBuilder sb = new StringBuilder(1024);
      uint n = Native.GetFinalPathNameByHandleW(h, sb, (uint)sb.Capacity, 0);
      if (n == 0 || n >= sb.Capacity) return null;
      string p = sb.ToString();
      if (p.StartsWith("\\\\?\\UNC\\", StringComparison.OrdinalIgnoreCase)) return null;
      if (p.StartsWith("\\\\?\\")) p = p.Substring(4);
      return p;
    }

    static ByHandleInfo Info(SafeFileHandle h, string name) {
      ByHandleInfo info;
      if (!Native.GetFileInformationByHandle(h, out info)) throw new LeaseRefused("Admitted path information failed: " + name);
      return info;
    }

    static bool CaseSensitive(SafeFileHandle h) {
      IntPtr buffer = Marshal.AllocHGlobal(4);
      try {
        Marshal.WriteInt32(buffer, 0);
        if (!Native.GetFileInformationByHandleEx(h, 23, buffer, 4)) {
          int e = Error();
          if (e == 87 || e == 1 || e == 50) return false;
          throw new LeaseRefused("Case-sensitivity query failed (" + e + ")");
        }
        return (Marshal.ReadInt32(buffer) & 1) != 0;
      } finally { Marshal.FreeHGlobal(buffer); }
    }

    void Verify(Held item) {
      string name = Name(item.Expected);
      ByHandleInfo info = Info(item.Handle, name);
      if ((info.Attributes & Native.ATTR_REPARSE) != 0) throw new LeaseRefused("Reparse point on admitted path: " + name);
      bool directory = (info.Attributes & Native.ATTR_DIRECTORY) != 0;
      if (directory != item.Directory) throw new LeaseRefused((item.Directory ? "Not a directory on admitted path: " : "Directory refused on admitted path: ") + name);
      string final = FinalPath(item.Handle);
      if (final == null || !string.Equals(final, item.Expected, StringComparison.OrdinalIgnoreCase)) throw new LeaseRefused("Final path mismatch on admitted path: " + name);
      if (directory && CaseSensitive(item.Handle)) throw new LeaseRefused("Case-sensitive directory refused: " + name);
      if (!directory && info.Links != 1) throw new LeaseRefused("Hardlinked file refused: " + name);
      ulong id = ((ulong)info.IndexHigh << 32) | info.IndexLow;
      if (item.FileId == 0) { item.Volume = info.VolumeSerial; item.FileId = id; }
      else if (item.FileId != id || item.Volume != info.VolumeSerial) throw new LeaseRefused("Held object identity changed: " + name);
    }

    Held Add(string full, SafeFileHandle h, bool directory, string kind) {
      Held item = new Held(); item.Expected = full; item.Relative = Name(full); item.Handle = h; item.Directory = directory; item.Kind = kind;
      try { Verify(item); } catch { h.Dispose(); throw; }
      Items.Add(item); byPath[full] = item;
      return item;
    }

    public Held Find(string relative) {
      Held item;
      if (!byPath.TryGetValue(Full(relative), out item)) throw new LeaseRefused("Not held: " + Name(Full(relative)));
      return item;
    }

    // O1-O4: FILE_LIST_DIRECTORY is data-class access, so the missing FILE_SHARE_DELETE blocks rename and delete.
    public Held HoldDirectory(string full, string kind) {
      Held existing;
      if (byPath.TryGetValue(full, out existing)) return existing;
      SafeFileHandle h = Open(full, Native.FILE_LIST_DIRECTORY | Native.FILE_READ_ATTRIBUTES | Native.SYNCHRONIZE, Native.SHARE_READ | Native.SHARE_WRITE, Native.OPEN_EXISTING, Native.FLAG_BACKUP_SEMANTICS | Native.FLAG_OPEN_REPARSE_POINT);
      return Add(full, h, true, kind);
    }

    public void HoldParents(string relative) {
      string[] parts = relative.Split('\\');
      string cursor = Admitted;
      for (int i = 0; i < parts.Length - 1; i++) { cursor = cursor + "\\" + parts[i]; HoldDirectory(cursor, "work"); }
    }

    // F1-F3: GENERIC_READ, share read only, no-follow.
    public Held OpenPinned(string relative, string kind) {
      HoldParents(relative);
      string full = Full(relative);
      Held existing;
      if (byPath.TryGetValue(full, out existing)) return existing;
      SafeFileHandle h = Open(full, Native.GENERIC_READ, Native.SHARE_READ, Native.OPEN_EXISTING, Native.FLAG_OPEN_REPARSE_POINT | Native.FLAG_SEQUENTIAL_SCAN);
      Held item = Add(full, h, false, kind);
      if (relative.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)) PinnedExecutables.Add(full);
      return item;
    }

    static void Rewind(SafeFileHandle h) {
      if (!Native.SetFilePointerEx(h, 0, IntPtr.Zero, 0)) throw new LeaseRefused("Seek failed (" + Error() + ")");
    }

    // F4: hash through the same handle, rewound; the bytes are returned only when the caller parses them.
    public byte[] HashPinned(string relative, string expected, bool returnBytes) {
      Held item = Find(relative);
      if (expected == null || !System.Text.RegularExpressions.Regex.IsMatch(expected, "^[a-f0-9]{64}$")) throw new LeaseRefused("Pinned hash malformed: " + item.Relative);
      Rewind(item.Handle);
      MemoryStream copy = returnBytes ? new MemoryStream() : null;
      byte[] buffer = new byte[1 << 20];
      using (SHA256 sha = SHA256.Create()) {
        int read;
        while (true) {
          if (!Native.ReadFile(item.Handle, buffer, buffer.Length, out read, IntPtr.Zero)) throw new LeaseRefused("Pinned read failed (" + Error() + "): " + item.Relative);
          if (read == 0) break;
          sha.TransformBlock(buffer, 0, read, null, 0);
          if (copy != null) copy.Write(buffer, 0, read);
        }
        sha.TransformFinalBlock(buffer, 0, 0);
        string actual = BitConverter.ToString(sha.Hash).Replace("-", "").ToLowerInvariant();
        if (!string.Equals(actual, expected, StringComparison.Ordinal)) throw new LeaseRefused("Pinned file hash mismatch: " + item.Relative);
      }
      Rewind(item.Handle);
      return copy == null ? null : copy.ToArray();
    }

    public byte[] ReadHeld(string relative) {
      Held item = Find(relative);
      Rewind(item.Handle);
      MemoryStream copy = new MemoryStream(); byte[] buffer = new byte[65536]; int read;
      while (true) {
        if (!Native.ReadFile(item.Handle, buffer, buffer.Length, out read, IntPtr.Zero)) throw new LeaseRefused("Held read failed (" + Error() + "): " + item.Relative);
        if (read == 0) break;
        copy.Write(buffer, 0, read);
      }
      Rewind(item.Handle);
      return copy.ToArray();
    }

    // Enumerate through the held directory handle (FileIdBothDirectoryRestartInfo, then FileIdBothDirectoryInfo).
    public List<KeyValuePair<string, uint>> List(Held directory) {
      List<KeyValuePair<string, uint>> result = new List<KeyValuePair<string, uint>>();
      IntPtr buffer = Marshal.AllocHGlobal(65536);
      try {
        int cls = 11;
        while (true) {
          if (!Native.GetFileInformationByHandleEx(directory.Handle, cls, buffer, 65536)) {
            int e = Error();
            if (e == 18) break;
            throw new LeaseRefused("Directory enumeration failed (" + e + "): " + directory.Relative);
          }
          cls = 10;
          int offset = 0;
          while (true) {
            IntPtr entry = IntPtr.Add(buffer, offset);
            int next = Marshal.ReadInt32(entry, 0);
            uint attributes = (uint)Marshal.ReadInt32(entry, 56);
            int length = Marshal.ReadInt32(entry, 60);
            string name = Marshal.PtrToStringUni(IntPtr.Add(entry, 104), length / 2);
            if (name != "." && name != "..") result.Add(new KeyValuePair<string, uint>(name, attributes));
            if (next == 0) break;
            offset += next;
          }
        }
      } finally { Marshal.FreeHGlobal(buffer); }
      return result;
    }

    // F5: the whole candidate tree is held; pinned members keep their pinned handle.
    public void HoldTree(string relative) {
      Held directory = HoldDirectory(Full(relative), "held");
      foreach (KeyValuePair<string, uint> child in List(directory)) {
        string childRelative = relative + "\\" + child.Key;
        if ((child.Value & Native.ATTR_REPARSE) != 0) throw new LeaseRefused("Reparse point on admitted path: " + Name(Full(childRelative)));
        if ((child.Value & Native.ATTR_DIRECTORY) != 0) HoldTree(childRelative);
        else if (!byPath.ContainsKey(Full(childRelative))) OpenPinned(childRelative, "held");
      }
    }

    // X2: planted-code scan of the launch and load directories.
    public void ScanPlanted() {
      foreach (string relative in ScanDirectories) {
        Held directory = relative.Length == 0 ? byPath[Admitted] : Find(relative);
        foreach (KeyValuePair<string, uint> child in List(directory)) {
          string lower = child.Key.ToLowerInvariant();
          string full = directory.Expected + "\\" + child.Key;
          bool planted = lower.EndsWith(".dll") || lower.EndsWith(".local") || lower.EndsWith(".manifest") || lower.EndsWith(".config") || (lower.EndsWith(".exe") && !PinnedExecutables.Contains(full));
          if (planted) throw new LeaseRefused("Planted code refused: " + Name(full));
        }
      }
    }

    // X1 admission check: a no-follow open of the name must report that nothing exists there.
    public void CheckAbsent(string relative) {
      string full = Full(relative);
      SafeFileHandle h = Native.CreateFileW("\\\\?\\" + full, Native.FILE_READ_ATTRIBUTES, Native.SHARE_READ | Native.SHARE_WRITE | Native.SHARE_DELETE, IntPtr.Zero, Native.OPEN_EXISTING, Native.FLAG_BACKUP_SEMANTICS | Native.FLAG_OPEN_REPARSE_POINT, IntPtr.Zero);
      if (!h.IsInvalid) { h.Dispose(); throw new LeaseRefused("Output name already exists: " + Name(full)); }
      int e = Error();
      if (e != 2 && e != 3) throw new LeaseRefused("Output name check failed (" + e + "): " + Name(full));
    }

    // X1 correction sources: existing regular files, nlink 1, held. Task-written logs are read-only with share read|write (B3).
    public Held HoldExisting(string relative, bool taskLog) {
      string full = Full(relative);
      SafeFileHandle h = taskLog
        ? Open(full, Native.GENERIC_READ, Native.SHARE_READ | Native.SHARE_WRITE, Native.OPEN_EXISTING, Native.FLAG_OPEN_REPARSE_POINT)
        : Open(full, Native.GENERIC_READ | Native.GENERIC_WRITE, Native.SHARE_READ, Native.OPEN_EXISTING, Native.FLAG_OPEN_REPARSE_POINT);
      Held item = Add(full, h, false, taskLog ? "tasklog" : "correction");
      item.Used = true;
      return item;
    }

    // X1 RESERVE: CREATE_NEW no-follow. Registrar outputs carry DELETE so an unused or refused reservation is removed by handle.
    // Task-written logs are created read-only (share read|write) so the task's own write open shares the same file object (B3).
    public Held Reserve(string relative, bool taskLog) {
      string full = Full(relative);
      SafeFileHandle h = taskLog
        ? Open(full, Native.GENERIC_READ, Native.SHARE_READ | Native.SHARE_WRITE, Native.CREATE_NEW, Native.FLAG_OPEN_REPARSE_POINT)
        : Open(full, Native.GENERIC_READ | Native.GENERIC_WRITE | Native.DELETE, Native.SHARE_READ | Native.SHARE_WRITE, Native.CREATE_NEW, Native.FLAG_OPEN_REPARSE_POINT);
      Held item = new Held(); item.Expected = full; item.Relative = Name(full); item.Handle = h; item.Directory = false; item.Kind = taskLog ? "tasklog" : "output";
      try { Verify(item); } catch (Exception refused) {
        // The file this call created is removed by handle; if that fails the refusal says so (REFUSED-RESERVE-DIRTY).
        bool removed = false;
        try {
          ByHandleInfo created; bool known = Native.GetFileInformationByHandle(h, out created);
          if (!taskLog) { byte delete = 1; removed = Native.SetFileInformationByHandle(h, 4, ref delete, 1); }
          h.Dispose();
          if (taskLog && known) { DeleteIfSame(full, created.VolumeSerial, ((ulong)created.IndexHigh << 32) | created.IndexLow); removed = true; }
        } catch (LeaseRefused) { removed = false; }
        if (!removed) throw new LeaseRefused(refused.Message + "; rollback left: " + Name(full));
        throw;
      }
      Items.Add(item); byPath[full] = item;
      item.Used = taskLog;
      return item;
    }

    public void Write(string relative, byte[] bytes) {
      Held item = Find(relative);
      if (item.Kind != "output" && item.Kind != "correction") throw new LeaseRefused("Not a registrar output: " + item.Relative);
      Rewind(item.Handle);
      if (!Native.SetEndOfFile(item.Handle)) throw new LeaseRefused("Output truncate failed (" + Error() + "): " + item.Relative);
      int written;
      if (bytes.Length > 0 && (!Native.WriteFile(item.Handle, bytes, bytes.Length, out written, IntPtr.Zero) || written != bytes.Length)) throw new LeaseRefused("Output write failed (" + Error() + "): " + item.Relative);
      Native.FlushFileBuffers(item.Handle);
      item.Used = true;
    }

    // REFUSED-RESERVE rollback for a task log (held without DELETE, B3): close, reopen no-follow with DELETE,
    // and delete only if it is still the same file object (volume serial + file id); otherwise refuse loudly.
    public void DeleteTaskLog(Held item) {
      uint volume = item.Volume; ulong id = item.FileId;
      item.Handle.Dispose(); Items.Remove(item); byPath.Remove(item.Expected);
      DeleteIfSame(item.Expected, volume, id);
    }

    void DeleteIfSame(string full, uint volume, ulong id) {
      SafeFileHandle h = Native.CreateFileW("\\\\?\\" + full, Native.DELETE | Native.FILE_READ_ATTRIBUTES, Native.SHARE_READ | Native.SHARE_WRITE | Native.SHARE_DELETE, IntPtr.Zero, Native.OPEN_EXISTING, Native.FLAG_OPEN_REPARSE_POINT, IntPtr.Zero);
      if (h.IsInvalid) throw new LeaseRefused("Reserved task log rollback failed (" + Error() + "): " + Name(full));
      using (h) {
        ByHandleInfo info = Info(h, Name(full));
        if (info.VolumeSerial != volume || (((ulong)info.IndexHigh << 32) | info.IndexLow) != id) throw new LeaseRefused("Reserved task log rollback refused, object changed: " + Name(full));
        byte delete = 1;
        if (!Native.SetFileInformationByHandle(h, 4, ref delete, 1)) throw new LeaseRefused("Reserved task log rollback failed (" + Error() + "): " + Name(full));
      }
    }

    // X1w: delete through the reservation's own handle (FileDispositionInfo), never by name.
    public void DeleteReserved(Held item) {
      byte delete = 1;
      if (!Native.SetFileInformationByHandle(item.Handle, 4, ref delete, 1)) throw new LeaseRefused("Reserved output delete failed (" + Error() + "): " + item.Relative);
      item.Handle.Dispose(); Items.Remove(item); byPath.Remove(item.Expected);
    }

    // X3: a separate overlapped handle on the admitted directory (B1), same volume and file id as the held handle.
    public void StartWatch() {
      Held admitted = byPath[Admitted];
      watchHandle = Open(Admitted, Native.FILE_LIST_DIRECTORY | Native.FILE_READ_ATTRIBUTES | Native.SYNCHRONIZE, Native.SHARE_READ | Native.SHARE_WRITE, Native.OPEN_EXISTING, Native.FLAG_BACKUP_SEMANTICS | Native.FLAG_OPEN_REPARSE_POINT | Native.FLAG_OVERLAPPED);
      ByHandleInfo info = Info(watchHandle, "<admitted>");
      if (info.VolumeSerial != admitted.Volume || (((ulong)info.IndexHigh << 32) | info.IndexLow) != admitted.FileId) { watchHandle.Dispose(); throw new LeaseRefused("Held object identity changed: <admitted>"); }
      watchBuffer = Marshal.AllocHGlobal(65536);
      watchOverlapped = Marshal.AllocHGlobal(64);
      watchEvent = Native.CreateEventW(IntPtr.Zero, true, false, null);
      watchDelayMs = Environment.GetEnvironmentVariable("WRP_WITNESS") == "1" ? WitnessWatchDelayMs : 0;
      Arm();
      watchThread = new Thread(WatchLoop); watchThread.IsBackground = true; watchThread.Start();
    }

    void Arm() {
      for (int i = 0; i < 64; i += 8) Marshal.WriteInt64(watchOverlapped, i, 0);
      Marshal.WriteIntPtr(watchOverlapped, IntPtr.Size == 8 ? 24 : 16, watchEvent);
      if (!Native.ReadDirectoryChangesW(watchHandle, watchBuffer, 65536, true, 0x3, IntPtr.Zero, watchOverlapped, IntPtr.Zero)) throw new LeaseRefused("Change watch failed (" + Error() + ")");
    }

    // A completion is busy from GetOverlappedResult until it is recorded and the next read is armed; L3 drains (Drain) before it reads Events.
    void WatchLoop() {
      try {
        while (!watchStopping) {
          int transferred;
          bool completed = Native.GetOverlappedResult(watchHandle, watchOverlapped, out transferred, true);
          int error = Marshal.GetLastWin32Error();
          lock (gate) { watchBusy = true; }
          try {
            if (!completed) {
              if (watchStopping) return;
              lock (gate) { watchFailed = true; Events.Add("Change watch failed (" + error + ")"); }
              return;
            }
            if (watchDelayMs > 0) Thread.Sleep(watchDelayMs);
            if (transferred == 0) { lock (gate) { watchFailed = true; Events.Add("Change watch overflow"); } }
            else Record(transferred);
            if (watchStopping) return;
            Arm();
          } finally { lock (gate) { watchBusy = false; Monitor.PulseAll(gate); } }
        }
      } catch (Exception e) { lock (gate) { watchFailed = true; Events.Add("Change watch failed: " + e.GetType().Name); Monitor.PulseAll(gate); } }
    }

    // OVERLAPPED.Internal stays STATUS_PENDING (0x103) while the armed read waits; any other value is a completion not yet recorded.
    bool CompletionPending() { return Marshal.ReadIntPtr(watchOverlapped, 0).ToInt64() != 0x103; }

    // Called with gate held. Waits until no completion is in flight; fails closed if the watch cannot be drained in time.
    void Drain() {
      if (watchHandle == null || watchOverlapped == IntPtr.Zero) return;
      DateTime until = DateTime.UtcNow.AddSeconds(DrainSeconds);
      while (!watchFailed && (watchBusy || CompletionPending())) {
        int left = (int)(until - DateTime.UtcNow).TotalMilliseconds;
        if (left <= 0) throw new LeaseRefused("Change watch unsettled");
        Monitor.Wait(gate, Math.Min(left, 250));
      }
    }
    public int DrainSeconds = 30;

    void Record(int length) {
      int offset = 0;
      while (offset < length) {
        IntPtr entry = IntPtr.Add(watchBuffer, offset);
        int next = Marshal.ReadInt32(entry, 0);
        int nameLength = Marshal.ReadInt32(entry, 8);
        string name = Marshal.PtrToStringUni(IntPtr.Add(entry, 12), nameLength / 2);
        if (!Allowed(name)) lock (gate) { Events.Add("Change watch event: <admitted>\\" + name); }
        if (next == 0) break;
        offset += next;
      }
    }

    public bool Allowed(string name) {
      if (WorkNames.Contains(name)) return true;
      foreach (string prefix in WorkPrefixes) if (name.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) return true;
      return false;
    }

    // L3: re-run O2-O4/F2-F3 on every held and reserved handle, X2, and X3.
    public void Assert() {
      foreach (Held item in Items.ToArray()) Verify(item);
      ScanPlanted();
      lock (gate) {
        Drain();
        if (Events.Count > 0 || watchFailed) throw new LeaseRefused(Events.Count > 0 ? Events[0] : "Change watch failed");
      }
    }

    public void StopWatch() {
      if (watchHandle == null) return;
      watchStopping = true;
      Native.CancelIoEx(watchHandle, IntPtr.Zero);
      if (watchThread != null) watchThread.Join(5000);
      watchHandle.Dispose(); watchHandle = null;
    }

    public void Dispose() {
      StopWatch();
      foreach (Held item in Items) item.Handle.Dispose();
      Items.Clear(); byPath.Clear();
    }
  }

  // J1-J5: kill-on-close job that binds the exact invocation's process tree.
  public sealed class InvocationJob : IDisposable {
    public IntPtr Handle;
    public InvocationJob() {
      Handle = Native.CreateJobObjectW(IntPtr.Zero, null);
      if (Handle == IntPtr.Zero) throw new LeaseRefused("Job creation failed");
      int size = IntPtr.Size == 8 ? 144 : 112;
      IntPtr info = Marshal.AllocHGlobal(size);
      try {
        for (int i = 0; i < size; i++) Marshal.WriteByte(info, i, 0);
        Marshal.WriteInt32(info, 16, 0x2000);
        if (!Native.SetInformationJobObject(Handle, 9, info, (uint)size)) { int e = Marshal.GetLastWin32Error(); Native.CloseHandle(Handle); Handle = IntPtr.Zero; throw new LeaseRefused("Job limit failed (" + e + ")"); }
      } finally { Marshal.FreeHGlobal(info); }
    }
    public bool Assign(int pid) {
      IntPtr process = Native.OpenProcess(0x0100 | 0x0001 | 0x1000, false, pid);
      if (process == IntPtr.Zero) return false;
      try {
        bool inside;
        if (Native.IsProcessInJob(process, Handle, out inside) && inside) return true;
        return Native.AssignProcessToJobObject(Handle, process);
      } finally { Native.CloseHandle(process); }
    }
    public int ActiveProcesses() {
      IntPtr info = Marshal.AllocHGlobal(48);
      try {
        if (!Native.QueryInformationJobObject(Handle, 1, info, 48, IntPtr.Zero)) return -1;
        return Marshal.ReadInt32(info, 40);
      } finally { Marshal.FreeHGlobal(info); }
    }
    public void Terminate() { Native.TerminateJobObject(Handle, 1); }
    public void Dispose() { if (Handle != IntPtr.Zero) { Native.CloseHandle(Handle); Handle = IntPtr.Zero; } }
  }
}
'@
}

function Get-QualificationCallerSid { return [Security.Principal.WindowsIdentity]::GetCurrent().User.Value }

function Resolve-QualificationAdmitted([string]$ProfileRoot,[string]$Name) {
  if($Name -notmatch '^[A-Za-z0-9._-]+$'){throw 'Unsafe admitted path'}
  return [MurageQualification.Lease]::Canonical([IO.Path]::GetFullPath($ProfileRoot+'\AppData\Local\Temp\'+$Name))
}

function Invoke-QualificationLeaseCall([scriptblock]$Call) {
  try { & $Call } catch [MurageQualification.LeaseRefused] { throw $_.Exception.Message } catch {
    if($_.Exception.InnerException -is [MurageQualification.LeaseRefused]){throw $_.Exception.InnerException.Message}
    throw
  }
}

# R1/R2 + O1-O4 for every ancestor from the first directory under the drive root down to the admitted directory.
function New-QualificationLease([string]$Root,[string]$Directory,[scriptblock]$AfterOpen) {
  if($AfterOpen -and $env:WRP_WITNESS -ne '1'){throw 'AfterOpen is witness-only'}
  $lease=Invoke-QualificationLeaseCall { [MurageQualification.Lease]::new($Root,$Directory) }
  $lease | Add-Member -NotePropertyName AfterOpen -NotePropertyValue $AfterOpen
  return $lease
}

# F1-F4. The witness-only AfterOpen hook runs between the open and the hash (W-RP5b).
function Add-QualificationPin($Lease,[string]$Path,[string]$Sha256,[switch]$ReturnBytes) {
  Invoke-QualificationLeaseCall { $null=$Lease.OpenPinned($Path,'pinned') }
  if($Lease.AfterOpen){& $Lease.AfterOpen (Join-Path $Lease.Admitted $Path)}
  $bytes=Invoke-QualificationLeaseCall { $Lease.HashPinned($Path,$Sha256,[bool]$ReturnBytes) }
  if($ReturnBytes){return ,$bytes}
}

function Add-QualificationHeld($Lease,[string]$Path) { Invoke-QualificationLeaseCall { $Lease.HoldTree($Path) } }

function Add-QualificationScan($Lease,[string[]]$Directories) {
  foreach($directory in $Directories){ if($directory){Invoke-QualificationLeaseCall { $null=$Lease.HoldDirectory($Lease.Full($directory),'work') }}; $Lease.ScanDirectories.Add($directory) }
  Invoke-QualificationLeaseCall { $Lease.ScanPlanted() }
}

# X1 admission (reads only): registrar outputs and task logs must be absent; correction sources must exist and are held.
function Test-QualificationOutputs($Lease,[string[]]$Outputs,[string[]]$TaskLogs=@(),[string[]]$Correction=@(),[string[]]$CorrectionTaskLogs=@()) {
  foreach($name in @($Outputs)+@($TaskLogs)){ if($name){Invoke-QualificationLeaseCall { $Lease.CheckAbsent($name) }; $Lease.WorkNames.Add($name) | Out-Null} }
  foreach($name in $Correction){ if($name){Invoke-QualificationLeaseCall { $null=$Lease.HoldExisting($name,$false) }} }
  foreach($name in $CorrectionTaskLogs){ if($name){Invoke-QualificationLeaseCall { $null=$Lease.HoldExisting($name,$true) }} }
  $Lease | Add-Member -Force -NotePropertyName PlannedOutputs -NotePropertyValue @($Outputs | Where-Object {$_})
  $Lease | Add-Member -Force -NotePropertyName PlannedTaskLogs -NotePropertyValue @($TaskLogs | Where-Object {$_})
}

function Test-QualificationAbsent($Lease,[string]$Path) { Invoke-QualificationLeaseCall { $Lease.CheckAbsent($Path) } }

function Read-QualificationHeld($Lease,[string]$Path) { $bytes=Invoke-QualificationLeaseCall { ,$Lease.ReadHeld($Path) }; if($null -eq $bytes){$bytes=[byte[]]@()}; return ,([byte[]]$bytes) }

# X3 starts during admission; work subtrees come from the task sources (section 2.2 X3).
function Start-QualificationWatch($Lease,[string[]]$WorkPrefixes=@(),[string[]]$WorkNames=@()) {
  foreach($prefix in $WorkPrefixes){$Lease.WorkPrefixes.Add($prefix)}
  foreach($name in $WorkNames){$Lease.WorkNames.Add($name) | Out-Null}
  Invoke-QualificationLeaseCall { $Lease.StartWatch() }
}

# L3 (a), (a') and (b).
function Assert-QualificationLease($Lease) { Invoke-QualificationLeaseCall { $Lease.Assert() } }

# RESERVE: the first mutation. Registrar outputs first, the task log last; any failure deletes this run's files by handle.
# REFUSED-RESERVE only when every created file was removed; a file the rollback could not remove is REFUSED-RESERVE-DIRTY and named.
function Reserve-QualificationOutputs($Lease) {
  $created=[Collections.Generic.List[object]]::new()
  try {
    foreach($name in $Lease.PlannedOutputs){ $created.Add((Invoke-QualificationLeaseCall { $Lease.Reserve($name,$false) })) }
    foreach($name in $Lease.PlannedTaskLogs){ $created.Add((Invoke-QualificationLeaseCall { $Lease.Reserve($name,$true) })) }
  } catch {
    $refusal=$_.Exception.Message
    $left=[Collections.Generic.List[string]]::new()
    foreach($item in $created){ try { Invoke-QualificationLeaseCall { if($item.Kind -eq 'tasklog'){$Lease.DeleteTaskLog($item)}else{$Lease.DeleteReserved($item)} } } catch { $left.Add($item.Relative) } }
    # The refused item itself reports '; rollback left: <name>' when Reserve could not remove the file it created.
    if($left.Count){ throw ('REFUSED-RESERVE-DIRTY: '+$refusal+'; rollback left: '+($left -join ', ')) }
    if($refusal -like '*; rollback left: *'){ throw ('REFUSED-RESERVE-DIRTY: '+$refusal) }
    throw ('REFUSED-RESERVE: '+$refusal)
  }
}

function Write-QualificationOutput($Lease,[string]$Path,[byte[]]$Bytes) { Invoke-QualificationLeaseCall { $Lease.Write($Path,$Bytes) } }

# X1w: unused reservations (or every reservation for ABORTED-NO-CHANGE) are deleted through their own handles.
# Every candidate is attempted; any file left behind is named in one refusal.
function Remove-QualificationOutputs($Lease,[switch]$All) {
  $left=[Collections.Generic.List[string]]::new()
  foreach($item in @($Lease.Items)){ if($item.Kind -eq 'output' -and ($All -or !$item.Used)){ try { Invoke-QualificationLeaseCall { $Lease.DeleteReserved($item) } } catch { $left.Add($item.Relative) } } }
  if($left.Count){ throw ('Reserved output delete failed: '+($left -join ', ')) }
}

function Close-QualificationLease($Lease) { if($Lease){ $Lease.Dispose() } }

# The registrar clock (deadlines, start bound, settle waits, the J5 hold). OS layer: the Linux harness replaces it.
function Get-QualificationUtcNow { return [DateTime]::UtcNow }

# B2: the one scheduler instance lookup. Recorder witnesses shadow this function only; registrars never redefine it.
function Get-QualificationTaskActionPid([string]$TaskName) {
  $service=New-Object -ComObject Schedule.Service
  $service.Connect()
  try { $task=$service.GetFolder('\').GetTask($TaskName) } catch { return $null }
  foreach($instance in @($task.GetInstances(0))){ if($instance.EnginePID){ return [int]$instance.EnginePID } }
  return $null
}

function New-QualificationJob { return [MurageQualification.InvocationJob]::new() }

# J1: assign the cross-checked action process, then every descendant, until two consecutive passes add nothing.
function Bind-QualificationInvocation($Job,[int]$ActionPid,[string]$Admitted) {
  $action=Get-CimInstance Win32_Process -Filter ('ProcessId='+$ActionPid)
  if(!$action -or $action.Name -ne 'powershell.exe' -or !$action.CommandLine -or !$action.CommandLine.Contains($Admitted)){return $false}
  if(!$Job.Assign($ActionPid)){return $false}
  # ParentProcessId survives the parent's exit and PIDs are reused: a child counts only if it was created after its bound parent.
  $bound=@{}; $bound[$ActionPid]=$action.CreationDate
  $quiet=0
  while($quiet -lt 2) {
    $added=0
    foreach($process in @(Get-CimInstance Win32_Process)) {
      $parent=[int]$process.ParentProcessId; $child=[int]$process.ProcessId
      if($bound.ContainsKey($parent) -and !$bound.ContainsKey($child) -and $process.CreationDate -and $bound[$parent] -and $process.CreationDate -ge $bound[$parent]) {
        if(!$Job.Assign($child)){return $false}
        $bound[$child]=$process.CreationDate; $added++
      }
    }
    if($added){$quiet=0}else{$quiet++}
  }
  return $true
}
