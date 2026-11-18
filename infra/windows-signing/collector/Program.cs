// Native collector producer: win-sac-sign; protected adapters, enrollment, signing and execution consumer: MAIN.
using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Text.Json;
using Murage.Signing;

namespace Murage.Witness
{
    public static class Program
    {
        private const string Root = @"C:\Program Files\MurageSigning";
        private const string EnrollmentFile = Root + @"\controller\witness-enrollment.json";
        private static byte[] Plan()
        {
            using var input = Assembly.GetExecutingAssembly().GetManifestResourceStream("witness-plan.json");
            if (input == null || input.Length > 1024 * 1024) throw WitnessCodec.Reject("PLAN_DIGEST");
            using var output = new MemoryStream(); input.CopyTo(output); return output.ToArray();
        }
        private static void Protected(string file)
        {
            // Public references confer authority only from the separately installed protected configuration.
            for (var current = file; current != null && (current == Root || current.StartsWith(Root + "\\", StringComparison.Ordinal)); current = Path.GetDirectoryName(current))
            {
                FileSystemSecurity acl = Directory.Exists(current)
                    ? new DirectoryInfo(current).GetAccessControl() : new FileInfo(current).GetAccessControl();
                bool Trusted(IdentityReference sid) => sid.Value == "S-1-5-18" || sid.Value == "S-1-5-32-544";
                if (!Trusted(acl.GetOwner(typeof(SecurityIdentifier)))) throw WitnessCodec.Reject("CONFIG_ACL");
                foreach (FileSystemAccessRule rule in acl.GetAccessRules(true, true, typeof(SecurityIdentifier)))
                    if (rule.AccessControlType == AccessControlType.Allow && !Trusted(rule.IdentityReference)
                        && (rule.FileSystemRights & (FileSystemRights.Write | FileSystemRights.Delete | FileSystemRights.DeleteSubdirectoriesAndFiles
                            | FileSystemRights.ChangePermissions | FileSystemRights.TakeOwnership)) != 0) throw WitnessCodec.Reject("CONFIG_ACL");
            }
        }
        private static void References(JsonElement enrollment, Action execute)
        {
            var held = new System.Collections.Generic.List<HeldFile>();
            try
            {
                foreach (var name in new[] { "collector", "machineTag" })
                {
                    var pin = enrollment.GetProperty(name);
                    held.Add(new HeldFile(WitnessCodec.Text(pin, "file"), WitnessCodec.CaptureLimit, WitnessCodec.Text(pin, "sha256")));
                }
                var inputs = enrollment.GetProperty("inputs");
                foreach (var prefix in new[] { "candidate", "evidence" })
                {
                    var file = new HeldFile(WitnessCodec.Text(inputs, prefix + "File"), 8 * 1024 * 1024, WitnessCodec.Text(inputs, prefix + "Sha256")); held.Add(file);
                    using var document = WitnessCodec.Parse(file.Bytes, 8 * 1024 * 1024);
                    foreach (var name in new[] { "sourceRevision", "version", "target", "runId", "runAttempt" })
                        if (WitnessCodec.Text(document.RootElement, name) != WitnessCodec.Text(enrollment.GetProperty("identity"), name)) throw WitnessCodec.Reject("IDENTITY");
                }
                execute();
            }
            finally { foreach (var file in held.AsEnumerable().Reverse()) file.Dispose(); }
        }
        private static void Witness(string[] args, byte[] planBytes)
        {
            WitnessCodec.WitnessEnvironment();
            if (args.Length != 6 || args[0] != "--witness-case" || args[2] != "--request" || args[4] != "--output") throw WitnessCodec.Reject("USAGE");
            WitnessCodec.Absolute(args[3]); WitnessCodec.Absolute(args[5]);
            if (Path.GetDirectoryName(args[3]) != args[5] || Path.GetFileName(args[3]) != "request.json") throw WitnessCodec.Reject("REQUEST_PATH");
            using var identity = WindowsIdentity.GetCurrent();
            new WindowsSigningProcessApi().AssertStandardTokenIdentity(identity.Token);
            using var digestFile = new HeldFile(EnrollmentFile + ".sha256", 65);
            using var enrollmentFile = new HeldFile(EnrollmentFile, 1024 * 1024, Encoding.ASCII.GetString(digestFile.Bytes).TrimEnd('\n'));
            Protected(EnrollmentFile); Protected(EnrollmentFile + ".sha256");
            using var enrollment = WitnessCodec.Parse(enrollmentFile.Bytes, 1024 * 1024);
            WitnessCodec.Enrollment(enrollment.RootElement, HeldFile.Hash(planBytes));
            if (WitnessCodec.Text(enrollment.RootElement.GetProperty("collector"), "file") != Environment.ProcessPath) throw WitnessCodec.Reject("COLLECTOR_PATH");
            using var requestFile = new HeldFile(args[3], 8 * 1024 * 1024);
            using var request = WitnessCodec.Parse(requestFile.Bytes, 8 * 1024 * 1024);
            using var plan = WitnessCodec.Parse(planBytes, 1024 * 1024);
            WitnessCodec.Request(request.RootElement, enrollment.RootElement, args[1], plan.RootElement);
            References(enrollment.RootElement, () => CollectionEntry.Witness(requestFile.Bytes, enrollment.RootElement, plan.RootElement, args[1], args[5]));
        }
        private static void Assets(string[] args) => CollectionEntry.Assets(args, File.Exists(EnrollmentFile) || File.Exists(EnrollmentFile + ".sha256"));
        public static int Main(string[] args)
        {
            try
            {
                if (!OperatingSystem.IsWindows()) throw WitnessCodec.Reject("WINDOWS_REQUIRED");
                var plan = Plan();
                if (args.Length == 0) throw WitnessCodec.Reject("USAGE");
                if (args[0] == "--assets") Assets(args);
                else if (args[0] == "--witness-case") Witness(args, plan);
                else if (args.Length == 2 && args[0] == "--reap-run") { RecoveryEntry.Reap(args[1]); return 0; }
                else if (args[0] == "--supervise") { RecoveryEntry.Supervise(args); return 0; }
                else if (args.Length == 4 && args[0] == "--validate-enrollment" && args[2] == "--sha256")
                {
                    using var held = new HeldFile(args[1], 1024 * 1024, args[3]);
                    using var enrollment = WitnessCodec.Parse(held.Bytes, 1024 * 1024);
                    WitnessCodec.Enrollment(enrollment.RootElement, HeldFile.Hash(plan)); References(enrollment.RootElement, () => { });
                    Console.WriteLine("WINDOWS_WITNESS_PUBLIC_REFERENCES_VALID RELEASE_HOLD"); return 0;
                }
                else throw WitnessCodec.Reject("USAGE");
                return 0;
            }
            catch (Exception error)
            {
                var code = error is InvalidOperationException && System.Text.RegularExpressions.Regex.IsMatch(error.Message, @"\AWINDOWS_WITNESS_[A-Z0-9_]+\z")
                    ? error.Message : "WINDOWS_WITNESS_FAILED";
                Console.Error.WriteLine(code); return 1;
            }
        }
    }
}
