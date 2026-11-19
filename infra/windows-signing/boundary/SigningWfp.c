/* WFP implementation owner: win-sac-sign; image build, reviewed DLL pin and packet witness owner: MAIN. */
#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <windows.h>
#include <ws2tcpip.h>
#include <initguid.h>
#include <fwpmu.h>
#include <sddl.h>
#include <stdlib.h>
#include <stdio.h>
#pragma comment(lib, "fwpuclnt.lib")
#pragma comment(lib, "advapi32.lib")
#pragma comment(lib, "ws2_32.lib")
#pragma comment(lib, "rpcrt4.lib")

typedef struct { HANDLE engine; GUID sublayer; PSECURITY_DESCRIPTOR descriptor; FWP_BYTE_BLOB user; BOOL transaction; } POLICY;
__declspec(dllexport) void SigningWfpClose(POLICY *p) {
    if (!p) return;
    if (p->transaction) FwpmTransactionAbort0(p->engine);
    if (p->engine) FwpmEngineClose0(p->engine);
    if (p->descriptor) LocalFree(p->descriptor);
    free(p);
}
__declspec(dllexport) DWORD SigningWfpBegin(const wchar_t *sid, POLICY **output) {
    POLICY *p; DWORD result, descriptorSize; wchar_t sddl[256]; PSID parsed = NULL;
    if (!output) return ERROR_INVALID_PARAMETER;
    *output = NULL;
    if (!sid || wcslen(sid) > 160 || !ConvertStringSidToSidW(sid, &parsed)) return ERROR_INVALID_PARAMETER;
    LocalFree(parsed);
    p = calloc(1, sizeof(*p));
    if (!p) return ERROR_OUTOFMEMORY;
    /* FWP_ACTRL_MATCH_FILTER is bit 1; the descriptor is a condition, not an egress grant. */
    swprintf_s(sddl, 256, L"D:(A;;0x1;;;%s)", sid);
    if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, SDDL_REVISION_1, &p->descriptor, &descriptorSize)) { result = GetLastError(); goto fail; }
    p->user.size = descriptorSize;
    p->user.data = (UINT8 *)p->descriptor;
    result = FwpmEngineOpen0(NULL, RPC_C_AUTHN_WINNT, NULL, NULL, &p->engine);
    if (result) goto fail;
    result = FwpmTransactionBegin0(p->engine, 0);
    if (result) goto fail;
    p->transaction = TRUE;
    {
        FWPM_SUBLAYER0 sublayer = {0};
        result = UuidCreate(&p->sublayer);
        if (result != RPC_S_OK && result != RPC_S_UUID_LOCAL_ONLY) goto fail;
        sublayer.subLayerKey = p->sublayer;
        sublayer.displayData.name = L"Murage signing one-use account";
        sublayer.flags = FWPM_SUBLAYER_FLAG_PERSISTENT;
        sublayer.weight = 0xffff;
        result = FwpmSubLayerAdd0(p->engine, &sublayer, NULL);
        if (result) goto fail;
    }
    *output = p;
    return ERROR_SUCCESS;
fail:
    SigningWfpClose(p);
    return result;
}
static DWORD add(POLICY *p, BOOL ipv6, const wchar_t *application, const wchar_t *address, UINT16 port) {
    FWPM_FILTER0 filter = {0}; FWPM_FILTER_CONDITION0 conditions[5] = {0};
    FWP_BYTE_BLOB *app = NULL; FWP_BYTE_ARRAY16 ip6; IN_ADDR ip4; UINT64 weight = application ? 2 : 1;
    UINT32 count = 1; DWORD result;
    if (!p || !p->transaction) return ERROR_INVALID_STATE;
    conditions[0].fieldKey = FWPM_CONDITION_ALE_USER_ID;
    conditions[0].conditionValue.type = FWP_SECURITY_DESCRIPTOR_TYPE;
    conditions[0].conditionValue.sd = &p->user;
    if (application) {
        if (!address || port == 0) return ERROR_INVALID_PARAMETER;
        result = FwpmGetAppIdFromFileName0(application, &app);
        if (result) return result;
        conditions[1].fieldKey = FWPM_CONDITION_ALE_APP_ID;
        conditions[1].conditionValue.type = FWP_BYTE_BLOB_TYPE;
        conditions[1].conditionValue.byteBlob = app;
        conditions[2].fieldKey = FWPM_CONDITION_IP_REMOTE_ADDRESS;
        if (ipv6) {
            if (InetPtonW(AF_INET6, address, &ip6) != 1) { result = ERROR_INVALID_PARAMETER; goto done; }
            conditions[2].conditionValue.type = FWP_BYTE_ARRAY16_TYPE;
            conditions[2].conditionValue.byteArray16 = &ip6;
        } else {
            if (InetPtonW(AF_INET, address, &ip4) != 1) { result = ERROR_INVALID_PARAMETER; goto done; }
            conditions[2].conditionValue.type = FWP_UINT32;
            conditions[2].conditionValue.uint32 = ntohl(ip4.S_un.S_addr);
        }
        conditions[3].fieldKey = FWPM_CONDITION_IP_REMOTE_PORT;
        conditions[3].conditionValue.type = FWP_UINT16;
        conditions[3].conditionValue.uint16 = port;
        conditions[4].fieldKey = FWPM_CONDITION_IP_PROTOCOL;
        conditions[4].conditionValue.type = FWP_UINT8;
        conditions[4].conditionValue.uint8 = IPPROTO_TCP;
        count = 5;
    }
    filter.displayData.name = application ? L"Murage reviewed signing endpoint" : L"Murage signing default deny";
    filter.flags = FWPM_FILTER_FLAG_PERSISTENT;
    filter.layerKey = ipv6 ? FWPM_LAYER_ALE_AUTH_CONNECT_V6 : FWPM_LAYER_ALE_AUTH_CONNECT_V4;
    filter.subLayerKey = p->sublayer;
    filter.weight.type = FWP_UINT64; filter.weight.uint64 = &weight;
    filter.numFilterConditions = count; filter.filterCondition = conditions;
    filter.action.type = application ? FWP_ACTION_PERMIT : FWP_ACTION_BLOCK;
    result = FwpmFilterAdd0(p->engine, &filter, NULL, NULL);
done:
    if (app) FwpmFreeMemory0((void **)&app);
    return result;
}
__declspec(dllexport) DWORD SigningWfpBlock(POLICY *p, int ipv6) { return add(p, ipv6 != 0, NULL, NULL, 0); }
__declspec(dllexport) DWORD SigningWfpAllow(POLICY *p, const wchar_t *application, const wchar_t *address, UINT16 port) {
    return add(p, address && wcschr(address, L':') != NULL, application, address, port);
}
__declspec(dllexport) DWORD SigningWfpCommit(POLICY *p) {
    DWORD result;
    if (!p || !p->transaction) return ERROR_INVALID_STATE;
    result = FwpmTransactionCommit0(p->engine);
    if (!result) p->transaction = FALSE;
    return result;
}
