// SAC evaluator/reader producer owner: Builder B; OS-build acceptance and enrolled policy consumer owner: MAIN/GrokBuild.
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Xml;
using System.Xml.Linq;

namespace Murage.Witness
{
    public sealed record SacPolicy(string Id, string Sha256, bool Enforced);
    public sealed record SacSnapshot(int Build, int Ubr, int State, string Boot, IReadOnlyList<SacPolicy> Policies, long Capacity, bool Retention);
    public sealed record CiEvent(long RecordId, int Id, DateTimeOffset Time, string PolicyId, string ImageSha256);
    public sealed record SacInterval(SacSnapshot Before, SacSnapshot After, long Bookmark, long LastRecord, DateTimeOffset Start, DateTimeOffset End,
        IReadOnlyList<CiEvent> Events, bool SubscriptionStartedBeforeInstall, bool ObserverAlive, bool LostRecords, bool RolloverRisk);
    public static class SacAdapter
    {
        public static CiEvent ParseEvent(string xml)
        {
            using var reader = XmlReader.Create(new StringReader(xml), new XmlReaderSettings { DtdProcessing = DtdProcessing.Prohibit, XmlResolver = null, MaxCharactersInDocument = 1024 * 1024 });
            var doc = XDocument.Load(reader); XNamespace ns = "http://schemas.microsoft.com/win/2004/08/events/event";
            var system = doc.Root.Element(ns + "System");
            if ((string)system.Element(ns + "Provider")?.Attribute("Name") != "Microsoft-Windows-CodeIntegrity") throw WitnessCodec.Reject("SAC_EVENT_PROVIDER");
            var data = doc.Root.Element(ns + "EventData")?.Elements(ns + "Data").ToDictionary(row => (string)row.Attribute("Name"), row => row.Value, StringComparer.Ordinal)
                ?? new Dictionary<string, string>();
            return new CiEvent(long.Parse(system.Element(ns + "EventRecordID").Value, CultureInfo.InvariantCulture), int.Parse(system.Element(ns + "EventID").Value, CultureInfo.InvariantCulture),
                DateTimeOffset.Parse((string)system.Element(ns + "TimeCreated").Attribute("SystemTime"), CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal),
                data.GetValueOrDefault("PolicyID", ""), data.GetValueOrDefault("SHA256Hash", ""));
        }
        public static void Evaluate(SacInterval interval, int acceptedBuild, int acceptedUbr, string policyId, string policySha256, IReadOnlyCollection<string> peHashes)
        {
            if (!WitnessCodec.Hex(policySha256, 64) || peHashes.Count == 0 || peHashes.Any(hash => !WitnessCodec.Hex(hash, 64))) throw WitnessCodec.Reject("SAC_POLICY");
            foreach (var snapshot in new[] { interval.Before, interval.After })
            {
                if (snapshot.Build != acceptedBuild || snapshot.Ubr != acceptedUbr || snapshot.Build < 22000 || snapshot.State != 1
                    || snapshot.Capacity <= 0 || !snapshot.Retention || snapshot.Policies.Count == 0
                    || snapshot.Policies.Select(policy => policy.Id).Distinct(StringComparer.OrdinalIgnoreCase).Count() != snapshot.Policies.Count
                    || !snapshot.Policies.Any(policy => policy.Id == policyId && policy.Sha256 == policySha256 && policy.Enforced)) throw WitnessCodec.Reject("SAC_NOT_ENFORCING");
            }
            if (String.IsNullOrEmpty(interval.Before.Boot) || interval.Before.Boot != interval.After.Boot
                || !interval.Before.Policies.OrderBy(policy => policy.Id, StringComparer.Ordinal).SequenceEqual(interval.After.Policies.OrderBy(policy => policy.Id, StringComparer.Ordinal))
                || interval.Before.Capacity != interval.After.Capacity || interval.Start >= interval.End
                || !interval.SubscriptionStartedBeforeInstall || !interval.ObserverAlive || interval.LostRecords || interval.RolloverRisk
                || interval.Bookmark < 0 || interval.LastRecord < interval.Bookmark) throw WitnessCodec.Reject("SAC_INTERVAL");
            long expected = interval.Bookmark; DateTimeOffset time = interval.Start;
            foreach (var record in interval.Events)
            {
                if (record.RecordId != ++expected || record.Time < time || record.Time > interval.End) throw WitnessCodec.Reject("SAC_EVENT_GAP");
                time = record.Time;
                if (!new[] { 3033, 3034, 3076, 3077, 3089, 3099 }.Contains(record.Id)) throw WitnessCodec.Reject("SAC_EVENT_UNCLASSIFIED");
                // An activation during the interval is a policy change even if the final snapshot matches.
                if (record.Id == 3099 || new[] { 3033, 3034, 3076, 3077 }.Contains(record.Id)
                    && (record.PolicyId == policyId || peHashes.Contains(record.ImageSha256))) throw WitnessCodec.Reject("SAC_POLICY_EVENT");
                if (new[] { 3033, 3034, 3076, 3077, 3089, 3099 }.Contains(record.Id) && String.IsNullOrEmpty(record.PolicyId) && String.IsNullOrEmpty(record.ImageSha256)) throw WitnessCodec.Reject("SAC_EVENT_AMBIGUOUS");
            }
            if (expected != interval.LastRecord) throw WitnessCodec.Reject("SAC_EVENT_GAP");
        }
        public static SacSnapshot Snapshot(ObservationChannel channel, OperationBinding binding, string enrolledCiToolSha256, CancellationToken cancellation)
        {
            using var target = JsonDocument.Parse("{}");
            var build = channel.Observe(binding, ObservationVerb.CiBuild, target.RootElement, cancellation);
            var state = channel.Observe(binding, ObservationVerb.CiPolicyState, target.RootElement, cancellation);
            var policies = channel.Observe(binding, ObservationVerb.CiPolicies, target.RootElement, cancellation);
            WitnessCodec.Fields(build, "build", "ubr", "boot"); WitnessCodec.Fields(state, "kind", "state");
            WitnessCodec.Fields(policies, "toolSha256", "argv", "policies", "capacity", "retention");
            if (WitnessCodec.Text(state, "kind") != "DWord" || !WitnessCodec.Hex(enrolledCiToolSha256, 64)
                || WitnessCodec.Text(policies, "toolSha256") != enrolledCiToolSha256
                || !policies.GetProperty("argv").EnumerateArray().Select(value => value.GetString()).SequenceEqual(new[] { "--list-policies", "--json" })) throw WitnessCodec.Reject("SAC_OBSERVER_CONTRACT");
            var rows = policies.GetProperty("policies").EnumerateArray().Select(row => {
                WitnessCodec.Fields(row, "id", "sha256", "enforced");
                if (!WitnessCodec.Hex(WitnessCodec.Text(row, "sha256"), 64)) throw WitnessCodec.Reject("SAC_POLICY");
                return new SacPolicy(WitnessCodec.Text(row, "id"), WitnessCodec.Text(row, "sha256"), row.GetProperty("enforced").GetBoolean());
            }).ToArray();
            return new SacSnapshot(build.GetProperty("build").GetInt32(), build.GetProperty("ubr").GetInt32(), state.GetProperty("state").GetInt32(), WitnessCodec.Text(build, "boot"), rows,
                policies.GetProperty("capacity").GetInt64(), policies.GetProperty("retention").GetBoolean());
        }
        public static SacInterval Interval(ObservationChannel channel, OperationBinding binding, SacSnapshot before, SacSnapshot after, JsonElement logTarget, CancellationToken cancellation)
        {
            var log = channel.Observe(binding, ObservationVerb.CiLog, logTarget, cancellation);
            WitnessCodec.Fields(log, "bookmark", "lastRecord", "start", "end", "events", "subscriptionStartedBeforeInstall", "observerAlive", "lostRecords", "rolloverRisk");
            return new SacInterval(before, after, log.GetProperty("bookmark").GetInt64(), log.GetProperty("lastRecord").GetInt64(),
                log.GetProperty("start").GetDateTimeOffset(), log.GetProperty("end").GetDateTimeOffset(), log.GetProperty("events").EnumerateArray().Select(row => ParseEvent(row.GetString())).ToArray(),
                log.GetProperty("subscriptionStartedBeforeInstall").GetBoolean(), log.GetProperty("observerAlive").GetBoolean(), log.GetProperty("lostRecords").GetBoolean(), log.GetProperty("rolloverRisk").GetBoolean());
        }
    }
}
