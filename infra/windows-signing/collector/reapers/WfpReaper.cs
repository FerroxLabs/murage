// WFP recovery producer owner: Builder A win-sac-sign-sa; privileged temporary filter/provider admission owner: MAIN.
using System;
using System.Runtime.InteropServices;

namespace Murage.Witness
{
    public sealed record FilterIdentity(Guid Provider, Guid Sublayer);
    public interface IWfpReaperApi
    {
        FilterIdentity Read(Guid key);
        void Delete(Guid key, FilterIdentity expected);
    }
    public sealed class WfpReaper : BoundReaper
    {
        private readonly IWfpReaperApi api;
        public WfpReaper(string runNonce) : this(runNonce, new WindowsWfpReaperApi()) { }
        public WfpReaper(string runNonce, IWfpReaperApi api) : base(runNonce) { this.api = api; }
        private (Guid Key, FilterIdentity Identity) Identity(RunResource resource)
        {
            using var doc = Binding(resource, "wfp-filter", "provider", "sublayer");
            if (!Guid.TryParseExact(resource.Id, "D", out var key) || key == Guid.Empty
                || !Guid.TryParseExact(WitnessCodec.Text(doc.RootElement, "provider"), "D", out var provider) || provider == Guid.Empty
                || !Guid.TryParseExact(WitnessCodec.Text(doc.RootElement, "sublayer"), "D", out var sublayer) || sublayer == Guid.Empty) throw WitnessCodec.Reject("WFP_IDENTITY");
            return (key, new FilterIdentity(provider, sublayer));
        }
        public override bool Absent(RunResource resource)
        { var id = Identity(resource); var actual = api.Read(id.Key); return actual == null || actual != id.Identity && Foreign(resource); }
        public override void Destroy(RunResource resource)
        {
            var id = Identity(resource); var actual = api.Read(id.Key);
            if (actual == null) return;
            if (actual != id.Identity) { Foreign(resource); return; }
            api.Delete(id.Key, id.Identity);
        }
    }
    public sealed class WindowsWfpReaperApi : IWfpReaperApi
    {
        [StructLayout(LayoutKind.Sequential)] private struct Blob { public uint Size; public IntPtr Data; }
        [StructLayout(LayoutKind.Sequential)] private struct FilterPrefix
        { public Guid Key; public IntPtr Name, Description; public uint Flags; public IntPtr Provider; public Blob Data; public Guid Layer, Sublayer; }
        [DllImport("fwpuclnt.dll", CharSet = CharSet.Unicode)] private static extern uint FwpmEngineOpen0(string server, uint auth, IntPtr identity, IntPtr session, out IntPtr engine);
        [DllImport("fwpuclnt.dll")] private static extern uint FwpmEngineClose0(IntPtr engine);
        [DllImport("fwpuclnt.dll")] private static extern uint FwpmFilterGetByKey0(IntPtr engine, ref Guid key, out IntPtr filter);
        [DllImport("fwpuclnt.dll")] private static extern uint FwpmFilterDeleteByKey0(IntPtr engine, ref Guid key);
        [DllImport("fwpuclnt.dll")] private static extern void FwpmFreeMemory0(ref IntPtr memory);
        [DllImport("fwpuclnt.dll")] private static extern uint FwpmTransactionBegin0(IntPtr engine, uint flags);
        [DllImport("fwpuclnt.dll")] private static extern uint FwpmTransactionCommit0(IntPtr engine);
        [DllImport("fwpuclnt.dll")] private static extern uint FwpmTransactionAbort0(IntPtr engine);
        private static void Check(uint code) { if (code != 0) throw WitnessCodec.Reject("WFP_QUERY"); }
        private static IntPtr Open()
        { if (!OperatingSystem.IsWindows()) throw WitnessCodec.Reject("WINDOWS_REQUIRED"); Check(FwpmEngineOpen0(null, 10, IntPtr.Zero, IntPtr.Zero, out var engine)); return engine; }
        private static FilterIdentity Read(IntPtr engine, Guid key)
        {
            uint code = FwpmFilterGetByKey0(engine, ref key, out var filter);
            if (code == 0x80320003) return null; Check(code);
            try
            {
                var value = Marshal.PtrToStructure<FilterPrefix>(filter);
                return new FilterIdentity(value.Provider == IntPtr.Zero ? Guid.Empty : Marshal.PtrToStructure<Guid>(value.Provider), value.Sublayer);
            }
            finally { FwpmFreeMemory0(ref filter); }
        }
        public FilterIdentity Read(Guid key)
        { var engine = Open(); try { return Read(engine, key); } finally { FwpmEngineClose0(engine); } }
        public void Delete(Guid key, FilterIdentity expected)
        {
            var engine = Open(); bool transaction = false;
            try
            {
                Check(FwpmTransactionBegin0(engine, 0)); transaction = true;
                var actual = Read(engine, key);
                if (actual != null && actual == expected) Check(FwpmFilterDeleteByKey0(engine, ref key));
                Check(FwpmTransactionCommit0(engine)); transaction = false;
            }
            finally { if (transaction) FwpmTransactionAbort0(engine); FwpmEngineClose0(engine); }
        }
    }
}
