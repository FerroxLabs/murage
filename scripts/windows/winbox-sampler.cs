// Loaded only by Windows PowerShell 5.1 on the interactive Windows 11 runner.
using System;
using System.IO;
using System.Text;
using System.Threading;
using System.Diagnostics;
using System.Management;
using System.Collections.Generic;
using System.Collections.Concurrent;
using System.Runtime.InteropServices;
using System.Web.Script.Serialization;
public sealed class WinboxSampler : IDisposable {
  delegate bool Callback(IntPtr hwnd, IntPtr data);
  [DllImport("user32.dll", SetLastError=true)] static extern bool EnumWindows(Callback callback, IntPtr data);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder name, int size);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder name, int size);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Entry {
    public uint size, usage, pid; public UIntPtr heap; public uint module, threads, parent; public int priority; public uint flags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=260)] public string name;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool Process32First(IntPtr snapshot, ref Entry entry);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool Process32Next(IntPtr snapshot, ref Entry entry);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(IntPtr process, out long birth, out long exit, out long kernel, out long user);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool QueryFullProcessImageName(IntPtr process, uint flags, StringBuilder path, ref int size);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll")] static extern uint WTSGetActiveConsoleSessionId();
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("user32.dll", SetLastError=true)] static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
  [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr desktop);
  [DllImport("user32.dll")] static extern IntPtr GetThreadDesktop(uint thread);
  [DllImport("user32.dll")] static extern IntPtr GetProcessWindowStation();
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern bool GetUserObjectInformation(IntPtr handle, int index, StringBuilder text, uint length, out uint needed);
  static string Name(IntPtr h) {
    var s=new StringBuilder(512);uint needed;
    if(h==IntPtr.Zero || !GetUserObjectInformation(h,2,s,1024,out needed)) throw new Exception("Cannot identify input desktop");
    return s.ToString();
  }
  public static void RequireDesktop() {
    var input=OpenInputDesktop(0,false,1);
    try {
      int session=Process.GetCurrentProcess().SessionId;
      if(session==0 || session!=WTSGetActiveConsoleSessionId() || Name(input)!="Default" || Name(GetThreadDesktop(GetCurrentThreadId()))!="Default" || Name(GetProcessWindowStation())!="WinSta0") throw new Exception("Interactive WinSta0 Default desktop required (unlocked)");
    } finally {if(input!=IntPtr.Zero)CloseDesktop(input);}
  }
  public sealed class Proc {
    public uint pid, parent; public string birth, imagePath, commandLine, error;
    public string Key {get {return pid+":"+birth;}}
  }
  public sealed class Window {
    public string hwnd, className, title, birth, imagePath;public uint pid;public bool visible;
  }
  public sealed class Sample {public long at;public List<Window> windows;public List<Proc> processes;}
  public readonly ConcurrentQueue<string> Errors=new ConcurrentQueue<string>();
  public readonly ConcurrentDictionary<string,Proc> Metadata=new ConcurrentDictionary<string,Proc>();
  readonly BlockingCollection<Proc> pending=new BlockingCollection<Proc>();
  readonly HashSet<string> requested=new HashSet<string>();
  readonly ManualResetEvent stop=new ManualResetEvent(false);
  readonly StreamWriter output;
  readonly Thread sampler, metadata;
  readonly Stopwatch clock=new Stopwatch();
  long last;public long FinalGapMs;public long Samples;
  public static long Now() {return DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();}
  public WinboxSampler(string file) {
    RequireDesktop();output=new StreamWriter(new FileStream(file,FileMode.CreateNew,FileAccess.Write,FileShare.Read),new UTF8Encoding(false));
    metadata=new Thread(ReadMetadata);metadata.IsBackground=true;metadata.Start();
    // Establish baseline synchronously, before the installer or worker can start.
    clock.Start();Capture();
    sampler=new Thread(Loop);sampler.IsBackground=true;sampler.Start();
  }
  List<Proc> Processes() {
    var rows=new List<Proc>();var snapshot=CreateToolhelp32Snapshot(2,0);
    if(snapshot==new IntPtr(-1))throw new Exception("Process snapshot failed: "+Marshal.GetLastWin32Error());
    try {
      var e=new Entry();e.size=(uint)Marshal.SizeOf(e);
      if(!Process32First(snapshot,ref e))throw new Exception("Process32First failed");
      do {
        var p=new Proc {pid=e.pid,parent=e.parent,birth="0",imagePath=e.name};
        var h=OpenProcess(0x1000,false,e.pid);
        if(h!=IntPtr.Zero)try {
          long birth,exit,kernel,user;
          if(GetProcessTimes(h,out birth,out exit,out kernel,out user))p.birth=birth.ToString();
          int size=32768;var path=new StringBuilder(size);
          if(QueryFullProcessImageName(h,0,path,ref size))p.imagePath=path.ToString();
        } finally {CloseHandle(h);}
        rows.Add(p);
      } while(Process32Next(snapshot,ref e));
      if(Marshal.GetLastWin32Error()!=18)throw new Exception("Process32Next incomplete");
    } finally {CloseHandle(snapshot);}
    return rows;
  }
  void Capture() {
    RequireDesktop();
    var processes=Processes();var byPid=new Dictionary<uint,Proc>();foreach(var p in processes)byPid[p.pid]=p;
    var windows=new List<Window>();
    var at=Now();last=clock.ElapsedMilliseconds;
    bool ok=EnumWindows((hwnd,data)=>{
      uint pid;GetWindowThreadProcessId(hwnd,out pid);var cls=new StringBuilder(256);var title=new StringBuilder(2048);
      if(GetClassName(hwnd,cls,cls.Capacity)==0)return true; // Window destroyed during enumeration.
      GetWindowText(hwnd,title,title.Capacity);
      Proc p;if(!byPid.TryGetValue(pid,out p))p=new Proc{pid=pid,birth="0",imagePath=""};
      var w=new Window{hwnd=hwnd.ToInt64().ToString(),pid=pid,birth=p.birth,imagePath=p.imagePath,className=cls.ToString(),title=title.ToString(),visible=IsWindowVisible(hwnd)};
      windows.Add(w);
      // WMI never blocks EnumWindows. Cache metadata immediately for short-lived owners.
      if(w.visible && requested.Add(p.Key))pending.Add(p);
      return true;
    },IntPtr.Zero);
    if(!ok)throw new Exception("EnumWindows failed: "+Marshal.GetLastWin32Error());
    var json=new JavaScriptSerializer();json.MaxJsonLength=int.MaxValue;
    output.WriteLine(json.Serialize(new Sample{at=at,windows=windows,processes=processes}));output.Flush();Samples++;
  }
  void Loop() {
    long next=200;
    while(!stop.WaitOne((int)Math.Max(0,next-clock.ElapsedMilliseconds))) {
      try {Capture();}catch(Exception e){Errors.Enqueue(e.ToString());}
      next+=200;
      if(clock.ElapsedMilliseconds>next+200)next=clock.ElapsedMilliseconds; // Evidence gap fails verdict; never hide a missed tick.
    }
  }
  void ReadMetadata() {
    foreach(var p in pending.GetConsumingEnumerable()) {
      try {
        var options=new EnumerationOptions();options.Timeout=TimeSpan.FromSeconds(2);
        using(var query=new ManagementObjectSearcher("root\\CIMV2","SELECT ExecutablePath,CommandLine,CreationDate FROM Win32_Process WHERE ProcessId="+p.pid,options))
        using(var rows=query.Get())foreach(ManagementObject row in rows)using(row) {
          var birth=ManagementDateTimeConverter.ToDateTime((string)row["CreationDate"]).ToUniversalTime().ToFileTimeUtc();
          // Win32_Process CreationDate has microsecond precision; native FILETIME has 100 ns precision.
          if(p.birth!="0" && Math.Abs(birth-long.Parse(p.birth))>=10)throw new Exception("PID reused before metadata lookup");
          p.commandLine=(string)row["CommandLine"];p.imagePath=(string)row["ExecutablePath"] ?? p.imagePath;
        }
        if(String.IsNullOrEmpty(p.commandLine))p.error="Owner exited or command line inaccessible";
      }catch(Exception e){p.error=e.Message;}
      Metadata[p.Key]=p;
    }
  }
  public void Dispose() {
    stop.Set();sampler.Join();
    // Last sample covers worker exit, owned cleanup, and final screenshot.
    try{Capture();}catch(Exception e){Errors.Enqueue(e.ToString());}
    FinalGapMs=clock.ElapsedMilliseconds-last;output.Dispose();pending.CompleteAdding();
    if(!metadata.Join(10000))Errors.Enqueue("Metadata worker did not finish within 10 seconds");
    clock.Stop();stop.Dispose();
  }
}
