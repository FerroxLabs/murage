// Network implementation owner: win-sac-sign; reviewed endpoint enrollment and Windows packet witness owner: MAIN.
using System;
using System.Collections.Generic;
using System.Linq;
using System.Net;
using System.Runtime.InteropServices;

namespace Murage.Signing
{
    public sealed class SigningEndpoint
    {
        public string Executable { get; }
        public string Address { get; }
        public ushort Port { get; }
        public SigningEndpoint(string executable, string address, ushort port)
        {
            if (!new[] { SigningProcessSpec.Root + @"\pwsh\pwsh.exe", SigningProcessSpec.Signtool }.Contains(executable)
                || !IPAddress.TryParse(address, out var ip) || ip.ToString() != address || IPAddress.IsLoopback(ip)
                || ip.Equals(IPAddress.Any) || ip.Equals(IPAddress.IPv6Any) || ip.IsIPv4MappedToIPv6
                || ip.ScopeIdOrZero() != 0 || port == 0) throw new InvalidOperationException("WINDOWS_SIGNING_NETWORK_REJECTED");
            Executable = executable; Address = address; Port = port;
        }
    }
    internal static class SigningAddress
    {
        internal static long ScopeIdOrZero(this IPAddress address)
        { return address.AddressFamily == System.Net.Sockets.AddressFamily.InterNetworkV6 ? address.ScopeId : 0; }
    }
    public interface ISigningNetworkApi
    {
        void Begin(string sid);
        void Block(bool ipv6);
        void Allow(SigningEndpoint endpoint);
        void Commit();
        void Abort();
    }
    public static class SigningNetworkPolicy
    {
        // Persistent filters survive broker failure. Only disposal of this one-use VM removes policy.
        public static void Install(ISigningNetworkApi api, string sid, IReadOnlyList<SigningEndpoint> endpoints)
        {
            if (api == null || !System.Text.RegularExpressions.Regex.IsMatch(sid ?? "", @"\AS-1-5-21-\d+-\d+-\d+-\d+\z")
                || endpoints == null || endpoints.Count == 0 || endpoints.Count > 256 || endpoints.Any(row => row == null)
                || endpoints.Select(row => row.Executable + "|" + row.Address + "|" + row.Port).Distinct().Count() != endpoints.Count)
                throw new InvalidOperationException("WINDOWS_SIGNING_NETWORK_REJECTED");
            try
            {
                api.Begin(sid);
                api.Block(false); api.Block(true);
                foreach (var endpoint in endpoints) api.Allow(endpoint);
                api.Commit();
            }
            catch
            {
                try { api.Abort(); } catch { }
                throw new InvalidOperationException("WINDOWS_SIGNING_NETWORK_REJECTED");
            }
        }
    }
    public sealed class WindowsSigningNetworkApi : ISigningNetworkApi, IDisposable
    {
        private IntPtr handle;
        [DllImport("MurageSigningWfp.dll", CharSet=CharSet.Unicode, ExactSpelling=true)] private static extern uint SigningWfpBegin(string sid, out IntPtr engine);
        [DllImport("MurageSigningWfp.dll", ExactSpelling=true)] private static extern uint SigningWfpBlock(IntPtr engine, int ipv6);
        [DllImport("MurageSigningWfp.dll", CharSet=CharSet.Unicode, ExactSpelling=true)] private static extern uint SigningWfpAllow(IntPtr engine, string executable, string address, ushort port);
        [DllImport("MurageSigningWfp.dll", ExactSpelling=true)] private static extern uint SigningWfpCommit(IntPtr engine);
        [DllImport("MurageSigningWfp.dll", ExactSpelling=true)] private static extern void SigningWfpClose(IntPtr engine);
        private static void Check(uint result) { if (result != 0) throw new InvalidOperationException("WINDOWS_SIGNING_NETWORK_REJECTED"); }
        public void Begin(string sid)
        {
            if (handle != IntPtr.Zero || !RuntimeInformation.IsOSPlatform(OSPlatform.Windows)) throw new InvalidOperationException("WINDOWS_SIGNING_NETWORK_REJECTED");
            Check(SigningWfpBegin(sid, out handle));
        }
        public void Block(bool ipv6) { Check(SigningWfpBlock(handle, ipv6 ? 1 : 0)); }
        public void Allow(SigningEndpoint endpoint) { Check(SigningWfpAllow(handle, endpoint.Executable, endpoint.Address, endpoint.Port)); }
        public void Commit() { Check(SigningWfpCommit(handle)); }
        public void Abort() { Dispose(); }
        public void Dispose() { if (handle != IntPtr.Zero) { SigningWfpClose(handle); handle = IntPtr.Zero; } }
    }
}
