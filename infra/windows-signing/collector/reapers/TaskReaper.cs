// Task recovery producer owner: Builder A win-sac-sign-sa; protected run-folder/task registration owner: MAIN.
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
using System.Xml;
using System.Xml.Linq;

namespace Murage.Witness
{
    public interface ITaskReaperApi
    {
        string Nonce(string path);
        void Delete(string path, string nonce);
    }
    public sealed class TaskReaper : BoundReaper
    {
        private readonly ITaskReaperApi api;
        public TaskReaper(string runNonce) : this(runNonce, new WindowsTaskReaperApi()) { }
        public TaskReaper(string runNonce, ITaskReaperApi api) : base(runNonce) { this.api = api; }
        private string Nonce(RunResource resource)
        {
            using var doc = Binding(resource, "task", "nonce"); string nonce = WitnessCodec.Text(doc.RootElement, "nonce");
            if (!WitnessCodec.Hex(nonce, 32) || !Regex.IsMatch(resource.Id, @"\A\\MurageWitness\\" + RunNonce + @"\\[a-z0-9-]+\z")) throw WitnessCodec.Reject("TASK_IDENTITY");
            return nonce;
        }
        public override bool Absent(RunResource resource)
        {
            string expected = Nonce(resource), actual = api.Nonce(resource.Id);
            return actual == null || actual != expected && Foreign(resource);
        }
        public override void Destroy(RunResource resource)
        {
            string expected = Nonce(resource), actual = api.Nonce(resource.Id);
            if (actual == null) return;
            if (actual != expected) { Foreign(resource); return; }
            api.Delete(resource.Id, expected);
        }
    }
    public sealed class WindowsTaskReaperApi : ITaskReaperApi
    {
        [StructLayout(LayoutKind.Explicit, Size = 24)] private struct Variant { [FieldOffset(0)] public ushort Type; }
        [DllImport("ole32.dll")] private static extern int CoInitializeEx(IntPtr reserved, uint flags);
        [DllImport("ole32.dll")] private static extern void CoUninitialize();
        [DllImport("ole32.dll")] private static extern int CoCreateInstance(ref Guid clsid, IntPtr outer, uint context, ref Guid iid, out IntPtr value);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)] private delegate int Connect(IntPtr self, Variant server, Variant user, Variant domain, Variant password);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)] private delegate int GetNamed(IntPtr self, IntPtr name, out IntPtr value);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)] private delegate int GetText(IntPtr self, out IntPtr text);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)] private delegate int DeleteNamed(IntPtr self, IntPtr name, int flags);
        private static T Method<T>(IntPtr self, int slot) where T : Delegate => Marshal.GetDelegateForFunctionPointer<T>(Marshal.ReadIntPtr(Marshal.ReadIntPtr(self), slot * IntPtr.Size));
        private static void Check(int hr) { if (hr < 0) throw WitnessCodec.Reject("TASK_QUERY"); }
        private static string Description(IntPtr task)
        {
            Check(Method<GetText>(task, 20)(task, out var xml));
            try
            {
                string text = Marshal.PtrToStringBSTR(xml);
                if (text.Length > 16 * 1024) throw WitnessCodec.Reject("TASK_QUERY");
                using var reader = XmlReader.Create(new StringReader(text), new XmlReaderSettings { DtdProcessing = DtdProcessing.Prohibit, XmlResolver = null, MaxCharactersInDocument = 16 * 1024 });
                var document = XDocument.Load(reader); XNamespace ns = "http://schemas.microsoft.com/windows/2004/02/mit/task";
                return document.Root?.Element(ns + "RegistrationInfo")?.Element(ns + "Description")?.Value ?? "";
            }
            finally { Marshal.FreeBSTR(xml); }
        }
        private static string Access(string path, string nonce, bool delete)
        {
            if (!OperatingSystem.IsWindows() || IntPtr.Size != 8) throw WitnessCodec.Reject("WINDOWS_REQUIRED");
            int initialized = CoInitializeEx(IntPtr.Zero, 0); if (initialized < 0 && initialized != unchecked((int)0x80010106)) Check(initialized);
            IntPtr service = IntPtr.Zero, folder = IntPtr.Zero, task = IntPtr.Zero, folderName = IntPtr.Zero, taskName = IntPtr.Zero;
            try
            {
                var clsid = new Guid("0f87369f-a4e5-4cfc-bd3e-73e6154572dd"); var iid = new Guid("2faba4c7-4da9-4013-9697-20cc3fd40f85");
                Check(CoCreateInstance(ref clsid, IntPtr.Zero, 1, ref iid, out service));
                Check(Method<Connect>(service, 10)(service, default, default, default, default));
                int split = path.LastIndexOf('\\'); folderName = Marshal.StringToBSTR(path.Substring(0, split)); taskName = Marshal.StringToBSTR(path.Substring(split + 1));
                int hr = Method<GetNamed>(service, 7)(service, folderName, out folder);
                if (hr == unchecked((int)0x80070002) || hr == unchecked((int)0x80070003)) return null; Check(hr);
                hr = Method<GetNamed>(folder, 13)(folder, taskName, out task);
                if (hr == unchecked((int)0x80070002)) return null; Check(hr);
                string actual = Description(task);
                if (delete && actual == nonce) Check(Method<DeleteNamed>(folder, 15)(folder, taskName, 0));
                return actual;
            }
            finally
            {
                if (task != IntPtr.Zero) Marshal.Release(task); if (folder != IntPtr.Zero) Marshal.Release(folder); if (service != IntPtr.Zero) Marshal.Release(service);
                if (folderName != IntPtr.Zero) Marshal.FreeBSTR(folderName); if (taskName != IntPtr.Zero) Marshal.FreeBSTR(taskName);
                if (initialized >= 0) CoUninitialize();
            }
        }
        public string Nonce(string path) => Access(path, null, false);
        public void Delete(string path, string nonce) { Access(path, nonce, true); }
    }
}
