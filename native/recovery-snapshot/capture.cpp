#define NOMINMAX
#include "capture.h"
#include <winioctl.h>
#include <vss.h>
#include <vsserror.h>
#include <vswriter.h>
#include <vsbackup.h>
#include <sddl.h>
#include <aclapi.h>
#include <algorithm>
#include <array>
#include <cstddef>
#include <cstring>
#include <cwctype>
#include <stdexcept>
#include <utility>
#include <vector>

namespace murage::recovery {
namespace {
struct Failure { HRESULT status; };
void require(bool condition, HRESULT code = E_INVALIDARG) { if (!condition) throw Failure{code}; }
void hr(HRESULT status) { if (FAILED(status)) throw Failure{status}; }
void win(BOOL status) { if (!status) throw Failure{HRESULT_FROM_WIN32(GetLastError())}; }
struct Handle {
  HANDLE value = INVALID_HANDLE_VALUE;
  explicit Handle(HANDLE h) : value(h) { require(h != INVALID_HANDLE_VALUE, HRESULT_FROM_WIN32(GetLastError())); }
  Handle(Handle&& other) noexcept : value(std::exchange(other.value, INVALID_HANDLE_VALUE)) {}
  ~Handle() { if (value != INVALID_HANDLE_VALUE) CloseHandle(value); }
  Handle(const Handle&) = delete;
};
template<class T> struct Com {
  T* value = nullptr;
  ~Com() { if (value) value->Release(); }
};
std::wstring fold(std::wstring value) {
  std::transform(value.begin(), value.end(), value.begin(), towlower); return value;
}
bool sameIdentity(const FILE_ID_INFO& a, const FILE_ID_INFO& b) {
  return a.VolumeSerialNumber == b.VolumeSerialNumber &&
    std::memcmp(a.FileId.Identifier, b.FileId.Identifier, sizeof(a.FileId.Identifier)) == 0;
}
FILE_ID_INFO identity(HANDLE h) {
  FILE_ID_INFO result{}; win(GetFileInformationByHandleEx(h, FileIdInfo, &result, sizeof(result))); return result;
}
std::wstring finalPath(HANDLE h) {
  std::vector<wchar_t> buffer(32768);
  DWORD length = GetFinalPathNameByHandleW(h, buffer.data(), static_cast<DWORD>(buffer.size()), VOLUME_NAME_GUID);
  require(length > 0 && length < buffer.size(), HRESULT_FROM_WIN32(ERROR_BAD_PATHNAME));
  return {buffer.data(), length};
}
Handle openRead(const std::wstring& path, bool directory, bool pin = false, bool security = false) {
  Handle h(CreateFileW(path.c_str(), (directory ? FILE_READ_ATTRIBUTES : GENERIC_READ) | (pin ? FILE_LIST_DIRECTORY : 0) | (security ? READ_CONTROL : 0),
    FILE_SHARE_READ | FILE_SHARE_WRITE | (pin ? 0 : FILE_SHARE_DELETE), nullptr, OPEN_EXISTING,
    FILE_FLAG_OPEN_REPARSE_POINT | (directory ? FILE_FLAG_BACKUP_SEMANTICS : FILE_FLAG_SEQUENTIAL_SCAN), nullptr));
  FILE_ATTRIBUTE_TAG_INFO info{};
  win(GetFileInformationByHandleEx(h.value, FileAttributeTagInfo, &info, sizeof(info)));
  require(!(info.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT));
  require(bool(info.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) == directory);
  return h;
}
bool safePart(const std::wstring& name) {
  if (name.empty() || name == L"." || name == L".." || name.size() > 255 || name.back() == L'.' || name.back() == L' ') return false;
  for (wchar_t c : name) if (c < 32 || std::wstring(L"\\/:*?\"<>|").find(c) != std::wstring::npos) return false;
  const auto base = fold(name.substr(0, name.find(L'.')));
  if (base == L"con" || base == L"prn" || base == L"aux" || base == L"nul") return false;
  return !(base.size() == 4 && (base.substr(0, 3) == L"com" || base.substr(0, 3) == L"lpt") && base[3] >= L'1' && base[3] <= L'9');
}
// Pin every original DOS-path ancestor without following junctions. Refuse
// namespace, UNC and relative paths instead of normalizing ambiguous input.
std::vector<Handle> pinPath(const std::wstring& path) {
  require(path.size() > 3 && iswalpha(path[0]) && path[1] == L':' && path[2] == L'\\');
  std::vector<Handle> held;
  held.push_back(openRead(path.substr(0, 3), true, true));
  size_t from = 3;
  for (;;) {
    const auto end = path.find(L'\\', from);
    require(safePart(path.substr(from, end == std::wstring::npos ? end : end - from)));
    held.push_back(openRead(path.substr(0, end), true, true));
    if (end == std::wstring::npos) break;
    from = end + 1;
  }
  return held;
}
std::wstring volumeOf(const std::wstring& path) {
  require(path.starts_with(L"\\\\?\\Volume{"));
  const auto end = path.find(L"}\\"); require(end != std::wstring::npos);
  return path.substr(0, end + 2);
}
bool within(const std::wstring& path, const std::wstring& root) {
  const auto p = fold(path), r = fold(root); return p == r || p.starts_with(r + L"\\");
}
void checkCancel(const ApprovedCapture& request) {
  if (request.cancelEvent) {
    const auto status = WaitForSingleObject(request.cancelEvent, 0);
    require(status == WAIT_TIMEOUT, HRESULT_FROM_WIN32(status == WAIT_OBJECT_0 ? ERROR_CANCELLED : ERROR_INVALID_HANDLE));
  }
}
void awaitSnapshot(IVssAsync* async, const ApprovedCapture& request) {
  const auto started = GetTickCount64();
  for (;;) {
    try { checkCancel(request); require(GetTickCount64() - started < 120000, HRESULT_FROM_WIN32(ERROR_TIMEOUT)); }
    catch (...) { async->Cancel(); throw; }
    hr(async->Wait(250));
    HRESULT status = E_PENDING; hr(async->QueryStatus(&status, nullptr));
    if (status == VSS_S_ASYNC_FINISHED) return;
    require(status == VSS_S_ASYNC_PENDING, FAILED(status) ? status : E_ABORT);
  }
}
struct Entry { std::wstring name; DWORD attributes; DWORD reparseTag; };
std::vector<Entry> entries(const std::wstring& directory, std::uint32_t bound) {
  WIN32_FIND_DATAW data{};
  HANDLE search = FindFirstFileW((directory + L"\\*").c_str(), &data);
  if (search == INVALID_HANDLE_VALUE) {
    require(GetLastError() == ERROR_FILE_NOT_FOUND, HRESULT_FROM_WIN32(GetLastError())); return {};
  }
  struct Search { HANDLE h; ~Search() { FindClose(h); } } closer{search};
  std::vector<Entry> result;
  do {
    std::wstring name(data.cFileName);
    if (name == L"." || name == L"..") continue;
    require(safePart(name)); require(result.size() < bound, HRESULT_FROM_WIN32(ERROR_NOT_ENOUGH_QUOTA));
    result.push_back({name, data.dwFileAttributes, (data.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) ? data.dwReserved0 : 0});
  } while (FindNextFileW(search, &data));
  require(GetLastError() == ERROR_NO_MORE_FILES, HRESULT_FROM_WIN32(GetLastError()));
  std::sort(result.begin(), result.end(), [](const Entry& a, const Entry& b) { return fold(a.name) < fold(b.name); });
  for (size_t i = 1; i < result.size(); ++i) require(fold(result[i-1].name) != fold(result[i].name));
  return result;
}
// Every name server/data-dir-inventory.ts marks restorable (record, owner
// file, owner folder, database). data-dir-inventory.test.ts fails when this
// list falls behind it.
bool selected(const std::wstring& name) {
  static const std::array names = {L"config.json", L"bots.json", L"groups.json", L"routines.json", L"calendar-calls.json", L"webhooks.json", L"delegations.json", L"delegation-receipts.json", L"section-contexts.json", L"browser-cleanups.json", L"setup.json", L"queued-messages.json", L"whats-new.json", L"announcements.json", L"house-rules.md", L"house-rules.json", L"about-me.md", L"attachments", L"artifact-files", L"workspaces", L"skills", L"skill-state", L"skill-collection", L"checkpoints", L"events", L"messages.db", L"messages.db-wal", L"messages.db-shm", L"messages.db-journal", L"decisions.ndjson", L"decisions.ndjson.1"};
  if (std::find(names.begin(), names.end(), name) != names.end()) return true;
  if (!name.starts_with(L"messages-") || !name.ends_with(L".json") || name.size() <= 14) return false;
  return std::all_of(name.begin()+9, name.end()-5, [](wchar_t c) { return (c >= L'a' && c <= L'z') || (c >= L'A' && c <= L'Z') || (c >= L'0' && c <= L'9') || c == L'_' || c == L'-'; });
}
// Mount-point reparse data (ntifs.h REPARSE_DATA_BUFFER, junction arm).
struct MountPointReparse {
  DWORD tag; WORD dataLength, reserved;
  WORD substituteOffset, substituteLength, printOffset, printLength;
  wchar_t path[1];
};
std::vector<std::wstring> parts(const std::wstring& path) {
  std::vector<std::wstring> out; size_t at = 0;
  for (;;) { const auto end = path.find(L'\\', at); out.push_back(path.substr(at, end == std::wstring::npos ? end : end - at)); if (end == std::wstring::npos) return out; at = end + 1; }
}
// True only for a junction Murage itself makes for a bot's engine
// (server/skills.ts syncSkillLinks, server/procedure-bundles.ts): at
// workspaces\<bot>[\...]\.claude|.agents|.grok\skills\<name>, pointing at a
// skills folder inside this installation's own workspaces. The junction is
// read as data, never opened through. Anything else keeps being refused.
bool murageSkillLink(const std::wstring& snapshotPath, const std::wstring& relative, const Entry& entry,
                     const std::vector<std::wstring>& liveRoots, const ApprovedCapture& request) {
  if (entry.reparseTag != IO_REPARSE_TAG_MOUNT_POINT || !(entry.attributes & FILE_ATTRIBUTE_DIRECTORY)) return false;
  const auto p = parts(relative); const auto n = p.size();
  if (n < 5 || p[0] != L"workspaces" || p[n-2] != L"skills" || (p[n-3] != L".claude" && p[n-3] != L".agents" && p[n-3] != L".grok")) return false;
  Handle link(CreateFileW(snapshotPath.c_str(), FILE_READ_ATTRIBUTES | (request.callerReadToken ? READ_CONTROL : 0),
    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS, nullptr));
  if (request.callerReadToken) hr(captureReadAccess(link.value, request.callerReadToken, true));
  std::vector<BYTE> buffer(MAXIMUM_REPARSE_DATA_BUFFER_SIZE); DWORD size = 0;
  if (!DeviceIoControl(link.value, FSCTL_GET_REPARSE_POINT, nullptr, 0, buffer.data(), static_cast<DWORD>(buffer.size()), &size, nullptr)) return false;
  if (size < offsetof(MountPointReparse, path)) return false;
  const auto* data = reinterpret_cast<const MountPointReparse*>(buffer.data());
  if (data->tag != IO_REPARSE_TAG_MOUNT_POINT || data->substituteOffset % 2 || data->substituteLength % 2 ||
      offsetof(MountPointReparse, path) + size_t(data->substituteOffset) + data->substituteLength > size) return false;
  std::wstring target(data->path + data->substituteOffset / 2, data->substituteLength / 2);
  if (!target.starts_with(L"\\??\\")) return false;
  target = fold(target.substr(4));
  while (!target.empty() && target.back() == L'\\') target.pop_back();
  if (target.size() < 4 || !iswalpha(target[0]) || target[1] != L':' || target[2] != L'\\') return false;
  const auto t = parts(target.substr(3));
  if (std::any_of(t.begin(), t.end(), [](const std::wstring& part) { return !safePart(part); })) return false;
  if (std::find(t.begin(), t.end(), L"skills") == t.end()) return false;
  for (const auto& root : liveRoots) if (target.starts_with(root + L"\\workspaces\\")) return true;
  return false;
}
std::wstring portable(std::wstring relative) { std::replace(relative.begin(), relative.end(), L'\\', L'/'); return relative; }
void copyEntry(const std::wstring& source, const std::wstring& destination, bool directory,
               const ApprovedCapture& request, CaptureReceipt& receipt, unsigned depth,
               const std::wstring& relative, const std::vector<std::wstring>& liveRoots) {
  checkCancel(request);
  require(depth <= 64 && ++receipt.entries <= request.maxEntries, HRESULT_FROM_WIN32(ERROR_NOT_ENOUGH_QUOTA));
  auto input = openRead(source, directory, false, request.callerReadToken != nullptr);
  if (request.callerReadToken) hr(captureReadAccess(input.value, request.callerReadToken, directory));
  const auto id = identity(input.value);
  require(id.VolumeSerialNumber == receipt.sourceIdentity.VolumeSerialNumber);
  if (directory) {
    win(CreateDirectoryW(destination.c_str(), nullptr));
    for (const auto& entry : entries(source, request.maxEntries)) {
      const auto child = relative + L"\\" + entry.name;
      if ((entry.attributes & FILE_ATTRIBUTE_REPARSE_POINT) && murageSkillLink(source + L"\\" + entry.name, child, entry, liveRoots, request)) {
        require(++receipt.skillLinksOmitted <= request.maxEntries, HRESULT_FROM_WIN32(ERROR_NOT_ENOUGH_QUOTA));
        if (receipt.skillLinks.size() < 64) receipt.skillLinks.push_back(portable(child));
        continue; // Not copied, not followed; the clone simply lacks it.
      }
      copyEntry(source + L"\\" + entry.name, destination + L"\\" + entry.name,
        bool(entry.attributes & FILE_ATTRIBUTE_DIRECTORY), request, receipt, depth+1, child, liveRoots);
    }
    return;
  }
  BY_HANDLE_FILE_INFORMATION info{}; win(GetFileInformationByHandle(input.value, &info));
  require(info.nNumberOfLinks == 1); // External hard links are unsupported too.
  LARGE_INTEGER size{}; win(GetFileSizeEx(input.value, &size));
  require(size.QuadPart >= 0 && static_cast<std::uint64_t>(size.QuadPart) <= request.maxBytes - receipt.bytes,
    HRESULT_FROM_WIN32(ERROR_NOT_ENOUGH_QUOTA));
  Handle output(CreateFileW(destination.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr));
  std::array<char, 65536> buffer{};
  for (;;) {
    checkCancel(request);
    DWORD read = 0; win(ReadFile(input.value, buffer.data(), static_cast<DWORD>(buffer.size()), &read, nullptr));
    if (!read) break;
    require(read <= request.maxBytes - receipt.bytes, HRESULT_FROM_WIN32(ERROR_NOT_ENOUGH_QUOTA));
    DWORD written = 0; win(WriteFile(output.value, buffer.data(), read, &written, nullptr));
    require(written == read, HRESULT_FROM_WIN32(ERROR_WRITE_FAULT)); receipt.bytes += read;
  }
  win(FlushFileBuffers(output.value));
}
// Protected inheritable DACL: current requester and SYSTEM only. Eventual
// over-the-shoulder elevation needs explicit main-SID custody, not this seam.
void createPrivate(const std::wstring& path) {
  HANDLE rawToken = nullptr; win(OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &rawToken)); Handle token(rawToken);
  DWORD size = 0; GetTokenInformation(token.value, TokenUser, nullptr, 0, &size);
  require(size > 0); std::vector<BYTE> buffer(size);
  win(GetTokenInformation(token.value, TokenUser, buffer.data(), size, &size));
  LPWSTR rawSid = nullptr; win(ConvertSidToStringSidW(reinterpret_cast<TOKEN_USER*>(buffer.data())->User.Sid, &rawSid));
  struct Local { HLOCAL value; ~Local() { LocalFree(value); } } sid{rawSid};
  const std::wstring sddl = L"D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;" + std::wstring(rawSid) + L")";
  PSECURITY_DESCRIPTOR rawDescriptor = nullptr;
  win(ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.c_str(), SDDL_REVISION_1, &rawDescriptor, nullptr));
  Local descriptor{rawDescriptor}; SECURITY_ATTRIBUTES security{sizeof(SECURITY_ATTRIBUTES), rawDescriptor, FALSE};
  win(CreateDirectoryW(path.c_str(), &security));
}
}

