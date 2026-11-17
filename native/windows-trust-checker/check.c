// Checker source owner: win-sac-sign; reviewed build, toolchain pin and binary approval owner: MAIN.
// Standalone executable: never load the target PE or bootstrap through an addon.
#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif
#include <windows.h>
#include <wincrypt.h>
#include <wintrust.h>
#include <softpub.h>
#include <aclapi.h>
#include <stdio.h>
#include <string.h>
#include <stdlib.h>

static BOOL trusted_owner(PSID sid) {
  if (IsWellKnownSid(sid, WinLocalSystemSid) || IsWellKnownSid(sid, WinBuiltinAdministratorsSid)) return TRUE;
  BYTE service[SECURITY_MAX_SID_SIZE];
  wchar_t domain[256];
  DWORD size = sizeof service, domain_size = 256;
  SID_NAME_USE use;
  return LookupAccountNameW(NULL, L"NT SERVICE\\TrustedInstaller", service, &size, domain, &domain_size, &use) && EqualSid(sid, service);
}
// Reject unprivileged write grants and the signing identity's effective write
// access, including ancestor replacement. Unavailable ACLs/tokens fail closed.
static BOOL user_writable(const wchar_t *target) {
  HANDLE process_token = NULL, token = NULL;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY | TOKEN_DUPLICATE, &process_token)) return TRUE;
  BOOL duplicated = DuplicateToken(process_token, SecurityImpersonation, &token);
  CloseHandle(process_token);
  if (!duplicated) return TRUE;
  wchar_t current[32768];
  DWORD length = GetFullPathNameW(target, 32768, current, NULL);
  BOOL unsafe = !length || length >= 32768;
  unsigned depth = 0;
  while (!unsafe) {
    DWORD attributes = GetFileAttributesW(current);
    PSECURITY_DESCRIPTOR descriptor = NULL;
    PSID owner = NULL;
    PACL acl = NULL;
    if (attributes == INVALID_FILE_ATTRIBUTES || (attributes & FILE_ATTRIBUTE_REPARSE_POINT)
      || GetNamedSecurityInfoW(current, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION | GROUP_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
        &owner, NULL, &acl, NULL, &descriptor) != ERROR_SUCCESS) { unsafe = TRUE; break; }
    GENERIC_MAPPING mapping = { FILE_GENERIC_READ, FILE_GENERIC_WRITE, FILE_GENERIC_EXECUTE, FILE_ALL_ACCESS };
    DWORD writes = FILE_WRITE_DATA | FILE_APPEND_DATA | FILE_WRITE_EA | FILE_WRITE_ATTRIBUTES | DELETE | WRITE_DAC | WRITE_OWNER;
    if (attributes & FILE_ATTRIBUTE_DIRECTORY) writes = FILE_DELETE_CHILD | DELETE | WRITE_DAC | WRITE_OWNER
      | (depth == 1 ? FILE_ADD_FILE | FILE_ADD_SUBDIRECTORY | FILE_WRITE_EA | FILE_WRITE_ATTRIBUTES : 0);
    if (!owner || !trusted_owner(owner) || !acl) unsafe = TRUE;
    for (DWORD i = 0; !unsafe && i < acl->AceCount; ++i) {
      ACCESS_ALLOWED_ACE *ace = NULL;
      if (!GetAce(acl, i, (void **)&ace)) { unsafe = TRUE; break; }
      if (ace->Header.AceFlags & INHERIT_ONLY_ACE) continue;
      if (ace->Header.AceType == ACCESS_DENIED_ACE_TYPE) continue;
      if (ace->Header.AceType != ACCESS_ALLOWED_ACE_TYPE) { unsafe = TRUE; break; }
      DWORD mask = ace->Mask;
      MapGenericMask(&mask, &mapping);
      if ((mask & writes) && !trusted_owner(&ace->SidStart)) unsafe = TRUE;
    }
    PRIVILEGE_SET privileges;
    DWORD size = sizeof privileges, granted = 0;
    BOOL allowed = FALSE;
    BOOL checked = AccessCheck(descriptor, token, MAXIMUM_ALLOWED, &mapping, &privileges, &size, &granted, &allowed);
    LocalFree(descriptor);
    if (!checked || !allowed || (granted & writes)) { unsafe = TRUE; break; }
    wchar_t *slash = wcsrchr(current, L'\\');
    if (!slash || slash == current || (wcslen(current) == 3 && current[1] == L':')) break;
    if (slash == current + 2 && current[1] == L':') slash[1] = 0;
    else *slash = 0;
    ++depth;
  }
  CloseHandle(token);
  return unsafe;
}

