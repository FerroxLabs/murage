#pragma once
#include <windows.h>
#include <string>
#include <cstdint>

namespace murage::recovery {
// Internal native seam ONLY. Not a CLI, RPC endpoint, Node export or elevation
// broker. The eventual launcher must authenticate one main-owned capability.
struct ApprovedCapture {
  std::wstring source; // Absolute DOS path, resolved/confirmed by trusted main.
  FILE_ID_INFO sourceIdentity{}; // Bound at confirmation, checked before VSS.
  std::wstring destination; // New child of a trusted, private destination parent.
  std::wstring restoreJournalLeaf; // Exact dataDirLeasePaths source sibling name.
  GUID nonce{};
  HANDLE cancelEvent = nullptr;
  std::uint64_t maxBytes = 20ull * 1024 * 1024 * 1024;
  std::uint32_t maxEntries = 100000;
};
struct CaptureReceipt {
  GUID nonce{}, snapshotId{};
  FILE_ID_INFO sourceIdentity{};
  std::wstring volume;
  LONGLONG captureTime = 0; // VSS timestamp; crash-consistent, no writers involved.
  std::uint64_t bytes = 0;
  std::uint32_t entries = 0;
  bool copyComplete = false; // Never implies archive validation or activation.
  bool snapshotReleased = false;
  HRESULT cleanupStatus = S_OK;
  HRESULT status = E_PENDING;
};
// Must durably record only bounded receipt facts in task-owned storage. Called
// before copying and after cleanup; failures stop capture, retaining partial data.
using SaveReceipt = void (*)(const CaptureReceipt&, void*);
// Caller supplies COM initialized as MTA with VSS requester COM security. No
// service/configuration changes, token privilege grants, elevation or source writes.
CaptureReceipt captureApprovedInstallation(const ApprovedCapture&, SaveReceipt, void*);
}
