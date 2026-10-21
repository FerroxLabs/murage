// The LSA policy read (domainSids), kept in its own translation unit: <ntsecapi.h> and <winternl.h> both define UNICODE_STRING,
// STRING and their pointer types, which MSVC with the Windows SDK rejects (C2371) when one file includes both. This header uses
// only <windows.h> types and no NT string types, so exclusion.c can include <winternl.h> and call this without <ntsecapi.h>.
#ifndef MURAGE_EXCLUSION_LSA_H
#define MURAGE_EXCLUSION_LSA_H
#include <windows.h>

typedef struct MurLsaDomainSids {
  BOOL has_account;            // account_sid holds this computer's own account-domain SID
  BYTE account_sid[SECURITY_MAX_SID_SIZE];
  BOOL has_primary;            // primary_sid holds the joined domain's SID
  BYTE primary_sid[SECURITY_MAX_SID_SIZE];
  BOOL forest_present;         // the policy names a forest (and a primary domain exists)
  BOOL forest_is_domain;       // the forest's DNS name equals the domain's own (case-insensitive)
  BOOL forest_too_long;        // the forest name did not fit forest_name
  wchar_t forest_name[257];    // NUL-ended forest DNS name when forest_present && !forest_is_domain && !forest_too_long
} MurLsaDomainSids;

/** Reads this computer's LSA policy into *out. Returns 0 on success, nonzero when the policy could not be read. */
int mur_lsa_domain_sids(MurLsaDomainSids *out);
#endif