static const char *status_name(LONG result) {
  switch (result) {
    case ERROR_SUCCESS: return "Valid";
    case TRUST_E_NOSIGNATURE: return "NotSigned";
    case TRUST_E_BAD_DIGEST: case CRYPT_E_HASH_VALUE: return "HashMismatch";
    case CERT_E_UNTRUSTEDROOT: case CERT_E_CHAINING: case CERT_E_UNTRUSTEDTESTROOT:
    case TRUST_E_EXPLICIT_DISTRUST: case TRUST_E_SUBJECT_NOT_TRUSTED:
    case CERT_E_REVOKED: case CERT_E_EXPIRED: return "NotTrusted";
    default: return "UnknownError";
  }
}
static void json_string(const wchar_t *wide) {
  char text[4096];
  int size = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, wide, -1, text, sizeof text, NULL, NULL);
  putchar('"');
  if (size > 0) for (int i = 0; i < size - 1; ++i) {
    unsigned char c = (unsigned char)text[i];
    if (c == '"' || c == '\\') { putchar('\\'); putchar(c); }
    else if (c < 0x20) printf("\\u%04x", c);
    else putchar(c);
  }
  putchar('"');
}
int wmain(int argc, wchar_t **argv) {
  BOOL launch = argc == 3 && wcscmp(argv[1], L"--launch") == 0;
  if (argc != 2 && !launch) return 2;
  const wchar_t *target = argv[launch ? 2 : 1];
  // Keep one handle open without write/delete sharing across trust inspection.
  HANDLE handle = CreateFileW(target, GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING,
    FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, NULL);
  if (handle == INVALID_HANDLE_VALUE) return 3;
  BY_HANDLE_FILE_INFORMATION info;
  if (!GetFileInformationByHandle(handle, &info) || info.nNumberOfLinks != 1
      || (info.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT))) {
    CloseHandle(handle); return 3;
  }
  HCERTSTORE store = NULL;
  HCRYPTMSG message = NULL;
  BOOL embedded = CryptQueryObject(CERT_QUERY_OBJECT_FILE, target, CERT_QUERY_CONTENT_FLAG_PKCS7_SIGNED_EMBED,
    CERT_QUERY_FORMAT_FLAG_BINARY, 0, NULL, NULL, NULL, &store, &message, NULL);
  if (message) CryptMsgClose(message);
  if (store) CertCloseStore(store, 0);
  WINTRUST_FILE_INFO file;
  WINTRUST_DATA trust;
  memset(&file, 0, sizeof file); memset(&trust, 0, sizeof trust);
  file.cbStruct = sizeof file; file.pcwszFilePath = target; file.hFile = handle;
  trust.cbStruct = sizeof trust; trust.dwUIChoice = WTD_UI_NONE;
  trust.fdwRevocationChecks = WTD_REVOKE_WHOLECHAIN;
  trust.dwProvFlags = WTD_REVOCATION_CHECK_CHAIN_EXCLUDE_ROOT;
  trust.dwUnionChoice = WTD_CHOICE_FILE; trust.pFile = &file; trust.dwStateAction = WTD_STATEACTION_VERIFY;
  GUID action = WINTRUST_ACTION_GENERIC_VERIFY_V2;
  LONG result = WinVerifyTrust((HWND)INVALID_HANDLE_VALUE, &action, &trust);
  wchar_t publisher[512] = {0};
  wchar_t subject[4096] = {0}, issuer[4096] = {0};
  BYTE certificate_hash[32] = {0};
  PCERT_ENHKEY_USAGE usage = NULL;
  BOOL certificate_identity = FALSE;
  BOOL timestamp = FALSE;
  if (result == ERROR_SUCCESS) {
    CRYPT_PROVIDER_DATA *provider = WTHelperProvDataFromStateData(trust.hWVTStateData);
    CRYPT_PROVIDER_SGNR *signer = provider ? WTHelperGetProvSignerFromChain(provider, 0, FALSE, 0) : NULL;
    CRYPT_PROVIDER_CERT *leaf = signer ? WTHelperGetProvCertFromChain(signer, 0) : NULL;
    if (signer && signer->csCounterSigners > 0) {
      CRYPT_PROVIDER_SGNR *counter = WTHelperGetProvSignerFromChain(provider, 0, TRUE, 0);
      timestamp = counter && counter->dwError == ERROR_SUCCESS;
    }
    DWORD count = leaf && leaf->pCert ? CertGetNameStringW(leaf->pCert, CERT_NAME_SIMPLE_DISPLAY_TYPE,
      0, NULL, publisher, 512) : 0;
    if (count <= 1 || count >= 512) { publisher[0] = 0; result = TRUST_E_NO_SIGNER_CERT; }
    if (leaf && leaf->pCert) {
      PCCERT_CONTEXT certificate = leaf->pCert;
      DWORD hash_size = sizeof certificate_hash, usage_size = 0;
      DWORD subject_size = CertNameToStrW(X509_ASN_ENCODING, &certificate->pCertInfo->Subject,
        CERT_X500_NAME_STR | CERT_NAME_STR_REVERSE_FLAG, subject, 4096);
      DWORD issuer_size = CertNameToStrW(X509_ASN_ENCODING, &certificate->pCertInfo->Issuer,
        CERT_X500_NAME_STR | CERT_NAME_STR_REVERSE_FLAG, issuer, 4096);
      if (subject_size > 1 && subject_size < 4096 && issuer_size > 1 && issuer_size < 4096
        && CryptHashCertificate2(L"SHA256", 0, NULL, certificate->pbCertEncoded, certificate->cbCertEncoded, certificate_hash, &hash_size)
        && hash_size == sizeof certificate_hash && CertGetEnhancedKeyUsage(certificate, 0, NULL, &usage_size)
        && usage_size >= sizeof(CERT_ENHKEY_USAGE) && usage_size <= 65536) {
        usage = malloc(usage_size);
        certificate_identity = usage && CertGetEnhancedKeyUsage(certificate, 0, usage, &usage_size);
      }
    }
    if (!certificate_identity) result = TRUST_E_NO_SIGNER_CERT;
  }
  trust.dwStateAction = WTD_STATEACTION_CLOSE;
  WinVerifyTrust((HWND)INVALID_HANDLE_VALUE, &action, &trust);
  CloseHandle(handle);
  // Catalog-only trust is deliberately not a Valid verdict for this contract.
  if (!embedded && result == ERROR_SUCCESS) result = TRUST_E_SUBJECT_NOT_TRUSTED;
  printf("{\"status\":\"%s\",\"embedded\":%s,\"publisher\":", status_name(result), embedded ? "true" : "false");
  json_string(publisher);
  printf(",\"timestamp\":%s", timestamp ? "true" : "false");
  if (certificate_identity) {
    printf(",\"subjectDn\":"); json_string(subject);
    printf(",\"issuerDn\":"); json_string(issuer);
    printf(",\"leafCertificateSha256\":\"");
    for (unsigned i = 0; i < sizeof certificate_hash; ++i) printf("%02x", certificate_hash[i]);
    printf("\",\"ekus\":[");
    for (DWORD i = 0; i < usage->cUsageIdentifier; ++i) {
      if (i) putchar(',');
      /* OIDs contain only digits and dots; refuse malformed certificate strings. */
      const char *oid = usage->rgpszUsageIdentifier[i];
      if (!oid || strspn(oid, "0123456789.") != strlen(oid)) { free(usage); return 5; }
      printf("\"%s\"", oid);
    }
    putchar(']');
  }
  free(usage);
  if (launch) printf(",\"userWritable\":%s", user_writable(target) ? "true" : "false");
  puts("}");
  return ferror(stdout) ? 4 : 0;
}
