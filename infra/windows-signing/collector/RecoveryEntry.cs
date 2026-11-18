// Recovery API owner: Builder A win-sac-sign-sa; CLI caller owner: Builder B win-sac-sign-sb; protected installation/execution owner: MAIN.
using System;
using System.IO;
using System.Linq;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Text.Json;

namespace Murage.Witness
{
    public static class RecoveryEntry
    {
        internal const string Root = @"C:\Program Files\MurageSigning";
        internal static string RunRoot(string runNonce)
        {
            if (!WitnessCodec.Hex(runNonce, 64)) throw WitnessCodec.Reject("JOURNAL_BINDING");
            return Root + @"\controller\runs\" + runNonce;
        }
        internal static void Admission(string path)
        {
            if (!OperatingSystem.IsWindows()) throw WitnessCodec.Reject("WINDOWS_REQUIRED");
            using var identity = WindowsIdentity.GetCurrent();
            if (identity.User?.Value != "S-1-5-18" && !new WindowsPrincipal(identity).IsInRole(WindowsBuiltInRole.Administrator)) throw WitnessCodec.Reject("REAPER_IDENTITY");
            for (var current = path; current != null && (current == Root || current.StartsWith(Root + "\\", StringComparison.Ordinal)); current = Path.GetDirectoryName(current))
            {
                FileSystemSecurity acl = Directory.Exists(current) ? new DirectoryInfo(current).GetAccessControl() : new FileInfo(current).GetAccessControl();
                bool Trusted(IdentityReference sid) => sid.Value == "S-1-5-18" || sid.Value == "S-1-5-32-544";
                if (!Trusted(acl.GetOwner(typeof(SecurityIdentifier)))) throw WitnessCodec.Reject("CONFIG_ACL");
                foreach (FileSystemAccessRule rule in acl.GetAccessRules(true, true, typeof(SecurityIdentifier)))
                    if (rule.AccessControlType == AccessControlType.Allow && !Trusted(rule.IdentityReference)
                        && (rule.FileSystemRights & (FileSystemRights.Write | FileSystemRights.Delete | FileSystemRights.DeleteSubdirectoriesAndFiles | FileSystemRights.ChangePermissions | FileSystemRights.TakeOwnership)) != 0)
                        throw WitnessCodec.Reject("CONFIG_ACL");
            }
        }
        private static JournalState Read(string path, string runNonce)
        {
            using var leaf = new WindowsFileReaperApi().Open(path, false);
            if (leaf == null || leaf.Reparse || leaf.Links != 1) throw WitnessCodec.Reject("REGULAR_FILE_REQUIRED");
            using var file = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.None);
            return ResourceJournal.Read(file, runNonce);
        }
        internal static ReaperRegistry Registry(string runNonce)
        {
            string config = RunRoot(runNonce) + @"\recovery.json"; Admission(config);
            using var held = new HeldFile(config, 16 * 1024);
            using var document = WitnessCodec.Parse(held.Bytes, 16 * 1024); var row = document.RootElement;
            WitnessCodec.Fields(row, "runNonce", "scratchRoot", "installRoot");
            if (WitnessCodec.Text(row, "runNonce") != runNonce) throw WitnessCodec.Reject("REAPER_RUN_BINDING");
            string scratch = WitnessCodec.Text(row, "scratchRoot"), install = WitnessCodec.Text(row, "installRoot");
            WitnessCodec.Absolute(scratch); WitnessCodec.Absolute(install);
            if (scratch.Equals(install, StringComparison.OrdinalIgnoreCase) || scratch.StartsWith(install + "\\", StringComparison.OrdinalIgnoreCase)
                || install.StartsWith(scratch + "\\", StringComparison.OrdinalIgnoreCase)) throw WitnessCodec.Reject("REAPER_ROOTS");
            return new ReaperRegistry().Add("process", new ProcessReaper()).Add("job", new JobReaper(runNonce))
                .Add("lease", new LeaseReaper(runNonce, "lease")).Add("capability", new LeaseReaper(runNonce, "capability"))
                .Add("file", new FileReaper(runNonce, scratch)).Add("task", new TaskReaper(runNonce))
                .Add("service-state", new ServiceStateReaper(runNonce)).Add("wfp-filter", new WfpReaper(runNonce)).Add("install", new InstallReaper(runNonce, install));
        }
        public static void Reap(string runNonce) => Reap(runNonce, "operator");
        private static void Reap(string runNonce, string role)
        {
            string root = RunRoot(runNonce), path = root + @"\resources.jsonl"; Admission(path);
            using var directory = HeldFile.HoldDirectory(root);
            var state = Read(path, runNonce); var registry = Registry(runNonce);
            bool complete = ResourceRecovery.Reap(state, registry);
            if (registry.Retained.Count != 0)
            {
                using var bytes = new MemoryStream();
                using (var writer = new Utf8JsonWriter(bytes))
                {
                    writer.WriteStartObject(); writer.WriteString("event", "retained"); writer.WriteString("runNonce", runNonce); writer.WriteStartArray("resources");
                    foreach (var resource in registry.Retained)
                    { writer.WriteStartObject(); writer.WriteString("type", resource.Type); writer.WriteString("id", resource.Id); writer.WriteEndObject(); }
                    writer.WriteEndArray(); writer.WriteEndObject();
                }
                Console.WriteLine(Encoding.UTF8.GetString(bytes.ToArray()));
            }
            if (!complete) throw WitnessCodec.Reject("RECOVERY_INCOMPLETE");
            if (!state.RunFinalized)
            {
                using var journal = ResourceJournal.Open(path, runNonce);
                foreach (var resource in journal.State.Remaining) journal.ConfirmReaped(resource, role);
            }
        }
        public static void Supervise(string[] args)
        {
            var a = Supervisor.Arguments(args); string path = RunRoot(a.Run) + @"\resources.jsonl"; Admission(path);
            using var lifetime = new CollectorLifetime(a.Pid, a.Creation);
            bool success = Supervisor.Run(lifetime, a.Expires,
                () => { var state = Read(path, a.Run); return !state.TornTail && state.RunFinalized; },
                () => { Reap(a.Run, "supervisor"); return true; },
                () => new ProcessReaper().Destroy(new RunResource("process", a.Pid.ToString(System.Globalization.CultureInfo.InvariantCulture), a.Creation.ToString(System.Globalization.CultureInfo.InvariantCulture))));
            if (!success) throw WitnessCodec.Reject("RECOVERY_INCOMPLETE");
        }
    }
}
