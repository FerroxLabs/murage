// Unelevated, source-only adapter. Windows admission and packaging remain disabled.
#define NOMINMAX
#define _WIN32_WINNT 0x0602
#include <windows.h>
#include <sddl.h>
#include <aclapi.h>
#include <tlhelp32.h>
#include <bcrypt.h>
#include <algorithm>
#include <array>
#include <atomic>
#include <cstring>
#include <cwctype>
#include <filesystem>
#include <string>
#include <thread>
#include <utility>
#include <vector>

namespace {
constexpr size_t frameLimit = 32768, controlLimit = 131072, keyLimit = 136;
constexpr unsigned long long byteLimit = 20ull * 1024 * 1024 * 1024;
constexpr char ageDigest[] = "2821a4ed191da07372acd302e5f6feae7a7985e285e1417765ebe74025af45f0";
struct Failure {};
void need(bool okay) { if (!okay) throw Failure{}; }
void win(BOOL okay) { need(okay != FALSE); }
struct Handle {
  HANDLE h = nullptr;
  Handle() = default;
  explicit Handle(HANDLE value) : h(value) { need(value && value != INVALID_HANDLE_VALUE); }
  Handle(Handle&& other) noexcept : h(std::exchange(other.h, nullptr)) {}
  Handle& operator=(Handle&& other) noexcept { if (h) CloseHandle(h); h = std::exchange(other.h, nullptr); return *this; }
  Handle(const Handle&) = delete;
  void close() { if (h) { win(CloseHandle(h)); h = nullptr; } }
  ~Handle() { if (h) CloseHandle(h); }
};
struct Local { HLOCAL p = nullptr; ~Local() { if (p) LocalFree(p); } };
std::wstring wide(const std::string& s) {
  need(!s.empty() && s.size() <= frameLimit);
  int n = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, s.data(), static_cast<int>(s.size()), nullptr, 0); need(n > 0);
  std::wstring out(n, L'\0'); win(MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, s.data(), static_cast<int>(s.size()), out.data(), n)); return out;
}
std::wstring lower(std::wstring s) { std::transform(s.begin(), s.end(), s.begin(), towlower); return s; }
unsigned long long number(const std::string& s, unsigned long long max, bool zero = false) {
  need(!s.empty() && s.size() <= 20 && (s.size() == 1 || s[0] != '0'));
  unsigned long long n = 0;
  for (char c : s) { need(c >= '0' && c <= '9'); const auto d = static_cast<unsigned>(c - '0'); need(d <= max && n <= (max - d) / 10); n = n * 10 + d; }
  need(zero || n > 0); return n;
}
bool nonceValid(const std::string& s) {
  if (s.size() != 36) return false;
  for (size_t i = 0; i < s.size(); ++i) {
    if (i == 8 || i == 13 || i == 18 || i == 23) { if (s[i] != '-') return false; }
    else if (!((s[i] >= '0' && s[i] <= '9') || (s[i] >= 'a' && s[i] <= 'f'))) return false;
  }
  return true;
}
std::vector<std::string> split(const std::string& s, char separator) {
  std::vector<std::string> out; size_t at = 0;
  for (;;) { const auto end = s.find(separator, at); out.push_back(s.substr(at, end == std::string::npos ? end : end - at)); if (end == std::string::npos) return out; at = end + 1; }
}
bool component(const std::wstring& s) {
  if (s.empty() || s.size() > 255 || s.back() == L'.' || s.back() == L' ') return false;
  for (wchar_t c : s) if (c < 32 || c == 127 || std::wstring(L"\\/:*?\"<>|").find(c) != std::wstring::npos) return false;
  const auto b = lower(s.substr(0, s.find(L'.')));
  if (b == L"con" || b == L"prn" || b == L"aux" || b == L"nul" || b == L"conin$" || b == L"conout$") return false;
  return !(b.size() == 4 && (b.starts_with(L"com") || b.starts_with(L"lpt")) &&
    ((b[3] >= L'1' && b[3] <= L'9') || b[3] == 0x00b9 || b[3] == 0x00b2 || b[3] == 0x00b3));
}
void pathValid(const std::wstring& p) {
  need(p.size() > 3 && p.size() <= 8192 && ((p[0] >= L'A' && p[0] <= L'Z') || (p[0] >= L'a' && p[0] <= L'z')) && p[1] == L':' && p[2] == L'\\');
  size_t at = 3, count = 0;
  for (;;) { const auto end = p.find(L'\\', at); need(++count <= 127 && component(p.substr(at, end == std::wstring::npos ? end : end - at))); if (end == std::wstring::npos) break; at = end + 1; }
}
FILE_ID_INFO identity(HANDLE h) { FILE_ID_INFO id{}; win(GetFileInformationByHandleEx(h, FileIdInfo, &id, sizeof(id))); return id; }
std::string hex(const unsigned char* bytes, size_t size) {
  std::string out; constexpr char digits[] = "0123456789abcdef";
  for (size_t i = 0; i < size; ++i) { out += digits[bytes[i] >> 4]; out += digits[bytes[i] & 15]; } return out;
}
std::string idFields(const FILE_ID_INFO& id) { return std::to_string(id.VolumeSerialNumber) + "\t" + hex(id.FileId.Identifier, 16); }
struct FileState { FILE_ID_INFO id; BY_HANDLE_FILE_INFORMATION info; unsigned long long size; };
FileState fileState(HANDLE h) {
  FileState s{}; s.id = identity(h); win(GetFileInformationByHandle(h, &s.info)); LARGE_INTEGER n{}; win(GetFileSizeEx(h, &n));
  need(n.QuadPart >= 0 && s.info.nNumberOfLinks == 1); s.size = static_cast<unsigned long long>(n.QuadPart); return s;
}
void unchanged(HANDLE h, const FileState& before) {
  const auto after = fileState(h);
  need(after.size == before.size && after.id.VolumeSerialNumber == before.id.VolumeSerialNumber &&
    std::memcmp(after.id.FileId.Identifier, before.id.FileId.Identifier, 16) == 0 &&
    CompareFileTime(&after.info.ftLastWriteTime, &before.info.ftLastWriteTime) == 0);
}
// share: who else may open the object while it is held. The default (read
// only) is for the private stage and the files this helper reads.
Handle openGuard(const std::wstring& p, bool directory, DWORD share = FILE_SHARE_READ) {
  Handle h(CreateFileW(p.c_str(), (directory ? FILE_READ_ATTRIBUTES | FILE_LIST_DIRECTORY : GENERIC_READ) | READ_CONTROL,
    share, nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT | (directory ? FILE_FLAG_BACKUP_SEMANTICS : FILE_FLAG_SEQUENTIAL_SCAN), nullptr));
  need(GetFileType(h.h) == FILE_TYPE_DISK);
  FILE_ATTRIBUTE_TAG_INFO info{}; win(GetFileInformationByHandleEx(h.h, FileAttributeTagInfo, &info, sizeof(info)));
  need(!(info.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) && bool(info.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) == directory);
  (void)identity(h.h); return h;
}
// Holds every folder from the drive root down to p for the whole run, so
// none of them can be renamed, deleted or swapped for a junction: without
// FILE_SHARE_DELETE nobody can open them for DELETE. FILE_SHARE_WRITE is
// granted because these are ordinary folders other programs use (C:\ root,
// C:\Users, C:\Users\<name>, %APPDATA%\murage): renaming, hard linking or
// saving-by-rename INTO a folder opens that folder for write, and a read-only
// share made every such operation fail with a sharing violation for as long
// as a backup or restore ran (W-A6, and the lease EBUSY behind W-D1). Write
// access to a folder only adds or removes entries inside it; it can't rename
// or replace the held folder itself, so the path stays the same. This matches
// the recovery helper's pins (capture.cpp pinPath, broker.cpp pin).
constexpr DWORD ancestorShare = FILE_SHARE_READ | FILE_SHARE_WRITE;
std::vector<Handle> pinDirectories(const std::wstring& p) {
  pathValid(p); wchar_t fsName[32]{};
  need(GetDriveTypeW(p.substr(0, 3).c_str()) == DRIVE_FIXED);
  win(GetVolumeInformationW(p.substr(0, 3).c_str(), nullptr, 0, nullptr, nullptr, nullptr, fsName, 32)); need(std::wstring(fsName) == L"NTFS");
  std::vector<Handle> held; held.push_back(openGuard(p.substr(0, 3), true, ancestorShare));
  size_t at = 3;
  for (;;) { const auto end = p.find(L'\\', at); held.push_back(openGuard(p.substr(0, end), true, ancestorShare)); if (end == std::wstring::npos) break; at = end + 1; }
  return held;
}
Handle token(HANDLE p) { HANDLE raw = nullptr; win(OpenProcessToken(p, TOKEN_QUERY, &raw)); return Handle(raw); }
std::wstring sid(HANDLE t) {
  DWORD size = 0; GetTokenInformation(t, TokenUser, nullptr, 0, &size); need(size > 0); std::vector<BYTE> bytes(size);
  win(GetTokenInformation(t, TokenUser, bytes.data(), size, &size)); LPWSTR text = nullptr;
  win(ConvertSidToStringSidW(reinterpret_cast<TOKEN_USER*>(bytes.data())->User.Sid, &text)); Local owner{text}; return text;
}
Handle parentProcess(DWORD expected, std::wstring& user) {
  Handle snapshot(CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)); PROCESSENTRY32W e{sizeof(e)}; win(Process32FirstW(snapshot.h, &e)); bool found = false;
  do { if (e.th32ProcessID == GetCurrentProcessId()) { need(e.th32ParentProcessID == expected); found = true; break; } } while (Process32NextW(snapshot.h, &e)); need(found);
  Handle parent(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, expected)); auto selfToken = token(GetCurrentProcess()), parentToken = token(parent.h);
  user = sid(selfToken.h); need(user == sid(parentToken.h)); TOKEN_ELEVATION elevation{}; DWORD size = 0;
  win(GetTokenInformation(selfToken.h, TokenElevation, &elevation, sizeof(elevation), &size)); need(!elevation.TokenIsElevated);
  return parent;
}
Handle privateStage(const std::wstring& p, const std::wstring& user) {
  const auto sddl = L"D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;" + user + L")";
  PSECURITY_DESCRIPTOR descriptor = nullptr; win(ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.c_str(), SDDL_REVISION_1, &descriptor, nullptr)); Local desired{descriptor};
  SECURITY_ATTRIBUTES security{sizeof(security), descriptor, FALSE}; win(CreateDirectoryW(p.c_str(), &security)); // Never adopt or chmod an existing directory.
  auto h = openGuard(p, true); PSECURITY_DESCRIPTOR actual = nullptr; PACL acl = nullptr;
  need(GetSecurityInfo(h.h, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, nullptr, nullptr, &acl, nullptr, &actual) == ERROR_SUCCESS); Local observed{actual};
  SECURITY_DESCRIPTOR_CONTROL control{}; DWORD revision = 0; win(GetSecurityDescriptorControl(actual, &control, &revision)); need((control & SE_DACL_PROTECTED) && acl && acl->AceCount == 2);
  PSID system = nullptr, current = nullptr; win(ConvertStringSidToSidW(L"S-1-5-18", &system)); Local systemOwner{system}; win(ConvertStringSidToSidW(user.c_str(), &current)); Local currentOwner{current};
  bool sawSystem = false, sawCurrent = false;
  for (DWORD i = 0; i < 2; ++i) {
    void* raw = nullptr; win(GetAce(acl, i, &raw)); const auto* ace = static_cast<ACCESS_ALLOWED_ACE*>(raw);
    need(ace->Header.AceType == ACCESS_ALLOWED_ACE_TYPE && ace->Header.AceFlags == (OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE) && ace->Mask == FILE_ALL_ACCESS);
    PSID target = const_cast<DWORD*>(&ace->SidStart); need(IsValidSid(target));
    if (EqualSid(target, system)) { need(!sawSystem); sawSystem = true; } else { need(EqualSid(target, current) && !sawCurrent); sawCurrent = true; }
  }
  need(sawSystem && sawCurrent); return h;
}
struct Watch {
  std::atomic<ULONGLONG> until{GetTickCount64() + 30000};
  std::atomic<HANDLE> parent{nullptr};
  std::jthread thread;
  Watch() : thread([this](std::stop_token stop) {
    while (!stop.stop_requested()) {
      HANDLE peer = parent.load();
      // Fail without a RELEASED receipt; OS closure kills the owned job. Never claim cleanup.
      if (GetTickCount64() >= until.load() || (peer && WaitForSingleObject(peer, 0) != WAIT_TIMEOUT)) ExitProcess(72);
      Sleep(20);
    }
  }) {}
};
struct Input {
  HANDLE h = GetStdHandle(STD_INPUT_HANDLE); size_t controlBytes = 0;
  void exact(char* data, size_t bytes) {
    while (bytes) { DWORD n = 0; win(ReadFile(h, data, static_cast<DWORD>(bytes), &n, nullptr)); need(n > 0); data += n; bytes -= n; }
  }
  std::string line(size_t max = frameLimit) {
    std::string s;
    for (;;) { char c = 0; exact(&c, 1); need(++controlBytes <= controlLimit); if (c == '\n') return s; need(s.size() < max && (c == '\t' || (c >= 32 && c <= 126))); s += c; }
  }
  bool available() { DWORD bytes = 0; win(PeekNamedPipe(h, nullptr, 0, nullptr, &bytes, nullptr)); return bytes > 0; }
  void finish() {
    // RELEASE is the last command. Require actual writer EOF, not an empty
    // PeekNamedPipe snapshot that could miss a delayed extra command.
    char extra = 0; DWORD n = 0;
    const BOOL okay = ReadFile(h, &extra, 1, &n, nullptr);
    need((okay && n == 0) || (!okay && GetLastError() == ERROR_BROKEN_PIPE));
  }
};
void writeAll(HANDLE h, const char* bytes, size_t size) {
  while (size) { DWORD n = 0; win(WriteFile(h, bytes, static_cast<DWORD>(size), &n, nullptr)); need(n > 0); bytes += n; size -= n; }
}
struct Control {
  std::string nonce; size_t bytes = 0;
  void send(const std::string& event) {
    const auto line = "1\t" + nonce + "\t" + event + "\n"; need(line.size() <= frameLimit && bytes + line.size() <= controlLimit); bytes += line.size();
    writeAll(GetStdHandle(STD_ERROR_HANDLE), line.data(), line.size());
  }
  void expect(Input& input, const char* event) { need(input.line() == "1\t" + nonce + "\t" + event); }
};
struct Secret {
  std::array<char, keyLimit> bytes{}; size_t size = 0;
  ~Secret() { SecureZeroMemory(bytes.data(), bytes.size()); }
  void read(Input& input, size_t n) {
    size = n; need(size >= 56 && size <= keyLimit); input.exact(bytes.data(), size);
    need(std::memcmp(bytes.data(), "AGE-SECRET-KEY-1", 15) == 0 && bytes[size - 1] == '\n');
    for (size_t i = 15; i + 1 < size; ++i) need((bytes[i] >= 'A' && bytes[i] <= 'Z') || (bytes[i] >= '0' && bytes[i] <= '9'));
  }
};
std::string hash(HANDLE file) {
  struct Crypto { BCRYPT_ALG_HANDLE alg = nullptr; BCRYPT_HASH_HANDLE hash = nullptr; ~Crypto() { if (hash) BCryptDestroyHash(hash); if (alg) BCryptCloseAlgorithmProvider(alg, 0); } } c;
  need(BCryptOpenAlgorithmProvider(&c.alg, BCRYPT_SHA256_ALGORITHM, nullptr, 0) >= 0);
  need(BCryptCreateHash(c.alg, &c.hash, nullptr, 0, nullptr, 0, 0) >= 0);
  LARGE_INTEGER zero{}; win(SetFilePointerEx(file, zero, nullptr, FILE_BEGIN)); std::array<unsigned char, 65536> buffer{};
  for (;;) { DWORD n = 0; win(ReadFile(file, buffer.data(), static_cast<DWORD>(buffer.size()), &n, nullptr)); if (!n) break; need(BCryptHashData(c.hash, buffer.data(), n, 0) >= 0); }
  std::array<unsigned char, 32> digest{}; need(BCryptFinishHash(c.hash, digest.data(), static_cast<ULONG>(digest.size()), 0) >= 0); return hex(digest.data(), digest.size());
}
std::wstring ownPath() { std::wstring p(32768, L'\0'); DWORD n = GetModuleFileNameW(nullptr, p.data(), static_cast<DWORD>(p.size())); need(n && n < p.size()); p.resize(n); pathValid(p); return p; }
std::wstring quote(const std::wstring& p) { // Validated DOS paths cannot contain quotes; double trailing slashes.
  std::wstring out = L"\"" + p; size_t n = p.size(); while (n && p[n - 1] == L'\\') { out += L'\\'; --n; } return out + L"\"";
}
Handle duplicate(HANDLE h) { HANDLE copy = nullptr; win(DuplicateHandle(GetCurrentProcess(), h, GetCurrentProcess(), &copy, 0, TRUE, DUPLICATE_SAME_ACCESS)); return Handle(copy); }
struct Pipe { Handle read, write;
  Pipe() { HANDLE r = nullptr, w = nullptr; win(CreatePipe(&r, &w, nullptr, 4096)); read = Handle(r); write = Handle(w); }
};
struct Child {
  Handle process, thread, job;
  bool closed = false; DWORD closeMs;
  explicit Child(DWORD limit) : closeMs(limit) {}
  ~Child() {
    if (process.h && !closed) {
      if (job.h) TerminateJobObject(job.h, 72); else TerminateProcess(process.h, 72);
      // Failure never emits RELEASED; caller must retain stage until independently confirmed.
      WaitForSingleObject(process.h, closeMs);
    }
  }
};
struct DecryptResult { DWORD code; unsigned long long bytes; };
DecryptResult decrypt(const std::wstring& ciphertext, const std::wstring& stage, Secret& secret,
    const std::vector<HANDLE>& guards, Input& input, Control& control, unsigned long long maxBytes, DWORD closeMs) {
  const auto executable = (std::filesystem::path(ownPath()).parent_path() / L"age.exe").wstring();
  auto toolPins = pinDirectories(std::filesystem::path(executable).parent_path().wstring()); auto tool = openGuard(executable, false);
  const auto toolState = fileState(tool.h); need(toolState.size <= 64 * 1024 * 1024 && hash(tool.h) == ageDigest); unchanged(tool.h, toolState);
  Pipe keyPipe, outPipe, errPipe; std::vector<Handle> inherited;
  inherited.push_back(duplicate(keyPipe.read.h)); inherited.push_back(duplicate(outPipe.write.h)); inherited.push_back(duplicate(errPipe.write.h));
  for (HANDLE guard : guards) inherited.push_back(duplicate(guard));
  inherited.push_back(duplicate(tool.h)); for (const auto& pin : toolPins) inherited.push_back(duplicate(pin.h));
  std::vector<HANDLE> raw; for (const auto& h : inherited) raw.push_back(h.h);
  SIZE_T size = 0; InitializeProcThreadAttributeList(nullptr, 1, 0, &size); need(size > 0);
  std::vector<unsigned char> storage(size); auto* attributes = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(storage.data());
  win(InitializeProcThreadAttributeList(attributes, 1, 0, &size)); struct Attributes { LPPROC_THREAD_ATTRIBUTE_LIST p; ~Attributes() { DeleteProcThreadAttributeList(p); } } attributeOwner{attributes};
  win(UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, raw.data(), raw.size() * sizeof(HANDLE), nullptr, nullptr));
  STARTUPINFOEXW startup{}; startup.StartupInfo.cb = sizeof(startup); startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES; startup.lpAttributeList = attributes;
  startup.StartupInfo.hStdInput = raw[0]; startup.StartupInfo.hStdOutput = raw[1]; startup.StartupInfo.hStdError = raw[2];
  Child child(closeMs); child.job = Handle(CreateJobObjectW(nullptr, nullptr)); JOBOBJECT_EXTENDED_LIMIT_INFORMATION policy{};
  policy.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE; win(SetInformationJobObject(child.job.h, JobObjectExtendedLimitInformation, &policy, sizeof(policy)));
  std::wstring command = quote(executable) + L" --decrypt --identity - --output - " + quote(ciphertext);
  wchar_t environment[2] = {0, 0}; PROCESS_INFORMATION pi{};
  win(CreateProcessW(executable.c_str(), command.data(), nullptr, nullptr, TRUE,
    EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED | CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT,
    environment, stage.c_str(), &startup.StartupInfo, &pi));
  child.process = Handle(pi.hProcess); child.thread = Handle(pi.hThread);
  win(AssignProcessToJobObject(child.job.h, child.process.h));
  need(ResumeThread(child.thread.h) != static_cast<DWORD>(-1));
  inherited.clear(); keyPipe.read.close(); outPipe.write.close(); errPipe.write.close();
  writeAll(keyPipe.write.h, secret.bytes.data(), secret.size); SecureZeroMemory(secret.bytes.data(), secret.bytes.size()); keyPipe.write.close();
  std::array<char, 65536> buffer{}; unsigned long long total = 0; bool outClosed = false, errClosed = false;
  auto drain = [&](Handle& pipe, bool output, bool& closed) {
    DWORD available = 0;
    if (!PeekNamedPipe(pipe.h, nullptr, 0, nullptr, &available, nullptr)) { need(GetLastError() == ERROR_BROKEN_PIPE); closed = true; return; }
    if (!available) return;
    DWORD n = 0; win(ReadFile(pipe.h, buffer.data(), std::min<DWORD>(available, static_cast<DWORD>(buffer.size())), &n, nullptr)); need(n > 0);
    if (output) { need(n <= maxBytes - total); total += n; writeAll(GetStdHandle(STD_OUTPUT_HANDLE), buffer.data(), n); }
    // age stderr is intentionally discarded, never a control frame or diagnostic.
    SecureZeroMemory(buffer.data(), n);
  };
  for (;;) {
    if (input.available()) { control.expect(input, "CANCEL"); throw Failure{}; } // All early/duplicate commands fail closed.
    if (!outClosed) drain(outPipe.read, true, outClosed); if (!errClosed) drain(errPipe.read, false, errClosed);
    const auto state = WaitForSingleObject(child.process.h, 0); need(state == WAIT_TIMEOUT || state == WAIT_OBJECT_0);
    if (state == WAIT_OBJECT_0 && outClosed && errClosed) break; Sleep(2);
  }
  DWORD code = 72; win(GetExitCodeProcess(child.process.h, &code)); child.closed = true;
  // Explicitly close every child writer and inherited guard before CHILD_CLOSED.
  child.thread.close(); child.process.close(); child.job.close(); outPipe.read.close(); errPipe.read.close();
  return {code, total};
}
int run(DWORD expectedParent) {
  Watch watch; std::wstring user; auto parent = parentProcess(expectedParent, user); watch.parent.store(parent.h);
  // Watch must stop before the parent handle is destroyed on every exit path.
  struct StopWatch { Watch& w; ~StopWatch() { w.thread.request_stop(); w.thread.join(); } } stop{watch};
  for (DWORD which : {STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE}) need(GetFileType(GetStdHandle(which)) == FILE_TYPE_PIPE);
  Input input; const auto metadataSize = static_cast<size_t>(number(input.line(5), frameLimit));
  std::string metadata(metadataSize, '\0'); input.exact(metadata.data(), metadata.size()); input.controlBytes += metadata.size();
  const auto fields = split(metadata, '\n'); need(fields.size() == 10 && fields[0] == "1" && nonceValid(fields[1]));
  const bool isDecrypt = fields[2] == "decrypt"; need(isDecrypt || fields[2] == "private-stage"); need(number(fields[3], MAXDWORD) == expectedParent);
  const auto directory = wide(fields[4]); pathValid(directory); const auto keySize = static_cast<size_t>(number(fields[6], keyLimit, true));
  const auto maxBytes = number(fields[7], byteLimit); const auto deadline = number(fields[8], 1800000); const auto closeMs = static_cast<DWORD>(number(fields[9], 30000));
  std::wstring ciphertext; if (isDecrypt) { ciphertext = wide(fields[5]); pathValid(ciphertext); need(keySize >= 56); } else need(fields[5].empty() && keySize == 0);
  Secret secret; if (isDecrypt) secret.read(input, keySize);
  auto stagePins = pinDirectories(directory); const auto stagePath = directory + L"\\.murage-backup-" + wide(fields[1]);
  auto stage = privateStage(stagePath, user); const auto stageId = identity(stage.h);
  std::vector<Handle> sourcePins; Handle source; FileState before{};
  if (isDecrypt) { sourcePins = pinDirectories(std::filesystem::path(ciphertext).parent_path().wstring()); source = openGuard(ciphertext, false); before = fileState(source.h); need(before.size > 0 && before.size <= maxBytes); }
  Control control{fields[1]}; control.send("PREPARED\t" + idFields(before.id) + "\t" + std::to_string(before.size) + "\t" + idFields(stageId));
  if (isDecrypt) {
    control.expect(input, "START"); watch.until.store(GetTickCount64() + deadline + closeMs);
    std::vector<HANDLE> guards{source.h, stage.h}; for (const auto& p : sourcePins) guards.push_back(p.h); for (const auto& p : stagePins) guards.push_back(p.h);
    const auto result = decrypt(ciphertext, stagePath, secret, guards, input, control, maxBytes, closeMs); need(result.code == 0);
    unchanged(source.h, before); control.send("CHILD_CLOSED\t0\t" + std::to_string(result.bytes));
  } else watch.until.store(GetTickCount64() + deadline);
  control.expect(input, "RELEASE");
  input.finish();
  std::string digest = "-"; if (isDecrypt) { unchanged(source.h, before); digest = hash(source.h); unchanged(source.h, before); }
  need(idFields(identity(stage.h)) == idFields(stageId));
  source.close(); sourcePins.clear(); stage.close(); stagePins.clear();
  control.send("RELEASED\t" + digest); return 0;
}
} // namespace
int wmain(int argc, wchar_t** argv) {
  try {
    need(argc == 3 && std::wstring(argv[1]) == L"--parent"); std::wstring p(argv[2]); need(!p.empty() && p.size() <= 10);
    std::string ascii; for (wchar_t c : p) { need(c >= L'0' && c <= L'9'); ascii += static_cast<char>(c); }
    return run(static_cast<DWORD>(number(ascii, MAXDWORD)));
  } catch (...) { return 72; } // Never write parser input, key material, paths or native diagnostics.
}
