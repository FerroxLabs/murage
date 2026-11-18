// Capture producer owner: win-sac-sign; approved redacted observation adapters and private retention consumer owner: MAIN.
using System;
using System.IO;
using System.Security.Cryptography;
using System.Text.RegularExpressions;

namespace Murage.Witness
{
    public sealed class CaptureWriter : IDisposable
    {
        private readonly string directory;
        private readonly HeldFile heldDirectory;
        public CaptureWriter(string directory)
        {
            this.directory = directory;
            heldDirectory = HeldFile.HoldDirectory(directory);
        }
        public static void Name(string name)
        {
            if (name == null || !Regex.IsMatch(name, @"\A[a-z0-9][a-z0-9.-]{0,100}\z")
                || name == "request.json" || name == "result.json" || name == "collector.log") throw WitnessCodec.Reject("CAPTURE_NAME");
            // Windows device names and trailing dots remain invalid even when the pack's filename grammar matches.
            WitnessCodec.Absolute(@"C:\Capture\" + name);
        }
        public static string Copy(Stream input, Stream output)
        {
            using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
            var buffer = new byte[81920]; int total = 0;
            for (;;)
            {
                int read = input.Read(buffer, 0, Math.Min(buffer.Length, WitnessCodec.CaptureLimit - total + 1));
                if (read == 0) break;
                if (read > WitnessCodec.CaptureLimit - total) throw WitnessCodec.Reject("CAPTURE_SIZE");
                output.Write(buffer, 0, read); hash.AppendData(buffer, 0, read); total += read;
            }
            if (total == 0) throw WitnessCodec.Reject("CAPTURE_EMPTY");
            return Convert.ToHexString(hash.GetHashAndReset()).ToLowerInvariant();
        }
        public HeldFile Write(string name, Stream redactedObservation)
        {
            Name(name); var path = Path.Combine(directory, name); string digest;
            using (var output = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.None))
            {
                digest = Copy(redactedObservation, output);
                output.Flush(true);
            }
            // The expected hash closes the close/reopen gap; held ancestors and leaf prevent later substitution.
            return new HeldFile(path, WitnessCodec.CaptureLimit, digest);
        }
        public void Dispose() => heldDirectory.Dispose();
    }
}
