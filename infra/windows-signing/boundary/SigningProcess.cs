// Process implementation owner: win-sac-sign; admitted token, sealed pins and service deployment owner: MAIN.
using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace Murage.Signing
{
    public sealed class SigningProcessSpec
    {
        public const string Root = @"C:\Program Files\MurageSigning";
        public const string Signtool = Root + @"\provider\localappdata\ArtifactSigning\Microsoft.Windows.SDK.BuildTools\Microsoft.Windows.SDK.BuildTools.10.0.26100.4188\bin\10.0.26100.0\x64\signtool.exe";
        public string Executable { get; }
        public string Arguments { get; }
        public string WorkingDirectory { get; } = Root + @"\launch";
        public IReadOnlyDictionary<string, string> Environment { get; }
        private readonly SortedDictionary<string, string> environment;

        // Only service-owned, independently verified configuration reaches this constructor, never a pipe request.
        public SigningProcessSpec(bool bootstrap, IReadOnlyDictionary<string, string> environment,
            IReadOnlyDictionary<string, string> credentials = null)
        {
            if (environment == null) throw Reject();
            var clean = new SortedDictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            foreach (var pair in environment)
            {
                if (String.IsNullOrEmpty(pair.Key) || pair.Value == null || pair.Key.IndexOfAny(new[] { '=', '\0' }) >= 0
                    || pair.Value.Contains('\0') || clean.ContainsKey(pair.Key)) throw Reject();
                bool runtime = new[] { "SystemRoot", "WINDIR", "TEMP", "TMP", "PATH", "PSModulePath", "NODE_OPTIONS" }.Contains(pair.Key, StringComparer.Ordinal);
                bool setting = System.Text.RegularExpressions.Regex.IsMatch(pair.Key, @"\AMURAGE_[A-Z0-9_]+\z")
                    && !System.Text.RegularExpressions.Regex.IsMatch(pair.Key, "SECRET|TOKEN|PASSWORD|CREDENTIAL");
                if (!runtime && !setting) throw Reject();
                clean.Add(pair.Key, pair.Value);
            }
            if (!clean.TryGetValue("SystemRoot", out var systemRoot) || systemRoot != @"C:\Windows"
                || !clean.TryGetValue("WINDIR", out var windir) || windir != systemRoot
                || !clean.TryGetValue("TEMP", out var temp) || !DataPath(temp)
                || !clean.TryGetValue("TMP", out var tmp) || tmp != temp
                || !clean.TryGetValue("NODE_OPTIONS", out var options) || options != ""
                || !clean.TryGetValue("PATH", out var paths) || !TrustedDirectories(paths)
                || !clean.TryGetValue("PSModulePath", out var modules) || !TrustedDirectories(modules)) throw Reject();
            if (bootstrap ? credentials != null : credentials == null || credentials.Count != 3) throw Reject();
            if (!bootstrap)
            {
                foreach (var key in new[] { "AZURE_TENANT_ID", "AZURE_CLIENT_ID", "AZURE_CLIENT_SECRET" })
                {
                    if (!credentials.TryGetValue(key, out var value) || String.IsNullOrEmpty(value) || value.Contains('\0')) throw Reject();
                    clean.Add(key, value);
                }
            }
            Executable = Root + (bootstrap ? @"\node\node.exe" : @"\pwsh\pwsh.exe");
            Arguments = bootstrap ? "--max-old-space-size=4300 \"" + Root + @"\app\scripts\windows-signing-bootstrap.mjs" + "\""
                : "-NoProfile -NonInteractive -File \"" + Root + @"\launch\launch.ps1" + "\"";
            this.environment = clean;
            Environment = new System.Collections.ObjectModel.ReadOnlyDictionary<string, string>(clean);
        }
        private static bool DataPath(string value)
        {
            return System.Text.RegularExpressions.Regex.IsMatch(value ?? "", @"\AC:\\MurageSigningData\\[a-f0-9]{64}\\temp\z");
        }
        private static bool TrustedDirectories(string value)
        {
            return !String.IsNullOrEmpty(value) && value.Split(';').All(part => part.StartsWith(Root + @"\", StringComparison.Ordinal)
                && part.Substring(Root.Length + 1).Split('\\').All(segment => !String.IsNullOrEmpty(segment) && segment != "." && segment != ".."
                    && segment.All(c => Char.IsAsciiLetterOrDigit(c) || c == '-' || c == '_' || c == '.') && !segment.EndsWith(".")));
        }
        public byte[] EnvironmentBlock()
        {
            var text = String.Join("\0", Environment.OrderBy(pair => pair.Key, StringComparer.OrdinalIgnoreCase).Select(pair => pair.Key + "=" + pair.Value)) + "\0\0";
            if (text.Length > 32767) throw Reject();
            return Encoding.Unicode.GetBytes(text);
        }
        internal void ClearCredentials()
        {
            foreach (var key in environment.Keys.Where(key => key.StartsWith("AZURE_", StringComparison.Ordinal)).ToArray()) environment.Remove(key);
        }
        internal static Exception Reject() { return new InvalidOperationException("WINDOWS_SIGNING_PROCESS_REJECTED"); }
    }

    public interface ISigningProcessApi
    {
        void AssertStandardToken(IntPtr token);
        void AssertTokenSid(IntPtr token, string sid);
        IntPtr CreateJob();
        SigningProcessHandles CreateSuspended(IntPtr token, SigningProcessSpec spec, byte[] environment);
        void Assign(IntPtr job, IntPtr process);
        void Resume(IntPtr thread);
        Task<int> WaitAsync(IntPtr process, CancellationToken cancellation);
        void Terminate(IntPtr process);
        void Close(IntPtr handle);
    }
    public sealed class SigningProcessHandles
    {
        public IntPtr Process { get; }
        public IntPtr Thread { get; }
        public SigningProcessHandles(IntPtr process, IntPtr thread) { Process = process; Thread = thread; }
    }
    public static class SigningProcess
    {
        public static Task<int> RunAsync(IntPtr token, SigningProcessSpec spec, CancellationToken cancellation)
        {
            return RunAsync(new WindowsSigningProcessApi(), token, spec, cancellation);
        }
        public static async Task<int> RunAsync(ISigningProcessApi api, IntPtr token, SigningProcessSpec spec, CancellationToken cancellation)
        {
            try { return await RunCoreAsync(api, token, spec, cancellation).ConfigureAwait(false); }
            catch { throw SigningProcessSpec.Reject(); }
            finally { spec?.ClearCredentials(); }
        }
        private static async Task<int> RunCoreAsync(ISigningProcessApi api, IntPtr token, SigningProcessSpec spec, CancellationToken cancellation)
        {
            if (api == null || token == IntPtr.Zero || spec == null) throw SigningProcessSpec.Reject();
            IntPtr job = IntPtr.Zero;
            SigningProcessHandles child = null;
            byte[] block = null;
            try
            {
                cancellation.ThrowIfCancellationRequested();
                api.AssertStandardToken(token);
                job = api.CreateJob();
                if (job == IntPtr.Zero) throw SigningProcessSpec.Reject();
                block = spec.EnvironmentBlock();
                child = api.CreateSuspended(token, spec, block);
                if (child == null || child.Process == IntPtr.Zero || child.Thread == IntPtr.Zero) throw SigningProcessSpec.Reject();
                api.Assign(job, child.Process);
                cancellation.ThrowIfCancellationRequested();
                api.Resume(child.Thread);
                return await api.WaitAsync(child.Process, cancellation).ConfigureAwait(false);
            }
            finally
            {
                if (block != null) Array.Clear(block, 0, block.Length);
                // Also kill the suspended child when assignment fails: closing an empty job cannot do that.
                try { if (child != null && child.Process != IntPtr.Zero) api.Terminate(child.Process); }
                finally
                {
                    try { if (job != IntPtr.Zero) api.Close(job); }
                    finally
                    {
                        try { if (child != null && child.Thread != IntPtr.Zero) api.Close(child.Thread); }
                        finally { if (child != null && child.Process != IntPtr.Zero) api.Close(child.Process); }
                    }
                }
            }
        }
    }
}
