// Broker framing/lease checks owner: win-sac-sign; Windows peer and service witness owner: MAIN.
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Murage.Signing;

public sealed class FixtureDuplex : Stream
{
    private readonly byte[] input;
    private int offset;
    public readonly MemoryStream Output = new MemoryStream();
    public bool Disconnect, FailWrite;
    public Action OnWatch;
    private readonly TaskCompletionSource<int> pending = new TaskCompletionSource<int>(TaskCreationOptions.RunContinuationsAsynchronously);
    public FixtureDuplex(string input) { this.input = Encoding.UTF8.GetBytes(input); }
    public override bool CanRead => true;
    public override bool CanWrite => true;
    public override bool CanSeek => false;
    public override long Length => throw new NotSupportedException();
    public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
    public override void Flush() { }
    public override long Seek(long offset, SeekOrigin origin) { throw new NotSupportedException(); }
    public override void SetLength(long value) { throw new NotSupportedException(); }
    public override int Read(byte[] bytes, int start, int length) { throw new NotSupportedException(); }
    public override void Write(byte[] bytes, int start, int length) { throw new NotSupportedException(); }
    public override Task<int> ReadAsync(byte[] bytes, int start, int length, CancellationToken cancellation)
    {
        cancellation.ThrowIfCancellationRequested();
        if (offset < input.Length) { bytes[start] = input[offset++]; return Task.FromResult(1); }
        OnWatch?.Invoke();
        if (Disconnect) return Task.FromResult(0);
        cancellation.Register(() => pending.TrySetCanceled(cancellation));
        return pending.Task;
    }
    public override Task WriteAsync(byte[] bytes, int start, int length, CancellationToken cancellation)
    {
        if (FailWrite) throw new IOException("private fixture error");
        Output.Write(bytes, start, length); return Task.CompletedTask;
    }
    protected override void Dispose(bool disposing) { pending.TrySetResult(0); base.Dispose(disposing); }
}
public sealed class SessionHost : ISealedSigningHost
{
    public int Starts, Seals, Stops, Checks;
    public bool Pause;
    public TaskCompletionSource<bool> Continue = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
    public void AssertPeer(long pid, long created) { if (pid != 10 || created != 20) throw new Exception(); }
    public Task<string> SealAsync(string launch, string authorization, CancellationToken cancellation) { Seals++; return Task.FromResult(new string('c',64)); }
    public void RevalidateHeldHandles() { Checks++; }
    public async Task<SigningCompletion> CreateSigningProcessAsync(IReadOnlyDictionary<string,string> credentials, CancellationToken cancellation)
    {
        Starts++; if (Pause) await Continue.Task;
        if (Stops > 0) throw new Exception();
        return new SigningCompletion(0,new string('d',64));
    }
    public void TerminateJob() { Stops++; Continue.TrySetResult(true); }
    public void Dispose() { }
}
public static class SessionChecks
{
    static int checks;
    static string Nonce = new string('f',64);
    static void Assert(bool value) { checks++; if (!value) throw new Exception("session assertion " + checks); }
    static string Seal() { return JsonSerializer.Serialize(new { id = new string('1',32), operation = "seal", lease = Nonce, launchSha256 = new string('a',64), runAuthorizationSha256 = new string('b',64) }) + "\n"; }
    static string Release() { return JsonSerializer.Serialize(new { id = new string('2',32), operation = "release", lease = Nonce, measurementId = new string('c',64) }) + "\n"; }
    static SigningLease Lease(SessionHost host)
    {
        return new SigningLease(host, new Dictionary<string,string> { { "AZURE_TENANT_ID","fixture" }, { "AZURE_CLIENT_ID","fixture" }, { "AZURE_CLIENT_SECRET","fixture" } }, new string('a',64),new string('b',64),10,20,TimeSpan.FromMinutes(1));
    }
    static async Task Reject(string frames, bool disconnect = false, bool writeFailure = false, long pid = 10, long created = 20, int starts = 0, bool pause = false, int replies = 0, int seals = 0)
    {
        var host = new SessionHost { Pause = pause }; var stream = new FixtureDuplex(frames) { Disconnect = disconnect, FailWrite = writeFailure };
        bool rejected = false;
        try { await BoundarySession.ServeAsync(stream, Lease(host), Nonce, pid, created, CancellationToken.None); }
        catch(Exception e) { rejected = e.Message == "WINDOWS_SIGNING_BOUNDARY_REJECTED"; }
        Assert(rejected && host.Starts == starts && host.Stops > 0);
        Assert(host.Seals == seals && Encoding.UTF8.GetString(stream.Output.ToArray()).Count(c => c == '\n') == replies);
        Assert(!Encoding.UTF8.GetString(stream.Output.ToArray()).Contains("AZURE_") && !Encoding.UTF8.GetString(stream.Output.ToArray()).Contains("fixture"));
    }
    static string Change(string frame, string key, object value, bool remove = false)
    {
        var fields = JsonSerializer.Deserialize<Dictionary<string,object>>(frame);
        if (remove) fields.Remove(key); else fields[key] = value;
        return JsonSerializer.Serialize(fields) + "\n";
    }
    public static async Task<int> Run()
    {
        foreach (bool pause in new[] { false, true })
        {
            var host = new SessionHost { Pause = pause }; var stream = new FixtureDuplex(Seal() + Release());
            stream.OnWatch = () => host.Continue.TrySetResult(true);
            await BoundarySession.ServeAsync(stream, Lease(host), Nonce,10,20,CancellationToken.None);
            Assert(host.Starts == 1 && host.Seals == 1 && host.Checks == 2 && host.Stops > 0);
            var replies = Encoding.UTF8.GetString(stream.Output.ToArray()).Split('\n',StringSplitOptions.RemoveEmptyEntries);
            Assert(replies.Length == 2);
            Assert(replies[0] == JsonSerializer.Serialize(new { id = new string('1',32), ok = true, result = new { measurementId = new string('c',64) } }));
            Assert(replies[1] == JsonSerializer.Serialize(new { id = new string('2',32), ok = true, result = new { exitCode = 0, receiptSha256 = new string('d',64) } }));
        }
        foreach (string frame in new[] { Seal(), Release() })
        {
            bool release = frame == Release();
            var mutations = new List<string>();
            foreach (var key in JsonSerializer.Deserialize<Dictionary<string,object>>(frame).Keys)
            { mutations.Add(Change(frame,key,null,true)); mutations.Add(Change(frame,key,1)); }
            mutations.AddRange(new[] { Change(frame,"id","wrong"), Change(frame,"operation","finish"), Change(frame,"lease",new string('e',64)), Change(frame,"sealed",true), frame.TrimEnd() + "extra\n", "[]\n", "null\n", "invalid\n", "{\"id\":\"duplicate\"," + frame.Substring(1) });
            mutations.Add(release ? Change(frame,"measurementId",new string('e',64)) : Change(frame,"launchSha256",new string('e',64)));
            if (!release) mutations.Add(Change(frame,"runAuthorizationSha256",new string('e',64)));
            foreach (var bad in mutations) await Reject((release ? Seal() : "") + bad, disconnect:true, replies:release ? 1 : 0, seals:release ? 1 : 0);
        }
        await Reject(Release(), disconnect:true);
        await Reject(Seal() + Seal(), disconnect:true, replies:1, seals:1);
        await Reject("", disconnect:true);
        await Reject("{}", disconnect:true);
        await Reject(new string(' ',4096) + Seal(), disconnect:true);
        await Reject(Seal() + Release(), pid:11);
        await Reject(Seal() + Release(), created:21);
        await Reject(Seal() + Release(), writeFailure:true, seals:1);
        await Reject(Seal() + Release(), disconnect:true, pause:true, starts:1, replies:1, seals:1);
        await Reject(Seal() + Release() + "x", pause:true, starts:1, replies:1, seals:1);
        return checks;
    }
}