HRESULT captureReadAccess(HANDLE object, HANDLE callerToken, bool directory) {
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  const DWORD error = GetSecurityInfo(object, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION | GROUP_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
    nullptr, nullptr, nullptr, nullptr, &descriptor);
  if (error != ERROR_SUCCESS) return HRESULT_FROM_WIN32(error);
  GENERIC_MAPPING mapping{FILE_GENERIC_READ, FILE_GENERIC_WRITE, FILE_GENERIC_EXECUTE, FILE_ALL_ACCESS};
  DWORD desired = directory ? FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | FILE_TRAVERSE : FILE_READ_DATA | FILE_READ_ATTRIBUTES;
  DWORD granted = 0, size = sizeof(PRIVILEGE_SET) + 16*sizeof(LUID_AND_ATTRIBUTES);
  std::vector<BYTE> privileges(size); BOOL allowed = FALSE;
  const BOOL checked = AccessCheck(descriptor, callerToken, desired, &mapping,
    reinterpret_cast<PRIVILEGE_SET*>(privileges.data()), &size, &granted, &allowed);
  const DWORD checkError = checked ? ERROR_SUCCESS : GetLastError(); LocalFree(descriptor);
  if (!checked) return HRESULT_FROM_WIN32(checkError);
  return allowed ? S_OK : E_ACCESSDENIED;
}

