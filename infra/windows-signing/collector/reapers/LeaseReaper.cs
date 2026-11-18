// Lease/capability recovery producer owner: Builder A win-sac-sign-sa; authenticated observer/session admission owner: MAIN; observer adapter owner: Builder B win-sac-sign-sb.
using System;

namespace Murage.Witness
{
    public sealed record LeaseIncarnation(RunResource Service, RunResource Owner, RunResource Child, string Instance);
    public interface ILeaseReaperApi
    {
        void RequireAuthenticatedObserver();
        bool Unknown(string nonce, LeaseIncarnation incarnation);
        void CloseOwningSession(LeaseIncarnation incarnation);
    }
    public sealed class LeaseReaper : BoundReaper
    {
        private readonly ILeaseReaperApi api;
        private readonly IResourceReaper processes;
        private readonly string type;
        public LeaseReaper(string runNonce, string type) : this(runNonce, type, new WindowsLeaseReaperApi(), new ProcessReaper()) { }
        public LeaseReaper(string runNonce, string type, ILeaseReaperApi api, IResourceReaper processes) : base(runNonce)
        {
            if (type != "lease" && type != "capability") throw WitnessCodec.Reject("RESOURCE");
            this.type = type; this.api = api; this.processes = processes;
        }
        private LeaseIncarnation Identity(RunResource resource)
        {
            using var doc = Binding(resource, type, "servicePid", "serviceCreation", "ownerPid", "ownerCreation", "childPid", "childCreation", "instance"); var row = doc.RootElement;
            if (!WitnessCodec.Hex(resource.Id, 64) || !WitnessCodec.Hex(WitnessCodec.Text(row, "instance"), 32)) throw WitnessCodec.Reject("LEASE_IDENTITY");
            RunResource Process(string prefix)
            {
                string pid = WitnessCodec.Text(row, prefix + "Pid"), creation = WitnessCodec.Text(row, prefix + "Creation");
                if (!UInt32.TryParse(pid, System.Globalization.NumberStyles.None, System.Globalization.CultureInfo.InvariantCulture, out var p) || p == 0 || p.ToString(System.Globalization.CultureInfo.InvariantCulture) != pid
                    || !Int64.TryParse(creation, System.Globalization.NumberStyles.None, System.Globalization.CultureInfo.InvariantCulture, out var c) || c <= 0 || c.ToString(System.Globalization.CultureInfo.InvariantCulture) != creation) throw WitnessCodec.Reject("LEASE_IDENTITY");
                return new RunResource("process", pid, creation);
            }
            var result = new LeaseIncarnation(Process("service"), Process("owner"), Process("child"), WitnessCodec.Text(row, "instance"));
            if (result.Service.Id == result.Owner.Id || result.Child.Id == result.Service.Id || result.Child.Id == result.Owner.Id) throw WitnessCodec.Reject("LEASE_IDENTITY");
            return result;
        }
        public override bool Absent(RunResource resource)
        {
            var id = Identity(resource);
            if (processes.Absent(id.Service)) return true;
            api.RequireAuthenticatedObserver();
            return processes.Absent(id.Child) && api.Unknown(resource.Id, id);
        }
        public override void Destroy(RunResource resource)
        {
            var id = Identity(resource);
            if (processes.Absent(id.Service)) return;
            api.RequireAuthenticatedObserver();
            api.CloseOwningSession(id);
        }
    }
    public sealed class WindowsLeaseReaperApi : ILeaseReaperApi
    {
        public void RequireAuthenticatedObserver() => throw WitnessCodec.Reject("OBSERVATION_AUTH_UNENROLLED_R_COL_6");
        public bool Unknown(string nonce, LeaseIncarnation incarnation) { RequireAuthenticatedObserver(); return false; }
        public void CloseOwningSession(LeaseIncarnation incarnation)
        {
            RequireAuthenticatedObserver();
            // Disconnect-revoke is the existing session protocol; no administrative revoke RPC is introduced.
            new ProcessReaper().Destroy(incarnation.Owner);
        }
    }
}
