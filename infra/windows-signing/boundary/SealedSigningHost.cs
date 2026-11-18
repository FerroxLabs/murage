// Host orchestration owner: win-sac-sign; authenticated admission, held-file measurements and service deployment owner: MAIN.
using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;

namespace Murage.Signing
{
    public interface ISigningAdmission : IDisposable
    {
        void AssertPeer(long pid, long creation);
        Task<string> SealAsync(string launch, string authorization, CancellationToken cancellation);
        void RevalidateHeldHandles();
        Task<string> VerifyCompleteReceiptAsync(CancellationToken cancellation);
    }
    public sealed class SealedSigningHost : ISealedSigningHost
    {
        private readonly ISigningAdmission admission;
        private readonly ISigningNetworkApi network;
        private readonly ISigningProcessApi processes;
        private readonly IntPtr token;
        private readonly string sid;
        private readonly IReadOnlyList<SigningEndpoint> endpoints;
        private readonly IReadOnlyDictionary<string,string> environment;
        private readonly CancellationTokenSource lifetime = new CancellationTokenSource();
        private bool sealedHost, launched, disposed;
        public SealedSigningHost(ISigningAdmission admission, ISigningNetworkApi network, ISigningProcessApi processes,
            IntPtr token, string sid, IReadOnlyList<SigningEndpoint> endpoints, IReadOnlyDictionary<string,string> environment)
        {
            if (admission == null || network == null || processes == null || token == IntPtr.Zero) throw Reject();
            // Validate and copy before any network or process side effect.
            this.environment = new SigningProcessSpec(true, environment).Environment;
            this.admission = admission; this.network = network; this.processes = processes; this.token = token; this.sid = sid;
            this.endpoints = endpoints == null ? null : new List<SigningEndpoint>(endpoints).AsReadOnly();
        }
        private static Exception Reject() { return new InvalidOperationException("WINDOWS_SIGNING_HOST_REJECTED"); }
        private void Alive() { if (disposed || lifetime.IsCancellationRequested) throw Reject(); }
        public void AssertPeer(long pid, long creation) { Alive(); admission.AssertPeer(pid, creation); }
        public async Task<string> SealAsync(string launch, string authorization, CancellationToken cancellation)
        {
            Alive(); if (sealedHost) throw Reject();
            using (var linked = CancellationTokenSource.CreateLinkedTokenSource(cancellation, lifetime.Token))
            {
                linked.Token.ThrowIfCancellationRequested();
                processes.AssertStandardToken(token);
                processes.AssertTokenSid(token, sid);
                SigningNetworkPolicy.Install(network, sid, endpoints);
                var measurement = await admission.SealAsync(launch, authorization, linked.Token).ConfigureAwait(false);
                admission.RevalidateHeldHandles();
                linked.Token.ThrowIfCancellationRequested();
                Alive(); sealedHost = true;
                return measurement;
            }
        }
        public void RevalidateHeldHandles() { Alive(); if (!sealedHost) throw Reject(); admission.RevalidateHeldHandles(); }
        public async Task<SigningCompletion> CreateSigningProcessAsync(IReadOnlyDictionary<string,string> credentials, CancellationToken cancellation)
        {
            Alive(); if (!sealedHost || launched) throw Reject();
            launched = true;
            using (var linked = CancellationTokenSource.CreateLinkedTokenSource(cancellation, lifetime.Token))
            {
                admission.RevalidateHeldHandles();
                var spec = new SigningProcessSpec(false, environment, credentials);
                int exit = await SigningProcess.RunAsync(processes, token, spec, linked.Token).ConfigureAwait(false);
                if (exit != 0) throw Reject();
                admission.RevalidateHeldHandles();
                var receipt = await admission.VerifyCompleteReceiptAsync(linked.Token).ConfigureAwait(false);
                linked.Token.ThrowIfCancellationRequested();
                Alive();
                return new SigningCompletion(exit, receipt);
            }
        }
        public void TerminateJob() { if (!disposed) lifetime.Cancel(); }
        public void Dispose()
        {
            if (disposed) return;
            TerminateJob(); disposed = true;
            try { admission.Dispose(); }
            finally { try { (network as IDisposable)?.Dispose(); } finally { lifetime.Dispose(); } }
        }
    }
}
