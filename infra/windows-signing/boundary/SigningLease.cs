// Lease implementation owner: win-sac-sign; Windows token/ACL/WFP host and controller admission owner: MAIN.
using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;

namespace Murage.Signing
{
    // The host owns native handles and authenticates pipe callers. A message body is never a peer identity.
    public interface ISealedSigningHost : IDisposable
    {
        void AssertPeer(long processId, long creationTime);
        Task<string> SealAsync(string launchDigest, string authorizationDigest, CancellationToken cancellation);
        void RevalidateHeldHandles();
        Task<SigningCompletion> CreateSigningProcessAsync(IReadOnlyDictionary<string, string> credentials, CancellationToken cancellation);
        void TerminateJob();
    }

    public sealed class SigningCompletion
    {
        public int ExitCode { get; }
        public string ReceiptSha256 { get; }
        public SigningCompletion(int exitCode, string receiptSha256) { ExitCode = exitCode; ReceiptSha256 = receiptSha256; }
    }

    public sealed class SigningLease : IDisposable
    {
        private enum Phase { New, Sealing, Sealed, Used, Complete, Revoked }
        private readonly object gate = new object();
        private readonly ISealedSigningHost host;
        private readonly Dictionary<string, string> credentials;
        private readonly CancellationTokenSource lifetime;
        private readonly string launchDigest, authorizationDigest;
        private readonly long processId, creationTime;
        private string measurement;
        private Phase phase;
        private bool disposed;

        public SigningLease(ISealedSigningHost host, IDictionary<string, string> credentials,
            string launchDigest, string authorizationDigest, long processId, long creationTime, TimeSpan ttl)
        {
            if (host == null || !Digest(launchDigest) || !Digest(authorizationDigest) || processId <= 0 || creationTime <= 0
                || ttl <= TimeSpan.Zero || ttl > TimeSpan.FromMinutes(30)
                || credentials == null || credentials.Count != 3 || new[] { "AZURE_TENANT_ID", "AZURE_CLIENT_ID", "AZURE_CLIENT_SECRET" }
                    .Any(key => !credentials.ContainsKey(key) || String.IsNullOrEmpty(credentials[key]))) throw Reject();
            this.host = host; this.credentials = new Dictionary<string, string>(credentials);
            this.launchDigest = launchDigest; this.authorizationDigest = authorizationDigest;
            this.processId = processId; this.creationTime = creationTime;
            lifetime = new CancellationTokenSource();
            lifetime.Token.Register(Revoke);
            lifetime.CancelAfter(ttl);
        }
        private static bool Digest(string value) { return value != null && value.Length == 64 && value.All(c => c >= '0' && c <= '9' || c >= 'a' && c <= 'f'); }
        private static Exception Reject() { return new InvalidOperationException("WINDOWS_SIGNING_BOUNDARY_REJECTED"); }
        private void Peer(long pid, long created)
        {
            if (pid != processId || created != creationTime || lifetime.IsCancellationRequested) throw Reject();
            host.AssertPeer(pid, created);
        }
        public async Task<string> SealAsync(long pid, long created, string launch, string authorization)
        {
            lock (gate)
            {
                Peer(pid, created);
                if (phase != Phase.New || launch != launchDigest || authorization != authorizationDigest) throw Reject();
                phase = Phase.Sealing;
            }
            try
            {
                string measured = await host.SealAsync(launch, authorization, lifetime.Token).ConfigureAwait(false);
                lock (gate)
                {
                    Peer(pid, created);
                    if (phase != Phase.Sealing || !Digest(measured)) throw Reject();
                    measurement = measured; phase = Phase.Sealed;
                    return measured;
                }
            }
            catch { Revoke(); throw Reject(); }
        }
        public async Task<SigningCompletion> ReleaseAsync(long pid, long created, string measured)
        {
            lock (gate)
            {
                Peer(pid, created);
                if (phase != Phase.Sealed || measured != measurement) throw Reject();
                // Consume before awaiting or creating a process: a reentrant request cannot win twice.
                phase = Phase.Used;
            }
            try
            {
                host.RevalidateHeldHandles();
                var result = await host.CreateSigningProcessAsync(credentials, lifetime.Token).ConfigureAwait(false);
                host.RevalidateHeldHandles();
                lock (gate)
                {
                    Peer(pid, created);
                    if (phase != Phase.Used || result == null || result.ExitCode != 0 || !Digest(result.ReceiptSha256)) throw Reject();
                    phase = Phase.Complete;
                    credentials.Clear();
                    return result;
                }
            }
            catch { Revoke(); throw Reject(); }
            finally { lock (gate) credentials.Clear(); }
        }
        public void Revoke()
        {
            lock (gate)
            {
                if (phase != Phase.Complete) phase = Phase.Revoked;
                credentials.Clear();
                host.TerminateJob();
            }
        }
        public void Dispose()
        {
            lock (gate)
            {
                if (disposed) return;
                disposed = true;
                Revoke(); lifetime.Dispose(); host.Dispose();
            }
        }
    }
}
