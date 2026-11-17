// CLI binding producer owner: Builder B; production operation binding and protected authentication acceptance owner: MAIN.
using System;
using System.IO;
using System.Security.Cryptography;
using System.Text.Json;

namespace Murage.Witness
{
    public static class CollectionEntry
    {
        public static void Witness(byte[] requestBytes, JsonElement enrollment, JsonElement plan, string caseId, string output)
        {
            using var request = WitnessCodec.Parse(requestBytes, 8 * 1024 * 1024);
            WitnessCodec.Request(request.RootElement, enrollment, caseId, plan);
            SeamStatus.Require(caseId, SeamStatus.Adapters(enrollment));
            // R-COL(6) explicitly keeps the production binding Unenrolled until custody is accepted.
            new UnenrolledEvidenceAuthenticator().Verify(Array.Empty<byte>(), Array.Empty<byte>());
        }
        public static void Assets(string[] args, bool witnessEnrollmentPresent)
        {
            AssetsCollector.Arguments(args);
            if (witnessEnrollmentPresent) throw WitnessCodec.Reject("WORKFLOW_ON_WITNESS_HOST");
            new UnenrolledEvidenceAuthenticator().Verify(Array.Empty<byte>(), Array.Empty<byte>());
        }
        public static OperationBinding WorkflowBinding(string source)
        {
            if (!WitnessCodec.Hex(source, 40)) throw WitnessCodec.Reject("IDENTITY");
            string Fresh(int size) => Convert.ToHexString(RandomNumberGenerator.GetBytes(size)).ToLowerInvariant();
            return new OperationBinding(Fresh(32), Fresh(32), "workflow-assets", HeldFile.Hash(System.Text.Encoding.UTF8.GetBytes(source)), Fresh(16));
        }
    }
}
