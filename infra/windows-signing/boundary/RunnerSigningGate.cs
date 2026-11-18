// Runner dispatch implementation owner: win-sac-sign; runner build, service pin and admission owner: MAIN.
using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Pipes;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Win32.SafeHandles;

namespace Murage.Signing
{
    public static class RunnerSigningGate
    {
        private static readonly string[] Keys = { "AZURE_TENANT_ID", "AZURE_CLIENT_ID", "AZURE_CLIENT_SECRET" };
        private const string Root = @"C:\Program Files\MurageSigning";
        private static Exception Reject() { return new InvalidOperationException("WINDOWS_SIGNING_RUNNER_REJECTED"); }
        public static bool HasCredentials(IDictionary<string,string> environment)
        {
            return environment != null && environment.Keys.Any(key => key.StartsWith("AZURE_", StringComparison.OrdinalIgnoreCase));
        }
        // Used by the final ProcessInvoker backstop, including non-script handlers.
        public static void AssertCredentialFree(IDictionary<string,string> environment)
        {
            if (environment == null || HasCredentials(environment)
                || System.Environment.GetEnvironmentVariables().Keys.Cast<string>().Any(key => key.StartsWith("AZURE_",StringComparison.OrdinalIgnoreCase))) throw Reject();
        }
        public static Task<int> DispatchAsync(IDictionary<string,string> environment, string shell, string script, CancellationToken cancellation)
        {
            return DispatchAsync(environment, shell, script, ExchangeAsync, cancellation);
        }
        public static async Task<int> DispatchAsync(IDictionary<string,string> environment, string shell, string script,
            Func<byte[],CancellationToken,Task<byte[]>> exchange, CancellationToken cancellation)
        {
            var credentials = new Dictionary<string,string>(StringComparer.Ordinal);
            byte[] request = null;
            try
            {
                if (environment == null) throw Reject();
                foreach (var key in environment.Keys.Where(key => key.StartsWith("AZURE_",StringComparison.OrdinalIgnoreCase)).ToArray())
                { credentials.Add(key, environment[key]); environment.Remove(key); }
                if (credentials.Count != 3 || Keys.Any(key => !credentials.TryGetValue(key,out var value) || String.IsNullOrEmpty(value) || value.Contains('\0'))
                    || shell != "\"" + Root + @"\pwsh\pwsh.exe" + "\" -NoProfile -NonInteractive -File {0}"
                    || script?.Replace("\r\n","\n") != "$ErrorActionPreference = 'Stop'\n& '" + Root + @"\node\node.exe" + "' --max-old-space-size=4300 '" + Root + @"\app\scripts\windows-signing-driver.mjs" + "'\nexit $LASTEXITCODE\n"
                    || exchange == null) throw Reject();
                cancellation.ThrowIfCancellationRequested();
                string id = Convert.ToHexString(RandomNumberGenerator.GetBytes(16)).ToLowerInvariant();
                request = JsonSerializer.SerializeToUtf8Bytes(new { id, operation = "launch", shell, script, credentials });
                if (request.Length > 65535) throw Reject();
                using (var message = JsonDocument.Parse(await exchange(request, cancellation).ConfigureAwait(false)))
                {
                    var value = message.RootElement;
                    if (value.ValueKind != JsonValueKind.Object || !value.EnumerateObject().Select(row => row.Name).OrderBy(name => name).SequenceEqual(new[] { "id", "ok", "result" })
                        || value.GetProperty("id").GetString() != id || value.GetProperty("ok").ValueKind != JsonValueKind.True) throw Reject();
                    var result = value.GetProperty("result");
                    if (result.ValueKind != JsonValueKind.Object || !result.EnumerateObject().Select(row => row.Name).OrderBy(name => name).SequenceEqual(new[] { "exitCode", "receiptSha256" })
                        || result.GetProperty("exitCode").GetInt32() != 0 || !Digest(result.GetProperty("receiptSha256").GetString())) throw Reject();
                    return 0;
                }
            }
            catch { throw Reject(); }
            finally { credentials.Clear(); if (request != null) Array.Clear(request,0,request.Length); }
        }
        private static bool Digest(string value)
        {
            return value != null && value.Length == 64 && value != new string('0',64) && value.All(c => c >= '0' && c <= '9' || c >= 'a' && c <= 'f');
        }
        private static async Task<byte[]> ExchangeAsync(byte[] request, CancellationToken cancellation)
        {
            if (!RuntimeInformation.IsOSPlatform(OSPlatform.Windows)) throw Reject();
            using (var pipe = new NamedPipeClientStream(".", "MurageSigningBoundary", PipeDirection.InOut, PipeOptions.Asynchronous,
                System.Security.Principal.TokenImpersonationLevel.Identification))
            {
                await pipe.ConnectAsync(30000, cancellation).ConfigureAwait(false);
                using (var server = AuthenticateServer(pipe))
                {
                    await pipe.WriteAsync(request,0,request.Length,cancellation).ConfigureAwait(false);
                    await pipe.WriteAsync(new byte[] { 10 },0,1,cancellation).ConfigureAwait(false);
                    using (var response = new MemoryStream())
                    {
                        var next = new byte[1];
                        while (await pipe.ReadAsync(next,0,1,cancellation).ConfigureAwait(false) == 1)
                        {
                            if (next[0] == 10) return response.ToArray();
                            if (response.Length >= 4095) throw Reject();
                            response.WriteByte(next[0]);
                        }
                    }
                    throw Reject();
                }
            }
        }
        [StructLayout(LayoutKind.Sequential)] private struct ServiceStatus { public uint Type, State, Accepted, ExitCode, SpecificExitCode, Checkpoint, Hint, Pid, Flags; }
        [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] private static extern IntPtr OpenSCManager(string machine, string database, uint access);
        [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] private static extern IntPtr OpenService(IntPtr manager, string name, uint access);
        [DllImport("advapi32.dll", SetLastError=true)] private static extern bool QueryServiceStatusEx(IntPtr service, int level, out ServiceStatus status, int length, out int needed);
        [DllImport("advapi32.dll")] private static extern bool CloseServiceHandle(IntPtr handle);
        [DllImport("kernel32.dll", SetLastError=true)] private static extern bool GetNamedPipeServerProcessId(SafePipeHandle pipe,out uint pid);
        [DllImport("kernel32.dll", SetLastError=true)] private static extern SafeProcessHandle OpenProcess(uint access,bool inherit,uint pid);
        [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] private static extern bool QueryFullProcessImageName(SafeProcessHandle process,uint flags,StringBuilder name,ref uint size);
        [DllImport("kernel32.dll", SetLastError=true)] private static extern uint WaitForSingleObject(SafeProcessHandle process,uint timeout);
        [DllImport("advapi32.dll", SetLastError=true)] private static extern bool OpenProcessToken(SafeProcessHandle process,uint access,out SafeAccessTokenHandle token);

