// Reaper registry/API owner: Builder A win-sac-sign-sa; case-runner consumer owner: Builder B win-sac-sign-sb; deployment owner: MAIN.
using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Text.Json;

namespace Murage.Witness
{
    public abstract class BoundReaper : IResourceReaper
    {
        protected readonly string RunNonce;
        public readonly HashSet<RunResource> Retained = new HashSet<RunResource>();
        protected BoundReaper(string runNonce)
        {
            if (!WitnessCodec.Hex(runNonce, 64)) throw WitnessCodec.Reject("REAPER_RUN_BINDING");
            RunNonce = runNonce;
        }
        protected JsonDocument Binding(RunResource resource, string type, params string[] fields)
        {
            resource.Validate();
            if (resource.Type != type) throw WitnessCodec.Reject("RESOURCE");
            var doc = WitnessCodec.Parse(Encoding.UTF8.GetBytes(resource.Incarnation), 4096);
            try
            {
                var names = new string[fields.Length + 1]; names[0] = "runNonce"; Array.Copy(fields, 0, names, 1, fields.Length);
                WitnessCodec.Fields(doc.RootElement, names);
                if (WitnessCodec.Text(doc.RootElement, "runNonce") != RunNonce) throw WitnessCodec.Reject("REAPER_RUN_BINDING");
                return doc;
            }
            catch { doc.Dispose(); throw; }
        }
        protected bool Foreign(RunResource resource) { Retained.Add(resource); return true; }
        public abstract bool Absent(RunResource resource);
        public abstract void Destroy(RunResource resource);
    }
    public sealed class ReaperRegistry : IResourceReaper
    {
        private readonly Dictionary<string, IResourceReaper> reapers = new Dictionary<string, IResourceReaper>(StringComparer.Ordinal);
        public ReaperRegistry Add(string type, IResourceReaper reaper)
        {
            new RunResource(type, "validation", "validation").Validate();
            if (reaper == null || !reapers.TryAdd(type, reaper)) throw WitnessCodec.Reject("REAPER_REGISTRY");
            return this;
        }
        public IReadOnlyList<RunResource> Retained => reapers.Values.OfType<BoundReaper>().SelectMany(r => r.Retained)
            .Concat(reapers.Values.OfType<ProcessReaper>().SelectMany(r => r.Retained)).Distinct().ToArray();
        public IResourceReaper For(string type) => reapers.TryGetValue(type, out var reaper) ? reaper : throw WitnessCodec.Reject("REAPER_MISSING");
        public bool Absent(RunResource resource) => For(resource.Type).Absent(resource);
        public void Destroy(RunResource resource) => For(resource.Type).Destroy(resource);
    }
}
