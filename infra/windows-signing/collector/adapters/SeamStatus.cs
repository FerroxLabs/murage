// Adapter producer owner: Builder B; protected acceptance records consumer/author owner: MAIN.
using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;

namespace Murage.Witness
{
    public sealed record Seam(string Name, string Ruling)
    {
        public string Code => Name switch
        {
            "observationAuth" => "WINDOWS_WITNESS_OBSERVATION_AUTH_UNENROLLED",
            "sacAdapter" => "WINDOWS_WITNESS_SAC_ADAPTER_UNACCEPTED_R_COL_8",
            "s4Mechanism" => "WINDOWS_WITNESS_S4_MECHANISM_UNACCEPTED_R_COL_9",
            "signingPath" => "WINDOWS_WITNESS_SIGNING_PATH_UNENROLLED_" + Ruling,
            "cloudReaper" => "WINDOWS_WITNESS_CLOUD_REAPER_UNENROLLED_R_COL_11",
            "promotionTarget" => "WINDOWS_WITNESS_PROMOTION_TARGET_UNENROLLED_R_COL_13",
            _ => "WINDOWS_WITNESS_" + Ruling
        };
    }
    public static class SeamStatus
    {
        public static readonly string[] Names = { "observationAuth", "sacAdapter", "s4Mechanism", "signingPath", "cloudReaper", "promotionTarget" };
        public static readonly string[] Cases = {
            "preflight", "presecret-both-workflows", "acquisition", "service-admission", "sealed-tree-races", "native-launch-network", "locked-build",
            "crash-receipt-write", "crash-assignment", "crash-pipe-disconnect", "crash-bootstrap-death", "crash-driver-death", "crash-service-death",
            "crash-controller-death", "authenticode", "installed-coverage", "extraction-contract", "vm-cleanup", "sac-real-turn-s4", "promotion-both-entries", "cleanup" };
        public static IReadOnlyList<Seam> Required(string id)
        {
            if (!Cases.Contains(id, StringComparer.Ordinal)) throw WitnessCodec.Reject("CASE_UNKNOWN");
            var seams = new List<Seam>();
            void Add(string name, string ruling) => seams.Add(new Seam(name, ruling));
            if (id == "preflight" || id == "sac-real-turn-s4") Add("sacAdapter", "R_COL_8");
            if (id == "sac-real-turn-s4") Add("s4Mechanism", "R_COL_9");
            if (new[] { "preflight", "presecret-both-workflows", "acquisition", "service-admission", "sealed-tree-races", "native-launch-network", "locked-build",
                "crash-receipt-write", "crash-assignment", "crash-pipe-disconnect", "crash-bootstrap-death", "crash-driver-death", "authenticode", "installed-coverage", "cleanup" }.Contains(id)) Add("signingPath", id == "authenticode" ? "R_COL_2" : id == "presecret-both-workflows" || id == "acquisition" ? "R_COL_1_2" : "R_COL_1");
            if (new[] { "crash-controller-death", "extraction-contract", "vm-cleanup", "cleanup" }.Contains(id)) Add("cloudReaper", "R_COL_11");
            if (id == "promotion-both-entries") Add("promotionTarget", "R_COL_13");
            Add("observationAuth", "R_COL_6");
            return seams;
        }
        public static JsonElement Adapters(JsonElement enrollment)
        {
            if (enrollment.TryGetProperty("adapters", out var adapters)) return adapters;
            // Legacy frozen enrollments carry no acceptance, so they remain fail-closed.
            using var doc = JsonDocument.Parse("{" + String.Join(",", Names.Select(name => "\"" + name + "\":\"unaccepted\"")) + "}");
            return doc.RootElement.Clone();
        }
        public static void Validate(JsonElement adapters)
        {
            WitnessCodec.Fields(adapters, Names);
            foreach (string name in Names)
            {
                var value = adapters.GetProperty(name);
                if (value.ValueKind == JsonValueKind.String && value.GetString() == "unaccepted") continue;
                WitnessCodec.Fields(value, "accepted", "sha256");
                if (!System.Text.RegularExpressions.Regex.IsMatch(WitnessCodec.Text(value, "accepted"), @"\A[A-Z0-9][A-Z0-9()._-]{0,100}\z")
                    || !WitnessCodec.Hex(WitnessCodec.Text(value, "sha256"), 64)) throw WitnessCodec.Reject("ADAPTER_ACCEPTANCE");
            }
        }
        public static void Require(string id, JsonElement adapters)
        {
            Validate(adapters);
            foreach (var seam in Required(id))
                if (adapters.GetProperty(seam.Name).ValueKind == JsonValueKind.String) throw new InvalidOperationException(seam.Code);
        }
    }
}
