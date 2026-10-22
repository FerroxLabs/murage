// LSA policy read for exclusion.c's domainSids(). Includes <windows.h> and <ntsecapi.h> only (never <winternl.h>); see exclusion-lsa.h.
#include <windows.h>
#include <ntsecapi.h>
#include <string.h>
#include <wchar.h>
#include "exclusion-lsa.h"
#pragma comment(lib, "advapi32.lib")

static BOOL copy_sid(PSID sid, BYTE *dest) {
  if (!sid || !IsValidSid(sid)) return FALSE;
  return CopySid(SECURITY_MAX_SID_SIZE, (PSID)dest, sid) ? TRUE : FALSE;
}

int mur_lsa_domain_sids(MurLsaDomainSids *out) {
  LSA_OBJECT_ATTRIBUTES attributes;
  LSA_HANDLE policy = NULL;
  memset(out, 0, sizeof *out);
  memset(&attributes, 0, sizeof attributes);
  if (LsaOpenPolicy(NULL, &attributes, POLICY_VIEW_LOCAL_INFORMATION, &policy) != 0) return 1;
  PPOLICY_ACCOUNT_DOMAIN_INFO account = NULL;
  PPOLICY_DNS_DOMAIN_INFO dns = NULL;
  NTSTATUS a = LsaQueryInformationPolicy(policy, PolicyAccountDomainInformation, (PVOID *)&account);
  NTSTATUS d = LsaQueryInformationPolicy(policy, PolicyDnsDomainInformation, (PVOID *)&dns);
  LsaClose(policy);
  if (a != 0 || d != 0) {
    if (account) LsaFreeMemory(account);
    if (dns) LsaFreeMemory(dns);
    return 1;
  }
  out->has_account = copy_sid(account->DomainSid, out->account_sid);
  out->has_primary = copy_sid(dns->Sid, out->primary_sid);
  if (out->has_primary && dns->DnsForestName.Buffer && dns->DnsForestName.Length > 0) {
    size_t forest_chars = dns->DnsForestName.Length / sizeof(wchar_t), domain_chars = dns->DnsDomainName.Buffer ? dns->DnsDomainName.Length / sizeof(wchar_t) : 0;
    out->forest_present = TRUE;
    if (forest_chars == domain_chars && _wcsnicmp(dns->DnsForestName.Buffer, dns->DnsDomainName.Buffer, forest_chars) == 0) out->forest_is_domain = TRUE;
    else if (forest_chars < 256) {
      memcpy(out->forest_name, dns->DnsForestName.Buffer, forest_chars * sizeof(wchar_t));
      out->forest_name[forest_chars] = L'\0';
    } else out->forest_too_long = TRUE;
  }
  LsaFreeMemory(account);
  LsaFreeMemory(dns);
  return 0;
}
