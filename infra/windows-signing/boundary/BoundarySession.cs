// Broker protocol owner: win-sac-sign; service admission and authenticated native pipe peer owner: MAIN.
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace Murage.Signing
{
    public static class BoundarySession
    {
        private static Exception Reject() { return new InvalidOperationException("WINDOWS_SIGNING_BOUNDARY_REJECTED"); }
        private static string Field(JsonElement value, string key)
        {
            if (!value.TryGetProperty(key, out var field) || field.ValueKind != JsonValueKind.String) throw Reject();
            return field.GetString();
        }
        private static void Fields(JsonElement value, params string[] keys)
        {
            if (value.ValueKind != JsonValueKind.Object || !value.EnumerateObject().Select(row => row.Name).OrderBy(key => key, StringComparer.Ordinal)
                .SequenceEqual(keys.OrderBy(key => key, StringComparer.Ordinal))) throw Reject();
        }
        private static bool Hex(string value, int length)
        {
            return value != null && value.Length == length && value.All(c => c >= '0' && c <= '9' || c >= 'a' && c <= 'f');
        }
        private static async Task<byte[]> Frame(Stream stream, CancellationToken cancellation)
        {
            using (var buffer = new MemoryStream())
            {
                var next = new byte[1];
                while (await stream.ReadAsync(next, 0, 1, cancellation).ConfigureAwait(false) == 1)
                {
                    if (next[0] == 10) return buffer.ToArray();
                    if (buffer.Length >= 4095) throw Reject();
                    buffer.WriteByte(next[0]);
                }
            }
            throw Reject();
        }
        private static Task Reply(Stream stream, object value, CancellationToken cancellation)
        {
            var bytes = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(value) + "\n");
            return stream.WriteAsync(bytes, 0, bytes.Length, cancellation);
        }
        // pid/creation are measured by the service from this pipe, never deserialized from a message.
        public static async Task ServeAsync(Stream stream, SigningLease lease, string nonce, long pid, long creation, CancellationToken cancellation)
        {
            try { await ServeCoreAsync(stream, lease, nonce, pid, creation, cancellation).ConfigureAwait(false); }
            catch { throw Reject(); }
        }
        private static async Task ServeCoreAsync(Stream stream, SigningLease lease, string nonce, long pid, long creation, CancellationToken cancellation)
        {
            if (stream == null || lease == null || !Hex(nonce, 64)) throw Reject();
            using (var watchLifetime = CancellationTokenSource.CreateLinkedTokenSource(cancellation))
            {
                Task<int> watch = null;
                try
                {
                    using (var message = JsonDocument.Parse(await Frame(stream, cancellation).ConfigureAwait(false)))
                    {
                        var value = message.RootElement;
                        Fields(value, "id", "operation", "lease", "launchSha256", "runAuthorizationSha256");
                        var id = Field(value, "id");
                        if (!Hex(id, 32) || Field(value, "operation") != "seal" || Field(value, "lease") != nonce) throw Reject();
                        string measurement = await lease.SealAsync(pid, creation, Field(value, "launchSha256"), Field(value, "runAuthorizationSha256")).ConfigureAwait(false);
                        await Reply(stream, new { id, ok = true, result = new { measurementId = measurement } }, cancellation).ConfigureAwait(false);
                    }
                    using (var message = JsonDocument.Parse(await Frame(stream, cancellation).ConfigureAwait(false)))
                    {
                        var value = message.RootElement;
                        Fields(value, "id", "operation", "lease", "measurementId");
                        var id = Field(value, "id");
                        if (!Hex(id, 32) || Field(value, "operation") != "release" || Field(value, "lease") != nonce) throw Reject();
                        var running = lease.ReleaseAsync(pid, creation, Field(value, "measurementId"));
                        watch = stream.ReadAsync(new byte[1], 0, 1, watchLifetime.Token);
                        // Any further input or disconnect revokes a child while the release request is pending.
                        if (await Task.WhenAny(running, watch).ConfigureAwait(false) == watch)
                        {
                            lease.Revoke();
                            try { await running.ConfigureAwait(false); } catch { }
                            throw Reject();
                        }
                        var result = await running.ConfigureAwait(false);
                        await Reply(stream, new { id, ok = true, result = new { exitCode = result.ExitCode, receiptSha256 = result.ReceiptSha256 } }, cancellation).ConfigureAwait(false);
                    }
                }
                catch { lease.Revoke(); throw Reject(); }
                finally
                {
                    watchLifetime.Cancel();
                    stream.Dispose();
                    if (watch != null) { try { await watch.ConfigureAwait(false); } catch { } }
                    lease.Dispose();
                }
            }
        }
    }
}
