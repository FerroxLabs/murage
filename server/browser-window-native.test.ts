import { removeTempDirSync } from "./testing/cleanup.ts";
import { expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

it.runIf(process.platform === 'linux')('executes native signer extraction with missing/failed organization and SHA-256 APIs', () => {
  const source = readFileSync(new URL('../native/engine-exclusion/exclusion.c', import.meta.url), 'utf8');
  const execute = source.slice(source.indexOf('static void authenticode_execute('), source.indexOf('static void authenticode_complete('));
  const root = mkdtempSync(join(tmpdir(), 'native-signer-'));
  try {
    // Compile the actual production function against deterministic Win32 API
    // doubles. This covers control flow, not Windows trust qualification.
    writeFileSync(join(root, 'test.c'), `
#include <stdio.h>
#include <stdint.h>
#include <string.h>
#include <wchar.h>
typedef void *napi_env;
typedef unsigned char BYTE;
typedef unsigned long DWORD;
typedef void *HWND;
typedef int GUID;
#define INVALID_HANDLE_VALUE ((void *)-1)
#define WTD_UI_NONE 0
#define WTD_REVOKE_NONE 0
#define WTD_CHOICE_FILE 0
#define WTD_STATEACTION_VERIFY 1
#define WTD_STATEACTION_CLOSE 2
#define WINTRUST_ACTION_GENERIC_VERIFY_V2 0
#define ERROR_SUCCESS 0
#define FALSE 0
#define CERT_NAME_SIMPLE_DISPLAY_TYPE 1
#define CERT_NAME_ATTR_TYPE 2
#define szOID_ORGANIZATION_NAME "2.5.4.10"
#define CERT_SHA256_HASH_PROP_ID 107
#define X509_ASN_ENCODING 0
#define CERT_X500_NAME_STR 0
#define CERT_NAME_STR_REVERSE_FLAG 0
#define TRUST_E_NO_SIGNER_CERT 1
typedef struct { int Subject; } INFO;
typedef struct { INFO *pCertInfo; } CERT;
typedef struct { CERT *pCert; } CRYPT_PROVIDER_CERT;
typedef int CRYPT_PROVIDER_DATA;
typedef int CRYPT_PROVIDER_SGNR;
typedef struct { int cbStruct; wchar_t *pcwszFilePath; } WINTRUST_FILE_INFO;
typedef struct { int cbStruct, dwUIChoice, fdwRevocationChecks, dwUnionChoice, dwStateAction; WINTRUST_FILE_INFO *pFile; void *hWVTStateData; } WINTRUST_DATA;
typedef struct { wchar_t *path, publisher[512], subject[2048], organization[512]; char thumbprint[65]; int result; } AuthenticodeWork;
static int scenario;
static int WinVerifyTrust(HWND a, GUID *b, WINTRUST_DATA *c) { return 0; }
static CRYPT_PROVIDER_DATA *WTHelperProvDataFromStateData(void *s) { static int p; return &p; }
static CRYPT_PROVIDER_SGNR *WTHelperGetProvSignerFromChain(void *p, int a, int b, int c) { static int s; return &s; }
static CRYPT_PROVIDER_CERT *WTHelperGetProvCertFromChain(void *s, int i) { static INFO info; static CERT cert = { &info }; static CRYPT_PROVIDER_CERT leaf = { &cert }; return &leaf; }
static int CertGetNameStringW(CERT *c, int type, int flags, void *oid, wchar_t *out, int size) {
  if (type == CERT_NAME_SIMPLE_DISPLAY_TYPE) { wcscpy(out, L"Google Chrome"); return 14; }
  if (strcmp((const char *)oid, szOID_ORGANIZATION_NAME) != 0) return 0;
  if (scenario == 1) { out[0] = 0; return 1; }
  wcscpy(out, L"Google LLC");
  return scenario == 2 ? 0 : scenario == 6 ? 512 : 11;
}
static int CertGetCertificateContextProperty(CERT *c, int prop, BYTE *out, DWORD *size) {
  if (prop != CERT_SHA256_HASH_PROP_ID) return 0;
  memset(out, 0xab, 32); *size = scenario == 4 ? 31 : scenario == 5 ? 33 : 32;
  return scenario != 3;
}
static int CertNameToStrW(int a, void *b, int c, wchar_t *out, int size) { wcscpy(out, L"O=Google LLC"); return 13; }
${execute}
int main(void) {
  for (scenario = 0; scenario < 7; ++scenario) {
    AuthenticodeWork job = {0}; job.path = L"fixture.exe"; authenticode_execute(NULL, &job);
    printf("%d %d %zu %s\\n", scenario, wcscmp(job.organization, L"Google LLC") == 0, strlen(job.thumbprint), job.thumbprint);
  }
}
`);
    execFileSync('cc', ['-std=c11', '-o', join(root, 'test'), join(root, 'test.c')]);
    const rows = execFileSync(join(root, 'test'), { encoding: 'utf8' }).trim().split('\n').map(s => s.trim());
    expect(rows).toEqual([`0 1 64 ${'ab'.repeat(32)}`, `1 0 64 ${'ab'.repeat(32)}`, `2 0 64 ${'ab'.repeat(32)}`, '3 1 0', '4 1 0', '5 1 0', `6 0 64 ${'ab'.repeat(32)}`]);
  } finally { removeTempDirSync(root); }
});
