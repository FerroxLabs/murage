// Synthetic qualification fixture only; not a packaged helper or product bypass.
#define NOMINMAX
#define _WIN32_WINNT 0x0603
#include <windows.h>
#include <sddl.h>
#include <aclapi.h>
#include <tlhelp32.h>
#include <processsnapshot.h>
#include <filesystem>
#include <array>
#include <cstring>
#include <iostream>
#include <string>
#include <vector>

namespace fs = std::filesystem;
struct H { HANDLE h = nullptr; explicit H(HANDLE p = nullptr) : h(p) {} ~H() { if (h && h != INVALID_HANDLE_VALUE) CloseHandle(h); } H(const H&) = delete; };
void check(bool okay) { if (!okay) throw GetLastError(); }
std::wstring own() { wchar_t p[32768]{}; check(GetModuleFileNameW(nullptr, p, 32768) > 0); return p; }
std::wstring root() { return fs::path(own()).parent_path().wstring(); }
void scoped(const std::wstring& p) { check(p.starts_with(root() + L"\\") && p.find(L"..") == std::wstring::npos); }
std::wstring quoted(const std::wstring& s) { check(s.find(L'"') == std::wstring::npos && s.back() != L'\\'); return L"\"" + s + L"\""; }
std::vector<BYTE> information(HANDLE token, TOKEN_INFORMATION_CLASS type) {
  DWORD n = 0; GetTokenInformation(token, type, nullptr, 0, &n); check(n > 0); std::vector<BYTE> data(n);
  check(GetTokenInformation(token, type, data.data(), n, &n)); return data;
}
std::wstring sidText(PSID sid) { LPWSTR p = nullptr; check(ConvertSidToStringSidW(sid, &p)); std::wstring s(p); LocalFree(p); return s; }
void tokenReport(HANDLE t, const char* event) {
  const auto elevation = information(t, TokenElevation), integrity = information(t, TokenIntegrityLevel), dacl = information(t, TokenDefaultDacl);
  auto* label = reinterpret_cast<const TOKEN_MANDATORY_LABEL*>(integrity.data());
  const auto level = *GetSidSubAuthority(label->Label.Sid, *GetSidSubAuthorityCount(label->Label.Sid) - 1);
  const auto* defaultAcl = reinterpret_cast<const TOKEN_DEFAULT_DACL*>(dacl.data());
  BOOL inJob = FALSE; check(IsProcessInJob(GetCurrentProcess(), nullptr, &inJob));
  std::cout << "{\"event\":\"" << event << "\",\"elevated\":" << reinterpret_cast<const TOKEN_ELEVATION*>(elevation.data())->TokenIsElevated
    << ",\"integrity\":" << level << ",\"defaultDaclAces\":" << (defaultAcl->DefaultDacl ? defaultAcl->DefaultDacl->AceCount : 0) << ",\"inJob\":" << bool(inJob) << "}" << std::endl;
}
int restricted(bool inertOnly = false) {
  HANDLE raw = nullptr; check(OpenProcessToken(GetCurrentProcess(), TOKEN_ALL_ACCESS, &raw)); H token(raw); tokenReport(token.h, "launcher-token");
  HANDLE childToken = nullptr;
  check(CreateRestrictedToken(token.h, LUA_TOKEN | DISABLE_MAX_PRIVILEGE, 0, nullptr, 0, nullptr, 0, nullptr, &childToken)); H limited(childToken);
  PSID medium = nullptr; check(ConvertStringSidToSidW(L"S-1-16-8192", &medium));
  TOKEN_MANDATORY_LABEL label{{medium, SE_GROUP_INTEGRITY}};
  const BOOL set = SetTokenInformation(limited.h, TokenIntegrityLevel, &label, sizeof(label) + GetLengthSid(medium)); LocalFree(medium); check(set);
  tokenReport(limited.h, "restricted-token"); const auto elevation = information(limited.h, TokenElevation);
  check(!reinterpret_cast<const TOKEN_ELEVATION*>(elevation.data())->TokenIsElevated);
  const auto script = root() + L"\\native-fixture.mjs"; scoped(script);
  const std::wstring node = inertOnly ? own() : L"C:\\Program Files\\nodejs\\node.exe";
  std::wstring command = quoted(node) + (inertOnly ? L" --inert" : L" " + quoted(script));
  STARTUPINFOW startup{sizeof(startup)}; startup.dwFlags = STARTF_USESTDHANDLES;
  HANDLE in = nullptr, out = nullptr, err = nullptr;
  DWORD stdoutFlags = 0; check(GetHandleInformation(GetStdHandle(STD_OUTPUT_HANDLE), &stdoutFlags));
  std::cout << "{\"event\":\"launcher-stdio\",\"originalStdoutInheritable\":" << bool(stdoutFlags & HANDLE_FLAG_INHERIT) << "}" << std::endl;
  check(DuplicateHandle(GetCurrentProcess(), GetStdHandle(STD_INPUT_HANDLE), GetCurrentProcess(), &in, 0, TRUE, DUPLICATE_SAME_ACCESS)); H inheritedIn(in);
  check(DuplicateHandle(GetCurrentProcess(), GetStdHandle(STD_OUTPUT_HANDLE), GetCurrentProcess(), &out, 0, TRUE, DUPLICATE_SAME_ACCESS)); H inheritedOut(out);
  check(DuplicateHandle(GetCurrentProcess(), GetStdHandle(STD_ERROR_HANDLE), GetCurrentProcess(), &err, 0, TRUE, DUPLICATE_SAME_ACCESS)); H inheritedErr(err);
  startup.hStdInput = in; startup.hStdOutput = out; startup.hStdError = err;
  PROCESS_INFORMATION child{};
  H job(CreateJobObjectW(nullptr, nullptr)); check(job.h); JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE; check(SetInformationJobObject(job.h, JobObjectExtendedLimitInformation, &limits, sizeof(limits)));
  check(CreateProcessAsUserW(limited.h, node.c_str(), command.data(), nullptr, nullptr, TRUE, CREATE_NO_WINDOW | CREATE_SUSPENDED, nullptr, root().c_str(), &startup, &child));
  H process(child.hProcess), thread(child.hThread);
  if (!AssignProcessToJobObject(job.h, process.h)) { const auto error = GetLastError(); TerminateProcess(process.h, 75); WaitForSingleObject(process.h, 5000); throw error; }
  check(ResumeThread(thread.h) != static_cast<DWORD>(-1));
  if (WaitForSingleObject(process.h, 10 * 60 * 1000) != WAIT_OBJECT_0) { TerminateProcess(process.h, 74); WaitForSingleObject(process.h, 5000); return 74; }
  DWORD code = 74; check(GetExitCodeProcess(process.h, &code)); std::cout << "{\"event\":\"fixture-child-close\",\"exit\":" << code << "}" << std::endl; return static_cast<int>(code);
}
int limitedSession(bool guardOnly = false) {
  HANDLE rawToken = nullptr; check(OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &rawToken)); H token(rawToken); tokenReport(token.h, "genuine-limited-launcher-token");
  const auto elevation = information(token.h, TokenElevation), integrity = information(token.h, TokenIntegrityLevel);
  const auto* label = reinterpret_cast<const TOKEN_MANDATORY_LABEL*>(integrity.data());
  check(!reinterpret_cast<const TOKEN_ELEVATION*>(elevation.data())->TokenIsElevated);
  check(*GetSidSubAuthority(label->Label.Sid, *GetSidSubAuthorityCount(label->Label.Sid) - 1) == 8192);
  const std::wstring node = L"C:\\Program Files\\nodejs\\node.exe";
  std::wstring command = quoted(node) + L" " + quoted(root() + (guardOnly ? L"\\guard-diagnostic.mjs" : L"\\native-fixture.mjs"));
  HANDLE in = nullptr, out = nullptr, err = nullptr;
  H nullInput(CreateFileW(L"NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr)); check(nullInput.h != INVALID_HANDLE_VALUE);
  check(DuplicateHandle(GetCurrentProcess(), nullInput.h, GetCurrentProcess(), &in, 0, TRUE, DUPLICATE_SAME_ACCESS)); H inheritedIn(in);
  check(DuplicateHandle(GetCurrentProcess(), GetStdHandle(STD_OUTPUT_HANDLE), GetCurrentProcess(), &out, 0, TRUE, DUPLICATE_SAME_ACCESS)); H inheritedOut(out);
  check(DuplicateHandle(GetCurrentProcess(), GetStdHandle(STD_ERROR_HANDLE), GetCurrentProcess(), &err, 0, TRUE, DUPLICATE_SAME_ACCESS)); H inheritedErr(err);
  STARTUPINFOW startup{sizeof(startup)}; startup.dwFlags = STARTF_USESTDHANDLES; startup.hStdInput = in; startup.hStdOutput = out; startup.hStdError = err;
  H job(CreateJobObjectW(nullptr, nullptr)); check(job.h); JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE; check(SetInformationJobObject(job.h, JobObjectExtendedLimitInformation, &limits, sizeof(limits)));
  PROCESS_INFORMATION child{};
  check(CreateProcessW(node.c_str(), command.data(), nullptr, nullptr, TRUE, CREATE_NO_WINDOW | CREATE_SUSPENDED, nullptr, root().c_str(), &startup, &child));
  H process(child.hProcess), thread(child.hThread);
  if (!AssignProcessToJobObject(job.h, process.h)) { const auto error = GetLastError(); TerminateProcess(process.h, 75); WaitForSingleObject(process.h, 5000); throw error; }
  check(ResumeThread(thread.h) != static_cast<DWORD>(-1));
  if (WaitForSingleObject(process.h, guardOnly ? 3 * 60 * 1000 : 10 * 60 * 1000) != WAIT_OBJECT_0) { TerminateJobObject(job.h, 74); WaitForSingleObject(process.h, 5000); return 74; }
  DWORD code = 74; check(GetExitCodeProcess(process.h, &code)); std::cout << "{\"event\":\"genuine-limited-child-close\",\"exit\":" << code << "}" << std::endl; return static_cast<int>(code);
}
void aclProbe(const std::wstring& path) {
  scoped(path); PSECURITY_DESCRIPTOR descriptor = nullptr; PACL acl = nullptr;
  check(GetNamedSecurityInfoW(const_cast<LPWSTR>(path.c_str()), SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, nullptr, nullptr, &acl, nullptr, &descriptor) == ERROR_SUCCESS);
  SECURITY_DESCRIPTOR_CONTROL control{}; DWORD revision = 0; check(GetSecurityDescriptorControl(descriptor, &control, &revision));
  HANDLE raw = nullptr; check(OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY | TOKEN_DUPLICATE, &raw)); H token(raw);
  auto user = information(token.h, TokenUser); auto current = sidText(reinterpret_cast<TOKEN_USER*>(user.data())->User.Sid);
  bool principals = acl && acl->AceCount == 2;
  for (DWORD i = 0; acl && i < acl->AceCount; ++i) {
    void* p = nullptr; check(GetAce(acl, i, &p)); auto* ace = static_cast<ACCESS_ALLOWED_ACE*>(p);
    const auto s = sidText(&ace->SidStart);
    principals = principals && ace->Header.AceType == ACCESS_ALLOWED_ACE_TYPE && (s == current || s == L"S-1-5-18");
  }
  PSID world = nullptr; check(ConvertStringSidToSidW(L"S-1-1-0", &world)); SID_AND_ATTRIBUTES restricting{world, 0}; HANDLE restricted = nullptr;
  check(CreateRestrictedToken(token.h, DISABLE_MAX_PRIVILEGE, 0, nullptr, 0, nullptr, 1, &restricting, &restricted)); H denied(restricted); LocalFree(world);
  check(ImpersonateLoggedOnUser(denied.h));
  HANDLE attempted = CreateFileW(path.c_str(), FILE_LIST_DIRECTORY, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, nullptr);
  DWORD failure = attempted == INVALID_HANDLE_VALUE ? GetLastError() : 0; if (attempted != INVALID_HANDLE_VALUE) CloseHandle(attempted); check(RevertToSelf());
  std::cout << "{\"protected\":" << bool(control & SE_DACL_PROTECTED) << ",\"exactPrincipals\":" << principals << ",\"restrictedAccessError\":" << failure << "}" << std::endl;
  LocalFree(descriptor);
}
void mutation(const std::wstring& operation, const std::wstring& path) {
  scoped(path); BOOL okay = FALSE; DWORD failure = 0;
  const DWORD attributes = GetFileAttributesW(path.c_str()); check(attributes != INVALID_FILE_ATTRIBUTES);
  const bool directory = bool(attributes & FILE_ATTRIBUTE_DIRECTORY);
  const bool opened = operation != L"delete" && operation != L"rename" && operation != L"hardlink";
  const DWORD desired = operation == L"read" ? GENERIC_READ : GENERIC_WRITE;
  const DWORD disposition = operation == L"truncate" ? TRUNCATE_EXISTING : OPEN_EXISTING;
  if (operation == L"delete") okay = DeleteFileW(path.c_str());
  else if (operation == L"rename") okay = MoveFileExW(path.c_str(), (path + L".moved").c_str(), 0);
  else if (operation == L"hardlink") okay = CreateHardLinkW((path + L".link").c_str(), path.c_str(), nullptr);
  else {
    H h(CreateFileW(path.c_str(), desired, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr,
      disposition, FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS, nullptr));
    okay = h.h != INVALID_HANDLE_VALUE;
    if (!okay) failure = GetLastError();
  }
  if (!okay && !failure) failure = GetLastError();
  const std::string op(operation.begin(), operation.end());
  std::cout << "{\"operation\":\"" << op << "\",\"targetKind\":\"" << (directory ? "directory" : "file")
    << "\",\"api\":\"" << (opened ? "CreateFileW" : operation == L"delete" ? "DeleteFileW" : operation == L"rename" ? "MoveFileExW" : "CreateHardLinkW")
    << "\",\"desiredAccess\":" << (opened ? std::to_string(desired) : "null") << ",\"shareMode\":" << (opened ? "7" : "null")
    << ",\"creationDisposition\":" << (opened ? std::to_string(disposition) : "null")
    << ",\"allowed\":" << bool(okay) << ",\"error\":" << failure << "}" << std::endl;
}
void fileIdentity(const std::wstring& path) {
  scoped(path); H h(CreateFileW(path.c_str(), FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS, nullptr)); check(h.h != INVALID_HANDLE_VALUE);
  FILE_ID_INFO id{}; check(GetFileInformationByHandleEx(h.h, FileIdInfo, &id, sizeof(id))); std::string hex; const char* digits = "0123456789abcdef";
  for (BYTE value : id.FileId.Identifier) { hex += digits[value >> 4]; hex += digits[value & 15]; }
  std::cout << "{\"volumeSerial\":\"" << id.VolumeSerialNumber << "\",\"fileId\":\"" << hex << "\"}" << std::endl;
}
void handles(DWORD pid, const std::wstring& path) {
  scoped(path); H expected(CreateFileW(path.c_str(), FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, nullptr)); check(expected.h != INVALID_HANDLE_VALUE);
  FILE_ID_INFO target{}; check(GetFileInformationByHandleEx(expected.h, FileIdInfo, &target, sizeof(target)));
  H process(OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_DUP_HANDLE | PROCESS_VM_READ, FALSE, pid)); check(process.h);
  std::cerr << "{\"snapshotPhase\":\"capture\"}" << std::endl;
  HPSS snapshot = nullptr; const DWORD capture = PssCaptureSnapshot(process.h, static_cast<PSS_CAPTURE_FLAGS>(PSS_CAPTURE_HANDLES | PSS_CAPTURE_HANDLE_BASIC_INFORMATION), 0, &snapshot);
  if (capture != ERROR_SUCCESS) throw capture;
  std::cerr << "{\"snapshotPhase\":\"walk\"}" << std::endl;
  HPSSWALK marker = nullptr; check(PssWalkMarkerCreate(nullptr, &marker) == ERROR_SUCCESS); unsigned matching = 0, files = 0;
  PSS_HANDLE_ENTRY entry{}; DWORD result = 0;
  while ((result = PssWalkSnapshot(snapshot, PSS_WALK_HANDLES, marker, &entry, sizeof(entry))) == ERROR_SUCCESS) {
    std::cerr << "{\"snapshotPhase\":\"entry\",\"type\":" << static_cast<unsigned>(entry.ObjectType) << "}" << std::endl;
    HANDLE copy = nullptr;
    if (DuplicateHandle(process.h, entry.Handle, GetCurrentProcess(), &copy, 0, FALSE, DUPLICATE_SAME_ACCESS)) {
      H duplicate(copy); FILE_ID_INFO actual{};
      const DWORD kind = GetFileType(copy);
      std::cerr << "{\"snapshotPhase\":\"handle-kind\",\"kind\":" << kind << "}" << std::endl;
      if (kind != FILE_TYPE_DISK) continue; // FileId queries are only valid for disk file/directory handles, never pipes/devices.
      std::cerr << "{\"snapshotPhase\":\"file-id-query\"}" << std::endl;
      if (GetFileInformationByHandleEx(copy, FileIdInfo, &actual, sizeof(actual))) {
        ++files; if (actual.VolumeSerialNumber == target.VolumeSerialNumber && memcmp(actual.FileId.Identifier, target.FileId.Identifier, 16) == 0) ++matching;
      }
    }
  }
  PssWalkMarkerFree(marker); std::cerr << "{\"snapshotPhase\":\"free-local\"}" << std::endl;
  const DWORD freed = PssFreeSnapshot(GetCurrentProcess(), snapshot); if (freed != ERROR_SUCCESS) throw freed; check(result == ERROR_NO_MORE_ITEMS);
  std::cout << "{\"pid\":" << pid << ",\"fileHandles\":" << files << ",\"matchingHandles\":" << matching << "}" << std::endl;
}
void childPid(DWORD pid) {
  H snapshot(CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)); PROCESSENTRY32W e{sizeof(e)}; check(Process32FirstW(snapshot.h, &e)); DWORD found = 0;
  do { if (e.th32ParentProcessID == pid && std::wstring(e.szExeFile) == L"age.exe") { check(found == 0); found = e.th32ProcessID; } } while (Process32NextW(snapshot.h, &e));
  std::cout << "{\"pid\":" << found << "}" << std::endl;
}
void death(DWORD helperPid, DWORD agePid, const std::wstring& path) {
  scoped(path); H helper(OpenProcess(PROCESS_TERMINATE | SYNCHRONIZE, FALSE, helperPid)), age(OpenProcess(SYNCHRONIZE, FALSE, agePid)); check(helper.h && age.h);
  std::vector<HANDLE> threads; H snapshot(CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0)); THREADENTRY32 entry{sizeof(entry)}; check(Thread32First(snapshot.h, &entry));
  do { if (entry.th32OwnerProcessID == agePid) { HANDLE t = OpenThread(SYNCHRONIZE | THREAD_QUERY_LIMITED_INFORMATION, FALSE, entry.th32ThreadID); if (t) threads.push_back(t); } } while (Thread32Next(snapshot.h, &entry));
  check(!threads.empty());
  auto times = [&]() { unsigned long long user = 0, cycles = 0; unsigned alive = 0;
    for (HANDLE t : threads) { if (WaitForSingleObject(t, 0) == WAIT_TIMEOUT) ++alive; FILETIME c{}, e{}, k{}, u{}; if (GetThreadTimes(t, &c, &e, &k, &u)) user += (static_cast<unsigned long long>(u.dwHighDateTime) << 32) | u.dwLowDateTime; ULONG64 count = 0; if (QueryThreadCycleTime(t, &count)) cycles += count; }
    return std::array<unsigned long long, 3>{alive, user, cycles}; };
  const auto before = times(); std::array<unsigned long long, 3> firstWrite{}; bool sawWrite = false;
  check(TerminateProcess(helper.h, 73)); bool gap = false; unsigned probes = 0; const auto deadline = GetTickCount64() + 5000;
  while (WaitForSingleObject(age.h, 0) == WAIT_TIMEOUT && GetTickCount64() < deadline) {
    ++probes; H writer(CreateFileW(path.c_str(), GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
    if (writer.h != INVALID_HANDLE_VALUE && WaitForSingleObject(age.h, 0) == WAIT_TIMEOUT) { gap = true; if (!sawWrite) { firstWrite = times(); sawWrite = true; } }
  }
  const auto after = times(); for (HANDLE t : threads) CloseHandle(t);
  std::cout << "{\"gapObserved\":" << gap << ",\"probes\":" << probes << ",\"helperClosed\":" << (WaitForSingleObject(helper.h, 5000) == WAIT_OBJECT_0)
    << ",\"ageClosed\":" << (WaitForSingleObject(age.h, 0) == WAIT_OBJECT_0) << ",\"threadsBefore\":" << before[0] << ",\"liveThreadsAtFirstWrite\":" << firstWrite[0]
    << ",\"userTimeAtFirstWrite\":" << firstWrite[1] << ",\"userTimeAfter\":" << after[1] << ",\"cyclesAtFirstWrite\":" << firstWrite[2] << ",\"cyclesAfter\":" << after[2] << "}" << std::endl;
}
void killAndWait(DWORD helperPid, DWORD agePid) {
  H helper(OpenProcess(PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, helperPid));
  H age(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, agePid)); check(helper.h && age.h);
  auto image = [](HANDLE process) { wchar_t p[32768]{}; DWORD size = 32768; check(QueryFullProcessImageNameW(process, 0, p, &size)); return std::wstring(p, size); };
  const auto helperImage = image(helper.h), ageImage = image(age.h); scoped(helperImage); scoped(ageImage);
  check(fs::path(helperImage).filename() == L"murage-backup-age.exe" && fs::path(ageImage).filename() == L"age.exe");
  H snapshot(CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)); PROCESSENTRY32W entry{sizeof(entry)}; check(Process32FirstW(snapshot.h, &entry)); bool bound = false;
  do { if (entry.th32ProcessID == agePid) { bound = entry.th32ParentProcessID == helperPid; break; } } while (Process32NextW(snapshot.h, &entry)); check(bound);
  check(WaitForSingleObject(helper.h, 0) == WAIT_TIMEOUT && WaitForSingleObject(age.h, 0) == WAIT_TIMEOUT);
  check(TerminateProcess(helper.h, 73));
  const bool helperClosed = WaitForSingleObject(helper.h, 5000) == WAIT_OBJECT_0, ageClosed = WaitForSingleObject(age.h, 5000) == WAIT_OBJECT_0;
  DWORD helperExit = STILL_ACTIVE, ageExit = STILL_ACTIVE; check(GetExitCodeProcess(helper.h, &helperExit)); check(GetExitCodeProcess(age.h, &ageExit));
  std::cout << "{\"helperPid\":" << helperPid << ",\"agePid\":" << agePid << ",\"boundChild\":true,\"helperClosed\":" << helperClosed << ",\"ageClosed\":" << ageClosed
    << ",\"helperExit\":" << helperExit << ",\"ageExit\":" << ageExit << "}" << std::endl;
}
int wmain(int argc, wchar_t** argv) {
  try {
    if (argc == 2 && std::wstring(argv[1]) == L"--restricted") return restricted();
    if (argc == 2 && std::wstring(argv[1]) == L"--limited-session") return limitedSession();
    if (argc == 2 && std::wstring(argv[1]) == L"--guard-diagnostic") return limitedSession(true);
    if (argc == 3 && std::wstring(argv[1]) == L"--identity") { fileIdentity(argv[2]); return 0; }
    if (argc == 2 && std::wstring(argv[1]) == L"--restricted-inert") return restricted(true);
    if (argc == 2 && std::wstring(argv[1]) == L"--linked-info") {
      HANDLE raw = nullptr; check(OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &raw)); H token(raw);
      TOKEN_LINKED_TOKEN linked{}; DWORD size = 0; const BOOL available = GetTokenInformation(token.h, TokenLinkedToken, &linked, sizeof(linked), &size);
      const DWORD error = available ? 0 : GetLastError(); H linkedOwner(available ? linked.LinkedToken : nullptr);
      std::cout << "{\"event\":\"own-linked-token\",\"available\":" << bool(available) << ",\"error\":" << error << "}" << std::endl;
      if (available) tokenReport(linked.LinkedToken, "own-linked-token-properties"); return 0;
    }
    if (argc == 2 && std::wstring(argv[1]) == L"--inert") { HANDLE raw = nullptr; check(OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &raw)); H t(raw); tokenReport(t.h, "inert-token"); return 0; }
    if (argc == 3 && std::wstring(argv[1]) == L"--acl") { aclProbe(argv[2]); return 0; }
    if (argc == 4 && std::wstring(argv[1]) == L"--mutation") { mutation(argv[2], argv[3]); return 0; }
    if (argc == 4 && std::wstring(argv[1]) == L"--handles") { handles(std::stoul(argv[2]), argv[3]); return 0; }
    if (argc == 3 && std::wstring(argv[1]) == L"--child") { childPid(std::stoul(argv[2])); return 0; }
    if (argc == 5 && std::wstring(argv[1]) == L"--death") { death(std::stoul(argv[2]), std::stoul(argv[3]), argv[4]); return 0; }
    if (argc == 4 && std::wstring(argv[1]) == L"--kill-and-wait") { killAndWait(std::stoul(argv[2]), std::stoul(argv[3])); return 0; }
    if (argc == 3 && std::wstring(argv[1]) == L"--hold-writer") { scoped(argv[2]); H h(CreateFileW(argv[2], GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr)); check(h.h != INVALID_HANDLE_VALUE); std::cout << "{\"held\":true}" << std::endl; char c = 0; std::cin.get(c); return 0; }
    return 75;
  } catch (DWORD e) { std::cout << "{\"fixtureError\":" << e << "}" << std::endl; return 75; }
  catch (...) { std::cout << "{\"fixtureError\":75}" << std::endl; return 75; }
}
