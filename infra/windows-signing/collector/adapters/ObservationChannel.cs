// Observation client producer owner: Builder B; protected SYSTEM observer service producer owner: MAIN.
using System;
using System.Buffers.Binary;
using System.Collections.Generic;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using System.Text.Json;
using System.Threading;
using Microsoft.Win32.SafeHandles;

namespace Murage.Witness
{
    public enum ObservationVerb { TokenOf, ProcessTree, CiEvents, ServiceState, WfpFilters, JobMembers, CiBuild, CiPolicyState, CiPolicies, CiLog }
    public interface IObservationPeer : IDisposable
    {
        Stream Stream { get; }
        long Authenticate();
    }
    public sealed class ObservationChannel : IDisposable
    {
        private readonly IObservationPeer peer;
        private readonly long creation;
        private long sequence;
        private readonly HashSet<OperationBinding> finalized = new HashSet<OperationBinding>();
        public ObservationChannel(IObservationPeer peer)
        {
            this.peer = peer;
            try { creation = peer.Authenticate(); if (creation <= 0) throw WitnessCodec.Reject("OBSERVER_PEER"); }
            catch { peer.Dispose(); throw; }
        }
        public static string Verb(ObservationVerb verb) => verb switch {
            ObservationVerb.TokenOf => "token-of", ObservationVerb.ProcessTree => "process-tree", ObservationVerb.CiEvents => "ci-events",
            ObservationVerb.CiBuild => "ci-build", ObservationVerb.CiPolicyState => "ci-policy-state", ObservationVerb.CiPolicies => "ci-policies", ObservationVerb.CiLog => "ci-log",
            ObservationVerb.ServiceState => "service-state", ObservationVerb.WfpFilters => "wfp-filters", ObservationVerb.JobMembers => "job-members",
            _ => throw WitnessCodec.Reject("OBSERVER_VERB") };
        public JsonElement Observe(OperationBinding binding, ObservationVerb verb, JsonElement target, CancellationToken cancellation)
        {
            if (finalized.Contains(binding)) throw WitnessCodec.Reject("OBSERVATION_FINALIZED");
            byte[] request = EvidenceManifest.Json(writer => {
                writer.WriteStartObject(); writer.WriteString("verb", Verb(verb)); EvidenceManifest.Binding(writer, binding);
                writer.WritePropertyName("target"); target.WriteTo(writer); writer.WriteEndObject();
            });
            var prefix = new byte[4]; BinaryPrimitives.WriteInt32LittleEndian(prefix, request.Length);
            peer.Stream.WriteAsync(prefix, cancellation).AsTask().GetAwaiter().GetResult();
            peer.Stream.WriteAsync(request, cancellation).AsTask().GetAwaiter().GetResult();
            peer.Stream.FlushAsync(cancellation).GetAwaiter().GetResult();
            peer.Stream.ReadExactlyAsync(prefix, cancellation).AsTask().GetAwaiter().GetResult();
            int size = BinaryPrimitives.ReadInt32LittleEndian(prefix);
            if (size <= 0 || size > WitnessCodec.CaptureLimit) throw WitnessCodec.Reject("OBSERVATION_SIZE");
            var bytes = new byte[size]; peer.Stream.ReadExactlyAsync(bytes, cancellation).AsTask().GetAwaiter().GetResult();
            GC.KeepAlive(peer.Stream);
            return Accept(bytes, binding);
        }
        internal JsonElement Accept(byte[] bytes, OperationBinding binding)
        {
            using var doc = WitnessCodec.Parse(bytes, WitnessCodec.CaptureLimit); var response = doc.RootElement;
            WitnessCodec.Fields(response, "binding", "sequence", "observerCreation", "measurement");
            long next = response.GetProperty("sequence").GetInt64();
            if (finalized.Contains(binding) || !EvidenceManifest.Matches(response.GetProperty("binding"), binding)
                || next != sequence + 1 || response.GetProperty("observerCreation").GetInt64() != creation) throw WitnessCodec.Reject("OBSERVATION_BINDING");
            sequence = next;
            return response.GetProperty("measurement").Clone();
        }
        public void Finalize(OperationBinding binding)
        {
            if (!finalized.Add(binding)) throw WitnessCodec.Reject("OBSERVATION_FINALIZED");
        }
        public void Dispose() => peer.Dispose();
    }
    public sealed class SystemObservationPeer : IObservationPeer
    {
        [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetNamedPipeServerProcessId(SafePipeHandle pipe, out uint pid);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern SafeProcessHandle OpenProcess(uint access, bool inherit, uint pid);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetProcessTimes(SafeProcessHandle process, out long creation, out long exit, out long kernel, out long user);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool QueryFullProcessImageName(SafeProcessHandle process, uint flags, StringBuilder name, ref uint size);
        [DllImport("advapi32.dll", SetLastError = true)] private static extern bool OpenProcessToken(SafeProcessHandle process, uint access, out SafeAccessTokenHandle token);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern uint WaitForSingleObject(SafeProcessHandle process, uint milliseconds);
        private readonly NamedPipeClientStream pipe;
        private readonly string path, digest;
        private SafeProcessHandle process;
        private HeldFile image;
        public Stream Stream
        {
            get
            {
                if (process == null || process.IsInvalid || WaitForSingleObject(process, 0) != 258) throw WitnessCodec.Reject("OBSERVER_PEER");
                return pipe;
            }
        }
        public SystemObservationPeer(string sealedImagePath, string sealedImageSha256, CancellationToken cancellation)
        {
            WitnessCodec.Absolute(sealedImagePath);
            if (!WitnessCodec.Hex(sealedImageSha256, 64)) throw WitnessCodec.Reject("OBSERVER_PIN");
            path = sealedImagePath; digest = sealedImageSha256;
            pipe = new NamedPipeClientStream(".", "MurageSigningBoundary", PipeDirection.InOut, PipeOptions.Asynchronous, TokenImpersonationLevel.Identification);
            try { pipe.ConnectAsync(cancellation).GetAwaiter().GetResult(); } catch { pipe.Dispose(); throw; }
        }
        public long Authenticate()
        {
            if (!GetNamedPipeServerProcessId(pipe.SafePipeHandle, out uint pid) || pid == 0) throw WitnessCodec.Reject("OBSERVER_PEER");
            process = OpenProcess(0x101000, false, pid);
            if (process.IsInvalid || WaitForSingleObject(process, 0) != 258
                || !GetProcessTimes(process, out long creation, out _, out _, out _) || creation <= 0
                || !OpenProcessToken(process, 8, out var token)) throw WitnessCodec.Reject("OBSERVER_PEER");
            using (token)
            using (var identity = new WindowsIdentity(token.DangerousGetHandle()))
                if (identity.User?.Value != "S-1-5-18") throw WitnessCodec.Reject("OBSERVER_PEER");
            var name = new StringBuilder(32768); uint size = (uint)name.Capacity;
            if (!QueryFullProcessImageName(process, 0, name, ref size) || !String.Equals(name.ToString(), path, StringComparison.OrdinalIgnoreCase)) throw WitnessCodec.Reject("OBSERVER_IMAGE");
            image = new HeldFile(path, WitnessCodec.CaptureLimit, digest);
            if (WaitForSingleObject(process, 0) != 258) throw WitnessCodec.Reject("OBSERVER_PEER");
            return creation;
        }
        public void Dispose() { image?.Dispose(); process?.Dispose(); pipe.Dispose(); }
    }
}