CaptureReceipt captureApprovedInstallation(const ApprovedCapture& request, SaveReceipt save, void* context) {
  CaptureReceipt receipt{}; receipt.nonce = request.nonce;
  Com<IVssBackupComponents> backup;
  bool added = false;
  try {
    require(save && request.maxBytes > 0 && request.maxBytes <= 20ull*1024*1024*1024 && request.maxEntries > 0 && request.maxEntries <= 100000);
    require(!IsEqualGUID(request.nonce, GUID_NULL)); checkCancel(request);
    const auto journal = request.restoreJournalLeaf;
    require(journal.starts_with(L".murage-data-owner-") && journal.ends_with(L".lease.restore.json") && safePart(journal));
    const auto digest = journal.substr(19, journal.size() - 19 - 19);
    require(digest.size() == 64 && std::all_of(digest.begin(), digest.end(), [](wchar_t c) { return (c >= L'0' && c <= L'9') || (c >= L'a' && c <= L'f'); }));
    auto sourcePins = pinPath(request.source);
    receipt.sourceIdentity = identity(sourcePins.back().value);
    require(sameIdentity(receipt.sourceIdentity, request.sourceIdentity), HRESULT_FROM_WIN32(ERROR_FILE_INVALID));
    const auto source = finalPath(sourcePins.back().value); receipt.volume = volumeOf(source);
    require(GetDriveTypeW(receipt.volume.c_str()) == DRIVE_FIXED);
    wchar_t filesystem[64]{};
    win(GetVolumeInformationW(receipt.volume.c_str(), nullptr, 0, nullptr, nullptr, nullptr, filesystem, 64));
    require(fold(filesystem) == L"ntfs");
    const auto relative = source.substr(receipt.volume.size()); require(!relative.empty());
    const auto split = request.destination.find_last_of(L'\\'); require(split != std::wstring::npos && safePart(request.destination.substr(split+1)));
    auto destinationPins = pinPath(request.destination.substr(0, split));
    if (request.bindDestinationParent) require(sameIdentity(identity(destinationPins.back().value), request.destinationParentIdentity), HRESULT_FROM_WIN32(ERROR_FILE_INVALID));
    const auto destination = finalPath(destinationPins.back().value) + L"\\" + request.destination.substr(split+1);
    require(!within(destination, source) && !within(source, destination));
    ULARGE_INTEGER free{}; win(GetDiskFreeSpaceExW(finalPath(destinationPins.back().value).c_str(), &free, nullptr, nullptr));
    require(free.QuadPart >= request.maxBytes + 1024ull*1024*1024, HRESULT_FROM_WIN32(ERROR_DISK_FULL));
    hr(CreateVssBackupComponents(&backup.value)); hr(backup.value->InitializeForBackup());
    hr(backup.value->SetContext(VSS_CTX_FILE_SHARE_BACKUP));
    BOOL supported = FALSE; hr(backup.value->IsVolumeSupported(GUID_NULL, const_cast<wchar_t*>(receipt.volume.c_str()), &supported)); require(supported, HRESULT_FROM_WIN32(ERROR_NOT_SUPPORTED));
    VSS_ID set{}; hr(backup.value->StartSnapshotSet(&set));
    hr(backup.value->AddToSnapshotSet(const_cast<wchar_t*>(receipt.volume.c_str()), GUID_NULL, &receipt.snapshotId)); added = true;
    save(receipt, context);
    Com<IVssAsync> operation; hr(backup.value->DoSnapshotSet(&operation.value)); awaitSnapshot(operation.value, request);
    VSS_SNAPSHOT_PROP properties{}; hr(backup.value->GetSnapshotProperties(receipt.snapshotId, &properties));
    struct Properties { VSS_SNAPSHOT_PROP* p; ~Properties() { VssFreeSnapshotProperties(p); } } releaseProperties{&properties};
    require(properties.m_pwszSnapshotDeviceObject && properties.m_pwszOriginalVolumeName && fold(properties.m_pwszOriginalVolumeName) == fold(receipt.volume));
    require(IsEqualGUID(properties.m_SnapshotId, receipt.snapshotId));
    const std::wstring snapshot = std::wstring(properties.m_pwszSnapshotDeviceObject) + L"\\" + relative;
    auto capturedRoot = openRead(snapshot, true, false, request.callerReadToken != nullptr);
    if (request.callerReadToken) hr(captureReadAccess(capturedRoot.value, request.callerReadToken, true));
    require(sameIdentity(identity(capturedRoot.value), receipt.sourceIdentity), HRESULT_FROM_WIN32(ERROR_FILE_INVALID));
    require(sameIdentity(identity(sourcePins.back().value), request.sourceIdentity) && finalPath(sourcePins.back().value) == source);
    receipt.captureTime = properties.m_tsCreationTimestamp; save(receipt, context);
    // Read the one exact sibling restore marker from the SAME snapshot epoch.
    const auto parent = snapshot.substr(0, snapshot.find_last_of(L'\\'));
    const auto marker = GetFileAttributesW((parent + L"\\" + journal).c_str());
    require(marker == INVALID_FILE_ATTRIBUTES && GetLastError() == ERROR_FILE_NOT_FOUND, HRESULT_FROM_WIN32(ERROR_TRANSACTION_NOT_ACTIVE));
    const auto names = entries(snapshot, request.maxEntries);
    for (const auto& entry : names) {
      const auto name = fold(entry.name);
      require(name != L".package-import-transaction" && name != L"vm-home" && name != L"vm-homes", HRESULT_FROM_WIN32(ERROR_NOT_SUPPORTED));
      if (selected(name)) require(name == entry.name && !(entry.attributes & FILE_ATTRIBUTE_REPARSE_POINT));
    }
    // The live data folder in every spelling a junction may carry: as the
    // caller gave it and as the file system names it (case-folded, without
    // the \\?\ prefix).
    std::vector<std::wstring> liveRoots{fold(request.source)};
    { std::vector<wchar_t> dos(32768); const DWORD length = GetFinalPathNameByHandleW(sourcePins.back().value, dos.data(), static_cast<DWORD>(dos.size()), VOLUME_NAME_DOS);
      if (length > 0 && length < dos.size()) { std::wstring path(dos.data(), length); if (path.starts_with(L"\\\\?\\") && !path.starts_with(L"\\\\?\\UNC\\")) path = path.substr(4); liveRoots.push_back(fold(path)); } }
    for (auto& root : liveRoots) while (!root.empty() && root.back() == L'\\') root.pop_back();
    checkCancel(request); createPrivate(destination);
    auto privatePin = openRead(destination, true, true);
    for (const auto& entry : names) if (selected(entry.name))
      copyEntry(snapshot + L"\\" + entry.name, destination + L"\\" + entry.name,
        bool(entry.attributes & FILE_ATTRIBUTE_DIRECTORY), request, receipt, 0, entry.name, liveRoots);
    checkCancel(request); receipt.copyComplete = true; receipt.status = S_OK;
  } catch (const Failure& failure) { receipt.status = failure.status; }
    catch (...) { receipt.status = E_FAIL; }
  if (added) {
    LONG deleted = 0; VSS_ID retained{};
    receipt.cleanupStatus = backup.value->DeleteSnapshots(receipt.snapshotId, VSS_OBJECT_SNAPSHOT, FALSE, &deleted, &retained);
    receipt.snapshotReleased = (SUCCEEDED(receipt.cleanupStatus) && deleted == 1) || receipt.cleanupStatus == VSS_E_OBJECT_NOT_FOUND;
    if (!receipt.snapshotReleased && SUCCEEDED(receipt.status)) receipt.status = FAILED(receipt.cleanupStatus) ? receipt.cleanupStatus : E_FAIL;
    // Releasing the object also auto-releases this nonpersistent snapshot. An
    // explicit deletion failure stays visible; no global query/delete fallback.
  }
  if (save) { try { save(receipt, context); } catch (...) { receipt.status = E_FAIL; } }
  return receipt;
}
}
