// Case orchestration producer owner: Builder B; privileged operations/observer implementation owner: MAIN; journal/reaper implementation owner: Builder A.
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text.Json;
using System.Threading;

namespace Murage.Witness
{
    public sealed record CaseStep(string Name, ObservationVerb Verb, bool Exclusive = false, bool Fault = false);
    public sealed record BoundObservation(OperationBinding Binding, JsonElement Values);
    public interface ICaseOperations
    {
        void ArmSupervisor(OperationBinding binding, CancellationToken cancellation);
        void Begin(OperationBinding binding, CancellationToken cancellation);
        IReadOnlyList<RunResource> Reserve(CaseStep step, OperationBinding binding, CancellationToken cancellation);
        void AssertExclusive(CaseStep step, OperationBinding binding, IReadOnlyList<RunResource> resources, CancellationToken cancellation);
        void Act(CaseStep step, OperationBinding binding, CancellationToken cancellation);
        BoundObservation Observe(CaseStep step, OperationBinding binding, CancellationToken cancellation);
        void Restore(CaseStep step, OperationBinding binding, CancellationToken cancellation);
        BoundObservation Complete(OperationBinding binding, CancellationToken cancellation);
        Stream Capture(string kind, OperationBinding binding, CancellationToken cancellation);
        void Finalize(OperationBinding binding);
        void AssertEnrolledInputsUnchanged();
    }
    public static class CaseRunner
    {
        public static void RunAssets(AssetsRequest request, IAssetsMeasurements measurements, OperationBinding binding, IEvidenceAuthenticator authenticator,
            byte[] proof, Action<string, byte[]> writeExclusive) => AssetsCollector.Collect(request, measurements, binding, authenticator, proof, writeExclusive);
        public static IReadOnlyList<CaseStep> Steps(string id)
        {
            CaseStep S(string name, ObservationVerb verb = ObservationVerb.ProcessTree, bool exclusive = false, bool fault = false) => new CaseStep(name, verb, exclusive, fault);
            var crash = new[] { "crash-receipt-write", "crash-assignment", "crash-pipe-disconnect", "crash-bootstrap-death", "crash-driver-death", "crash-service-death", "crash-controller-death" };
            if (crash.Contains(id)) return new[] { S("exclusive-lease", ObservationVerb.ServiceState, true), S(id, ObservationVerb.ProcessTree, true, true), S("independent-revocation", ObservationVerb.JobMembers), S("service-restoration", ObservationVerb.ServiceState) };
            return id switch {
                "preflight" => new[] { S("host-and-enrollment", ObservationVerb.CiEvents), S("caller-token", ObservationVerb.TokenOf) },
                "presecret-both-workflows" => new[] { "package", "release", "provider-child" }.SelectMany(workflow => new[] { "fake-node-path", "fake-pwsh-path", "github-path", "all-users-all-hosts-profile", "all-users-current-host-profile", "current-user-all-hosts-profile", "current-user-current-host-profile", "node-options", "tampered-binary", "tampered-tree" }.Select(variant => S(workflow + ":" + variant))).ToArray(),
                "acquisition" => new[] { "dispatch-graph", "azure-manager-lazy", "stock-signer", "download", "install", "cold-caches", "missing-staged-dependency", "corrupt-staged-dependency", "publisher-lazy-query", "copy", "resources", "app", "addons", "helpers", "gepa", "nsis", "zip" }.Select(name => S(name)).ToArray(),
                "service-admission" => new[] { "wrong-sid", "filtered-administrator", "elevated", "foreign-session", "forged-authorization", "replayed-authorization", "expired-authorization", "second-seal", "second-release" }.Select(name => S(name, ObservationVerb.ServiceState, true)).ToArray(),
                "sealed-tree-races" => new[] { "changed-file", "extra-file", "missing-file", "junction-ancestor", "junction-leaf", "symlink-ancestor", "symlink-leaf", "hardlink", "alternate-stream", "post-measurement-replacement" }.Select(name => S(name)).ToArray(),
                "native-launch-network" => new[] { "suspended-create", "assign-before-resume", "standard-token", "explicit-environment", "dll-search", "tcp", "udp", "dns", "package-feed", "loopback-relay", "approved-signing-trust", "kill-on-close" }.Select(name => S(name, name is "tcp" or "udp" or "dns" or "package-feed" or "loopback-relay" or "approved-signing-trust" ? ObservationVerb.WfpFilters : ObservationVerb.ProcessTree, true)).ToArray(),
                "locked-build" => new[] { "register-separate-output", "frozen-input-rebuild", "gepa-before-asar", "age-before-transport", "resources-before-app-sign", "nsis-helper-before-embedding", "uninstaller-before-embedding", "exact-zip", "complete-graph", "compare-enrolled-inputs" }.Select(name => S(name)).ToArray(),
                "authenticode" => new[] { "all-mz-images", "native-winverifytrust", "signtool-pa-all-v-tw", "leaf-der-sha256", "chain-publisher-eku-timestamp", "vendor-byte-preservation", "signed-payload-preservation" }.Select(name => S(name)).ToArray(),
                "installed-coverage" => new[] { "exact-per-user-install-no-launch", "retained-uninstaller", "all-installed-mz-images", "nsis-transients", "helper-and-gepa-loads", "backup-round-trip", "runtime-compiled-pins", "zip-asar" }.Select(name => S(name)).ToArray(),
                "extraction-contract" => new[] { "deployed-two-key-oidc", "changed-installer", "changed-archive", "wrong-nonce", "wrong-build-identity", "wrong-publication-identity", "key-confusion", "replay", "parallel-replay", "expired", "guest-egress", "guest-control-plane" }.Select(name => S(name, ObservationVerb.ProcessTree, true)).ToArray(),
                "vm-cleanup" => new[] { "success", "failed-install", "collection-error", "timeout", "cancellation", "controller-death" }.Select(name => S(name, ObservationVerb.ProcessTree, true, name != "success")).ToArray(),
                "sac-real-turn-s4" => new[] { S("continuous-sac-before-install", ObservationVerb.CiEvents), S("standard-role-tokens", ObservationVerb.TokenOf), S("exact-isolated-install"), S("real-engine-turn"), S("installed-addon-load"), S("fresh-success-native-call", ObservationVerb.TokenOf), S("fresh-own-token-failure", ObservationVerb.TokenOf, true, true), S("sac-through-s4-teardown", ObservationVerb.CiEvents) },
                "promotion-both-entries" => new[] { "stage", "publish-prepared", "direct", "retry", "resume" }.SelectMany(entry => new[] { "valid-exact-bytes", "absent-evidence", "malformed-evidence", "stale-evidence", "untrusted-evidence", "sac-evaluation", "sac-off", "sac-unknown", "admin", "filtered-admin", "elevated", "changed-installer", "changed-pe", "changed-non-exe-asset", "missing-path", "extra-path", "transient-mismatch", "uninstaller-mismatch", "lookup-race", "extraction-race", "build-publication-identity" }.Select(variant => S(entry + ":" + variant, ObservationVerb.ProcessTree, true))).ToArray(),
                "cleanup" => new[] { S("revoke-leases-capabilities", ObservationVerb.JobMembers), S("exact-owned-processes"), S("disposable-install-data-files-tasks"), S("independent-cloud-cleanup"), S("restore-service", ObservationVerb.ServiceState), S("compare-authority-identity-policy", ObservationVerb.CiEvents) },
                _ => throw WitnessCodec.Reject("CASE_UNKNOWN")
            };
        }
        public static void Run(byte[] requestBytes, JsonElement enrollment, JsonElement plan, string caseId, string journalPath,
            ICaseOperations operations, ReaperRegistry reapers, ICollectionOutput output)
        {
            using var request = WitnessCodec.Parse(requestBytes, 8 * 1024 * 1024);
            WitnessCodec.Request(request.RootElement, enrollment, caseId, plan);
            SeamStatus.Require(caseId, SeamStatus.Adapters(enrollment));
            using var journal = ResourceJournal.Open(journalPath, WitnessCodec.Text(request.RootElement, "runNonce"));
            Run(requestBytes, enrollment, plan, caseId, journal, operations, reapers, output);
        }
        public static void Run(byte[] requestBytes, JsonElement enrollment, JsonElement plan, string caseId, ResourceJournal journal,
            ICaseOperations operations, ReaperRegistry reapers, ICollectionOutput output)
        {
            using var requestDoc = WitnessCodec.Parse(requestBytes, 8 * 1024 * 1024); var request = requestDoc.RootElement;
            WitnessCodec.Request(request, enrollment, caseId, plan);
            SeamStatus.Require(caseId, SeamStatus.Adapters(enrollment));
            var spec = plan.GetProperty("cases").EnumerateArray().Single(row => WitnessCodec.Text(row, "id") == caseId);
            var binding = new OperationBinding(WitnessCodec.Text(request, "runNonce"), WitnessCodec.Text(request, "nonce"), caseId, HeldFile.Hash(requestBytes), Fresh());
            using var budget = new CancellationTokenSource(WitnessCodec.CaseMilliseconds); var cancellation = budget.Token;

            operations.ArmSupervisor(binding, cancellation); cancellation.ThrowIfCancellationRequested();
            operations.Begin(binding, cancellation);
            var absent = new List<AbsentResource>();
            var operationBindings = new List<OperationBinding>();
            foreach (var step in Steps(caseId))
            {
                cancellation.ThrowIfCancellationRequested();
                var operation = binding with { OperationId = Fresh() }; operationBindings.Add(operation);
                if (caseId == "locked-build") operations.AssertEnrolledInputsUnchanged();
                var resources = operations.Reserve(step, operation, cancellation).ToArray();
                foreach (var resource in resources) { reapers.For(resource.Type); journal.Register(resource, operation); }
                try
                {
                    if (step.Exclusive || step.Fault) operations.AssertExclusive(step, operation, resources, cancellation);
                    operations.Act(step, operation, cancellation);
                    var observation = operations.Observe(step, operation, cancellation);
                    if (observation.Binding != operation || observation.Values.ValueKind != JsonValueKind.Object) throw WitnessCodec.Reject("OBSERVATION_BINDING");
                }
                finally { operations.Restore(step, operation, cancellation); }
                if (caseId == "locked-build") operations.AssertEnrolledInputsUnchanged();
                cancellation.ThrowIfCancellationRequested();
                if (!ResourceRecovery.ConfirmAbsent(resources, reapers)) throw WitnessCodec.Reject("CLEANUP_INCOMPLETE");
                foreach (var resource in resources) { journal.ConfirmDestroyed(resource, operation); absent.Add(new AbsentResource(resource, DateTimeOffset.UtcNow)); }
            }
            var measured = operations.Complete(binding, cancellation);
            if (measured.Binding != binding) throw WitnessCodec.Reject("OBSERVATION_BINDING");
            var expected = spec.GetProperty("expect");
            WitnessCodec.Fields(measured.Values, expected.EnumerateObject().Select(field => field.Name).ToArray());
            if (!WitnessCodec.Equal(measured.Values, expected)) throw WitnessCodec.Reject("OBSERVATION_MISMATCH");
            var captures = new List<CaseCapture>();
            foreach (var category in spec.GetProperty("captures").EnumerateArray())
            {
                cancellation.ThrowIfCancellationRequested(); string kind = category.GetString();
                using var stream = operations.Capture(kind, binding, cancellation); var capture = output.Capture(kind, stream);
                if (capture.Kind != kind || !WitnessCodec.Hex(capture.Sha256, 64) || capture.Size <= 0 || capture.Size > WitnessCodec.CaptureLimit) throw WitnessCodec.Reject("CAPTURE_BINDING");
                captures.Add(capture);
            }
            if (captures.Select(capture => capture.File).Distinct(StringComparer.OrdinalIgnoreCase).Count() != captures.Count) throw WitnessCodec.Reject("CAPTURE_BINDING");
            cancellation.ThrowIfCancellationRequested();
            if (!ResourceRecovery.ConfirmAbsent(absent.Select(entry => entry.Resource), reapers)) throw WitnessCodec.Reject("CLEANUP_INCOMPLETE");
            foreach (var operation in operationBindings) operations.Finalize(operation);
            operations.Finalize(binding);
            if (caseId == "cleanup") journal.FinalizeRun(binding); else journal.Finalize(binding);
            var result = ResultWriter.Create(request, measured.Values, captures, absent);
            var manifest = EvidenceManifest.Create(binding, captures.Select(capture => new EvidenceFile(capture.File, capture.Sha256, capture.Size)).Append(new EvidenceFile("result.json", HeldFile.Hash(result), result.Length)));
            cancellation.ThrowIfCancellationRequested(); output.Publish(result, manifest);
        }
        private static string Fresh() => Convert.ToHexString(RandomNumberGenerator.GetBytes(16)).ToLowerInvariant();
    }
}