        [System.Runtime.Versioning.SupportedOSPlatform("windows")]
        private static SafeProcessHandle AuthenticateServer(NamedPipeClientStream pipe)
        {
            IntPtr manager = OpenSCManager(null,null,1), service = IntPtr.Zero;
            SafeProcessHandle process = null;
            try
            {
                if (manager == IntPtr.Zero) throw Reject();
                service = OpenService(manager,"MurageSigningBoundary",4);
                uint pid; int needed; ServiceStatus status;
                if (service == IntPtr.Zero || !QueryServiceStatusEx(service,0,out status,Marshal.SizeOf<ServiceStatus>(),out needed)
                    || status.State != 4 || !GetNamedPipeServerProcessId(pipe.SafePipeHandle,out pid) || pid == 0 || pid != status.Pid) throw Reject();
                process = OpenProcess(0x101000,false,pid);
                if (process.IsInvalid || WaitForSingleObject(process,0) != 258) throw Reject();
                var name = new StringBuilder(32768); uint length = 32768;
                if (!QueryFullProcessImageName(process,0,name,ref length) || name.ToString() != Root + @"\boundary\MurageSigningBoundary.exe") throw Reject();
                SafeAccessTokenHandle token;
                if (!OpenProcessToken(process,8,out token)) throw Reject();
                using (token) using (var identity = new System.Security.Principal.WindowsIdentity(token.DangerousGetHandle()))
                { if (!identity.IsSystem) throw Reject(); }
                using (var config = JsonDocument.Parse(File.ReadAllBytes(Root + @"\controller\runner-boundary.json")))
                {
                    if (!config.RootElement.EnumerateObject().Select(row => row.Name).SequenceEqual(new[] { "boundarySha256" })) throw Reject();
                    var expected = config.RootElement.GetProperty("boundarySha256").GetString();
                    using (var file = new FileStream(name.ToString(),FileMode.Open,FileAccess.Read,FileShare.Read))
                    { if (!Digest(expected) || Convert.ToHexString(SHA256.HashData(file)).ToLowerInvariant() != expected) throw Reject(); }
                }
                return process;
            }
            catch { process?.Dispose(); throw Reject(); }
            finally { if (service != IntPtr.Zero) CloseServiceHandle(service); if (manager != IntPtr.Zero) CloseServiceHandle(manager); }
        }
    }
}
