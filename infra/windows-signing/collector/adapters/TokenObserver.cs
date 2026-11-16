// Token measurement producer owner: Builder B; role-token observation consumer owner: MAIN.
using System;
using System.Collections.Generic;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;

namespace Murage.Witness
{
    public sealed record TokenGroup(string Sid, uint Attributes);
    public sealed record TokenPrivilege(string Name, uint Attributes);
    public sealed record TokenMeasurement(string UserSid, IReadOnlyList<TokenGroup> Groups, IReadOnlyList<TokenPrivilege> Privileges, bool Elevated, string ElevationType, string IntegrityLevel)
    {
        public bool AdministratorMember => Groups.Any(group => group.Sid == "S-1-5-32-544");
        public bool Standard => !AdministratorMember && !Elevated && ElevationType == "Default" && IntegrityLevel == "Medium";
        public bool ShutdownRemoved => !Privileges.Any(privilege => privilege.Name == "SeShutdownPrivilege" || privilege.Name == "SeRemoteShutdownPrivilege");
    }
    public static class TokenObserver
    {
        [DllImport("advapi32.dll", SetLastError = true)] private static extern bool GetTokenInformation(IntPtr token, int kind, IntPtr data, int length, out int needed);
        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool LookupPrivilegeName(string system, IntPtr luid, StringBuilder name, ref int size);
        private static T Read<T>(IntPtr token, int kind, Func<IntPtr, int, T> parse)
        {
            if (GetTokenInformation(token, kind, IntPtr.Zero, 0, out int length) || Marshal.GetLastWin32Error() != 122 || length <= 0 || length > 1024 * 1024) throw WitnessCodec.Reject("TOKEN_QUERY");
            IntPtr data = Marshal.AllocHGlobal(length);
            try
            {
                if (!GetTokenInformation(token, kind, data, length, out int actual) || actual <= 0 || actual > length) throw WitnessCodec.Reject("TOKEN_QUERY");
                return parse(data, actual);
            }
            finally { Marshal.FreeHGlobal(data); }
        }
        public static TokenMeasurement Current()
        {
            if (!OperatingSystem.IsWindows()) throw WitnessCodec.Reject("WINDOWS_REQUIRED");
            using var identity = WindowsIdentity.GetCurrent(); return Read(identity.Token);
        }
        public static TokenMeasurement Read(IntPtr token)
        {
            var groups = Read(token, 2, (data, length) => {
                int count = Marshal.ReadInt32(data), offset = IntPtr.Size == 8 ? 8 : 4, stride = IntPtr.Size == 8 ? 16 : 8;
                if (count < 0 || count > (length - offset) / stride) throw WitnessCodec.Reject("TOKEN_QUERY");
                var rows = new List<TokenGroup>();
                for (int i = 0; i < count; ++i)
                {
                    IntPtr row = IntPtr.Add(data, offset + i * stride);
                    rows.Add(new TokenGroup(new SecurityIdentifier(Marshal.ReadIntPtr(row)).Value, unchecked((uint)Marshal.ReadInt32(row, IntPtr.Size))));
                }
                return rows;
            });
            var privileges = Read(token, 3, (data, length) => {
                int count = Marshal.ReadInt32(data);
                if (count < 0 || count > (length - 4) / 12) throw WitnessCodec.Reject("TOKEN_QUERY");
                var rows = new List<TokenPrivilege>();
                for (int i = 0; i < count; ++i)
                {
                    var row = IntPtr.Add(data, 4 + i * 12); int size = 256; var name = new StringBuilder(size);
                    if (!LookupPrivilegeName(null, row, name, ref size)) throw WitnessCodec.Reject("TOKEN_QUERY");
                    rows.Add(new TokenPrivilege(name.ToString(), unchecked((uint)Marshal.ReadInt32(row, 8))));
                }
                return rows;
            });
            string sid = Read(token, 1, (data, _) => new SecurityIdentifier(Marshal.ReadIntPtr(data)).Value);
            bool elevated = Read(token, 20, (data, length) => length >= 4 ? Marshal.ReadInt32(data) != 0 : throw WitnessCodec.Reject("TOKEN_QUERY"));
            string type = Read(token, 18, (data, length) => length >= 4 ? Marshal.ReadInt32(data) switch { 1 => "Default", 2 => "Full", 3 => "Limited", _ => "Unknown" } : throw WitnessCodec.Reject("TOKEN_QUERY"));
            string integrity = Read(token, 25, (data, _) => new SecurityIdentifier(Marshal.ReadIntPtr(data)).Value) switch {
                "S-1-16-8192" => "Medium", "S-1-16-4096" => "Low", "S-1-16-12288" => "High", "S-1-16-16384" => "System", _ => "Unknown" };
            return new TokenMeasurement(sid, groups, privileges, elevated, type, integrity);
        }
        public static TokenMeasurement Parse(System.Text.Json.JsonElement token)
        {
            WitnessCodec.Fields(token, "userSid", "groups", "privileges", "elevated", "elevationType", "integrityLevel");
            var groups = token.GetProperty("groups").EnumerateArray().Select(row => {
                WitnessCodec.Fields(row, "sid", "attributes"); return new TokenGroup(WitnessCodec.Text(row, "sid"), row.GetProperty("attributes").GetUInt32());
            }).ToArray();
            var privileges = token.GetProperty("privileges").EnumerateArray().Select(row => {
                WitnessCodec.Fields(row, "name", "attributes"); return new TokenPrivilege(WitnessCodec.Text(row, "name"), row.GetProperty("attributes").GetUInt32());
            }).ToArray();
            return new TokenMeasurement(WitnessCodec.Text(token, "userSid"), groups, privileges, token.GetProperty("elevated").GetBoolean(), WitnessCodec.Text(token, "elevationType"), WitnessCodec.Text(token, "integrityLevel"));
        }
    }
}
