// Independent supervisor producer owner: Builder A win-sac-sign-sa; pre-registration/deployment and expiry authority owner: MAIN.
using System;
using System.Globalization;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace Murage.Witness
{
    public interface ICollectorLifetime : IDisposable
    {
        bool WaitUntil(DateTimeOffset expires);
    }
    public sealed class CollectorLifetime : ICollectorLifetime
    {
        [DllImport("kernel32.dll", SetLastError = true)] private static extern SafeProcessHandle OpenProcess(uint access, bool inherit, uint pid);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetProcessTimes(SafeProcessHandle process, out long creation, out long exit, out long kernel, out long user);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern uint WaitForSingleObject(SafeProcessHandle process, uint milliseconds);
        private readonly SafeProcessHandle handle;
        public CollectorLifetime(uint pid, long creation)
        {
            if (!OperatingSystem.IsWindows() || pid == 0 || creation <= 0) throw WitnessCodec.Reject("SUPERVISOR_IDENTITY");
            handle = OpenProcess(0x101000, false, pid);
            if (handle.IsInvalid)
            {
                int error = Marshal.GetLastWin32Error(); handle.Dispose(); handle = null;
                if (error != 87) throw WitnessCodec.Reject("PROCESS_QUERY");
            }
            else if (!GetProcessTimes(handle, out var actual, out _, out _, out _))
            { handle.Dispose(); throw WitnessCodec.Reject("PROCESS_QUERY"); }
            else if (actual != creation) { handle.Dispose(); handle = null; }
        }
        public bool WaitUntil(DateTimeOffset expires)
        {
            if (handle == null) return true;
            var remaining = expires - DateTimeOffset.UtcNow;
            if (remaining <= TimeSpan.Zero) return false;
            if (remaining.TotalMilliseconds >= UInt32.MaxValue) throw WitnessCodec.Reject("SUPERVISOR_EXPIRY");
            var result = WaitForSingleObject(handle, (uint)Math.Ceiling(remaining.TotalMilliseconds));
            if (result != 0 && result != 258) throw WitnessCodec.Reject("PROCESS_QUERY");
            return result == 0;
        }
        public void Dispose() => handle?.Dispose();
    }
    public static class Supervisor
    {
        public static bool Run(ICollectorLifetime collector, DateTimeOffset expires, Func<bool> finalized, Func<bool> reap, Action expire)
        {
            bool exited = collector.WaitUntil(expires);
            if (!exited) expire();
            if (exited && finalized()) return true;
            return reap();
        }
        internal static (string Run, uint Pid, long Creation, DateTimeOffset Expires) Arguments(string[] args)
        {
            if (args.Length != 8 || args[0] != "--supervise" || !WitnessCodec.Hex(args[1], 64)
                || args[2] != "--collector-pid" || args[4] != "--collector-creation" || args[6] != "--expires"
                || !UInt32.TryParse(args[3], NumberStyles.None, CultureInfo.InvariantCulture, out var pid) || pid == 0 || pid.ToString(CultureInfo.InvariantCulture) != args[3]
                || !Int64.TryParse(args[5], NumberStyles.None, CultureInfo.InvariantCulture, out var creation) || creation <= 0 || creation.ToString(CultureInfo.InvariantCulture) != args[5]
                || !DateTimeOffset.TryParseExact(args[7], "yyyy-MM-dd'T'HH:mm:ss'Z'", CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var expires)) throw WitnessCodec.Reject("USAGE");
            return (args[1], pid, creation, expires);
        }
    }
}
