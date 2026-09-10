// One-shot recovery transport. No privileged path/command arguments.
#define NOMINMAX
#include "capture.h"
#include <shellapi.h>
#include <sddl.h>
#include <tlhelp32.h>
#include <algorithm>
#include <array>
#include <filesystem>
#include <iostream>
#include <sstream>
#include <thread>
#include <vector>
#include <utility>

using namespace murage::recovery;
namespace fs = std::filesystem;
namespace {
std::string activeNonce;
struct Error { HRESULT code; };
void need(bool value, HRESULT code = E_INVALIDARG) { if (!value) throw Error{code}; }
void win(BOOL okay) { if (!okay) throw Error{HRESULT_FROM_WIN32(GetLastError())}; }
void hr(HRESULT value) { if (FAILED(value)) throw Error{value}; }
struct Handle {
  HANDLE h = nullptr;
  explicit Handle(HANDLE value = nullptr) : h(value) { need(value != INVALID_HANDLE_VALUE, HRESULT_FROM_WIN32(GetLastError())); }
  Handle(Handle&& other) noexcept : h(std::exchange(other.h, nullptr)) {}
  Handle(const Handle&) = delete;
  ~Handle() { if (h) CloseHandle(h); }
};
std::wstring wide(const std::string& text) {
  need(!text.empty() && text.size() <= 32768);
  const int size = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text.data(), static_cast<int>(text.size()), nullptr, 0); need(size > 0);
  std::wstring result(size, L'\0'); win(MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text.data(), static_cast<int>(text.size()), result.data(), size)); return result;
}
std::string utf8(const std::wstring& text) {
  const int size = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, text.data(), static_cast<int>(text.size()), nullptr, 0, nullptr, nullptr); need(size > 0);
  std::string result(size, '\0'); win(WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, text.data(), static_cast<int>(text.size()), result.data(), size, nullptr, nullptr)); return result;
}
std::string guid(GUID value) {
  wchar_t buffer[40]{}; need(StringFromGUID2(value, buffer, 40) == 39);
  std::wstring text(buffer+1, 36); std::transform(text.begin(), text.end(), text.begin(), towlower); return utf8(text);
}
GUID parseNonce(const std::string& text) {
  need(text.size() == 36); GUID result{}; hr(CLSIDFromString(wide("{" + text + "}").c_str(), &result)); need(guid(result) == text); return result;
}
FILE_ID_INFO identity(HANDLE object) {
  FILE_ID_INFO value{}; win(GetFileInformationByHandleEx(object, FileIdInfo, &value, sizeof(value))); return value;
}
std::string fileId(const FILE_ID_INFO& id) {
  std::string text; const char* hex = "0123456789abcdef";
  for (BYTE value : id.FileId.Identifier) { text += hex[value >> 4]; text += hex[value & 15]; } return text;
}
std::string identityJson(const FILE_ID_INFO& id) {
  return "{\"volumeSerial\":\"" + std::to_string(id.VolumeSerialNumber) + "\",\"fileId\":\"" + fileId(id) + "\"}";
}
std::wstring finalPath(HANDLE object) {
  std::wstring text(32768, L'\0'); const DWORD size = GetFinalPathNameByHandleW(object, text.data(), static_cast<DWORD>(text.size()), VOLUME_NAME_GUID);
  need(size > 0 && size < text.size()); text.resize(size); return text;
}
std::wstring lower(std::wstring text) { std::transform(text.begin(), text.end(), text.begin(), towlower); return text; }
bool part(const std::wstring& text) {
  return !text.empty() && text != L"." && text != L".." && text.back() != L'.' && text.back() != L' ' &&
    std::none_of(text.begin(), text.end(), [](wchar_t c) { return c < 32 || std::wstring(L"\\/:*?\"<>|").find(c) != std::wstring::npos; });
}
std::vector<Handle> pin(const std::wstring& path, DWORD lastAccess = FILE_READ_ATTRIBUTES) {
  need(path.size() > 3 && path.size() < 8192 && iswalpha(path[0]) && path[1] == L':' && path[2] == L'\\');
  std::vector<Handle> held;
  size_t at = 2;
  for (;;) {
    const auto next = path.find(L'\\', at+1);
    if (at != 2) need(part(path.substr(at+1, next == std::wstring::npos ? next : next-at-1)));
    const auto prefix = at == 2 ? path.substr(0, 3) : path.substr(0, next);
    const bool last = at != 2 && next == std::wstring::npos;
    held.emplace_back(CreateFileW(prefix.c_str(), (last ? lastAccess : FILE_READ_ATTRIBUTES) | FILE_LIST_DIRECTORY,
      FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
    FILE_ATTRIBUTE_TAG_INFO info{}; win(GetFileInformationByHandleEx(held.back().h, FileAttributeTagInfo, &info, sizeof(info)));
    need((info.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) && !(info.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT));
    if (last) break;
    if (at == 2) { at = 2; const auto first = path.find(L'\\', 3);
      need(part(path.substr(3, first == std::wstring::npos ? first : first-3)));
      held.emplace_back(CreateFileW(path.substr(0, first).c_str(), (first == std::wstring::npos ? lastAccess : FILE_READ_ATTRIBUTES) | FILE_LIST_DIRECTORY,
        FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
      win(GetFileInformationByHandleEx(held.back().h, FileAttributeTagInfo, &info, sizeof(info)));
      need((info.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) && !(info.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT));
      if (first == std::wstring::npos) break; at = first;
    } else at = next;
  }
  return held;
}
Handle token(HANDLE process, DWORD access = TOKEN_QUERY) {
  HANDLE raw = nullptr; win(OpenProcessToken(process, access, &raw)); return Handle(raw);
}
std::wstring sid(HANDLE accessToken) {
  DWORD size = 0; GetTokenInformation(accessToken, TokenUser, nullptr, 0, &size); need(size > 0);
  std::vector<BYTE> data(size); win(GetTokenInformation(accessToken, TokenUser, data.data(), size, &size));
  LPWSTR raw = nullptr; win(ConvertSidToStringSidW(reinterpret_cast<TOKEN_USER*>(data.data())->User.Sid, &raw));
  std::wstring result(raw); LocalFree(raw); return result;
}
void sameSid(const std::wstring& a,const std::wstring& b) { need(a==b,E_ACCESSDENIED); }
struct Security {
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  SECURITY_ATTRIBUTES attributes{sizeof(SECURITY_ATTRIBUTES), nullptr, FALSE};
  explicit Security(const std::wstring& user, bool inherit = false) {
    const std::wstring flags = inherit ? L"OICI" : L"";
    const auto sddl = L"D:P(A;" + flags + L";FA;;;SY)(A;" + flags + L";FA;;;" + user + L")";
    win(ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.c_str(), SDDL_REVISION_1, &descriptor, nullptr)); attributes.lpSecurityDescriptor = descriptor;
  }
  ~Security() { LocalFree(descriptor); }
};
Handle process(DWORD pid) { return Handle(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, pid)); }
std::wstring image(HANDLE processHandle) {
  std::wstring result(32768, L'\0'); DWORD size = static_cast<DWORD>(result.size()); win(QueryFullProcessImageNameW(processHandle, 0, result.data(), &size)); result.resize(size); return result;
}
std::wstring ownImage() {
  std::wstring result(32768, L'\0'); DWORD size = GetModuleFileNameW(nullptr, result.data(), static_cast<DWORD>(result.size())); need(size && size < result.size()); result.resize(size); return result;
}
DWORD number(const std::wstring& text) {
  need(!text.empty() && text.size() < 11 && std::all_of(text.begin(), text.end(), iswdigit));
  const auto value = std::stoull(text); need(value > 0 && value <= MAXDWORD); return static_cast<DWORD>(value);
}
void checkParent(DWORD expected) {
  Handle snapshot(CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)); PROCESSENTRY32W entry{sizeof(entry)};
  win(Process32FirstW(snapshot.h, &entry));
  do { if (entry.th32ProcessID == GetCurrentProcessId()) { need(entry.th32ParentProcessID == expected, E_ACCESSDENIED); return; } } while (Process32NextW(snapshot.h, &entry));
  throw Error{E_ACCESSDENIED};
}
struct Guard {
  HANDLE peer = nullptr, cancel = nullptr, desktopInput = nullptr;
  ULONGLONG until = GetTickCount64() + 180000;
  size_t readBytes = 0;
  void check() {
    need(GetTickCount64() < until, HRESULT_FROM_WIN32(ERROR_TIMEOUT));
    if (desktopInput) { DWORD available = 0; if (!PeekNamedPipe(desktopInput, nullptr, 0, nullptr, &available, nullptr)) SetEvent(cancel); }
    if (peer) need(WaitForSingleObject(peer, 0) == WAIT_TIMEOUT, HRESULT_FROM_WIN32(ERROR_CANCELLED));
    if (cancel) need(WaitForSingleObject(cancel, 0) == WAIT_TIMEOUT, HRESULT_FROM_WIN32(ERROR_CANCELLED));
  }
};
DWORD transfer(HANDLE object, void* data, DWORD bytes, bool writing, bool overlapped) {
  DWORD done=0; Handle event(overlapped ? CreateEventW(nullptr,TRUE,FALSE,nullptr) : nullptr);
  OVERLAPPED operation{}; operation.hEvent=event.h;
  const BOOL okay=writing ? WriteFile(object,data,bytes,&done,overlapped?&operation:nullptr) : ReadFile(object,data,bytes,&done,overlapped?&operation:nullptr);
  if(!okay) {
    const DWORD error=GetLastError(); need(overlapped && error==ERROR_IO_PENDING,HRESULT_FROM_WIN32(error));
    if(WaitForSingleObject(event.h,5000)!=WAIT_OBJECT_0) { CancelIoEx(object,&operation); GetOverlappedResult(object,&operation,&done,TRUE); throw Error{HRESULT_FROM_WIN32(ERROR_TIMEOUT)}; }
    win(GetOverlappedResult(object,&operation,&done,FALSE));
  }
  return done;
}
std::string line(HANDLE input, Guard& guard, bool overlapped=false) {
  std::string result;
  for (;;) {
    guard.check(); DWORD available = 0;
    win(PeekNamedPipe(input, nullptr, 0, nullptr, &available, nullptr));
    if (!available) { Sleep(20); continue; }
    char c = 0; need(transfer(input,&c,1,false,overlapped)==1);
    need(++guard.readBytes <= 128*1024 && result.size() <= 32768);
    if (c == '\n') return result;
    need(c != '\r' && c != '\0'); result += c;
  }
}
void write(HANDLE output, const std::string& value, bool overlapped=false) {
  need(value.size() <= 128*1024);
  need(transfer(output,const_cast<char*>(value.data()),static_cast<DWORD>(value.size()),true,overlapped)==value.size());
}
FILE_ID_INFO readIdentity(HANDLE pipe, Guard& guard) {
  const auto volume = line(pipe, guard), hex = line(pipe, guard); need(!volume.empty() && volume.size() <= 20 && std::all_of(volume.begin(), volume.end(), [](char c) { return c >= '0' && c <= '9'; }));
  FILE_ID_INFO id{}; id.VolumeSerialNumber = std::stoull(volume); need(hex.size() == 32);
  const std::string digits = "0123456789abcdef";
  for (size_t i=0; i<16; ++i) { const auto a=digits.find(hex[i*2]), b=digits.find(hex[i*2+1]); need(a<16 && b<16); id.FileId.Identifier[i]=static_cast<BYTE>(a*16+b); } return id;
}
std::string resultJson(const CaptureReceipt& r, const char* event) {
  return std::string("{\"event\":\"") + event + "\",\"nonce\":\"" + guid(r.nonce) + "\",\"status\":" + std::to_string(static_cast<unsigned long>(r.status)) +
    ",\"snapshotId\":\"" + guid(r.snapshotId) + "\",\"copyComplete\":" + (r.copyComplete ? "true" : "false") +
    ",\"snapshotReleased\":" + (r.snapshotReleased ? "true" : "false") + ",\"sourceIdentity\":" + identityJson(r.sourceIdentity) + "}\n";
}
void checkpoint(const CaptureReceipt& r, void* pipe) { write(*static_cast<HANDLE*>(pipe), resultJson(r, "checkpoint")); }
std::wstring pipeName(const std::string& nonce) { return L"\\\\.\\pipe\\MurageRecovery-" + wide(nonce); }
std::wstring eventName(const std::string& nonce) { return L"Local\\MurageRecoveryCancel-" + wide(nonce); }
bool expectedPeer(HANDLE pipe, DWORD expected, bool server) {
  ULONG actual = 0; win(server ? GetNamedPipeClientProcessId(pipe, &actual) : GetNamedPipeServerProcessId(pipe, &actual)); return actual == expected;
}
int elevated(DWORD bridgePid, const std::string& nonce) {
  parseNonce(nonce); auto bridge = process(bridgePid); auto bridgeToken = token(bridge.h, TOKEN_QUERY | TOKEN_DUPLICATE); auto selfToken = token(GetCurrentProcess());
  sameSid(sid(bridgeToken.h),sid(selfToken.h));
  need(lower(image(bridge.h)) == lower(ownImage()), E_ACCESSDENIED);
#ifndef MURAGE_TRANSPORT_FIXTURE
  TOKEN_ELEVATION elevation{}; DWORD size = 0; win(GetTokenInformation(selfToken.h, TokenElevation, &elevation, sizeof(elevation), &size)); need(elevation.TokenIsElevated, E_ACCESSDENIED);
#endif
  Handle pipe(CreateFileW(pipeName(nonce).c_str(), GENERIC_READ | GENERIC_WRITE, 0, nullptr, OPEN_EXISTING, SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION, nullptr));
  need(expectedPeer(pipe.h, bridgePid, false), E_ACCESSDENIED);
  Handle cancel(OpenEventW(SYNCHRONIZE | EVENT_MODIFY_STATE, FALSE, eventName(nonce).c_str())); need(cancel.h != nullptr);
  Guard guard{bridge.h, cancel.h};
  need(line(pipe.h, guard) == "MURAGE_RECOVERY_1"); need(line(pipe.h, guard) == nonce, E_ACCESSDENIED);
  ApprovedCapture request; request.nonce=parseNonce(nonce); request.source=wide(line(pipe.h,guard)); request.destination=wide(line(pipe.h,guard)); request.restoreJournalLeaf=wide(line(pipe.h,guard));
  request.sourceIdentity=readIdentity(pipe.h,guard); request.destinationParentIdentity=readIdentity(pipe.h,guard); request.bindDestinationParent=true;
  HANDLE raw = nullptr; win(DuplicateToken(bridgeToken.h, SecurityImpersonation, &raw)); Handle readToken(raw); request.callerReadToken=readToken.h; request.cancelEvent=cancel.h;
#ifdef MURAGE_TRANSPORT_FIXTURE
  request.maxBytes=16*1024*1024;
#endif
  std::jthread monitor([&](std::stop_token stop) { while(!stop.stop_requested()) if (WaitForSingleObject(bridge.h,100)==WAIT_OBJECT_0) { SetEvent(cancel.h); return; } });
  hr(CoInitializeEx(nullptr, COINIT_MULTITHREADED));
  const HRESULT security=CoInitializeSecurity(nullptr,-1,nullptr,nullptr,RPC_C_AUTHN_LEVEL_PKT_PRIVACY,RPC_C_IMP_LEVEL_IMPERSONATE,nullptr,EOAC_DYNAMIC_CLOAKING,nullptr);
  if (FAILED(security)) { CoUninitialize(); throw Error{security}; }
  const auto receipt=captureApprovedInstallation(request,checkpoint,&pipe.h); CoUninitialize();
  write(pipe.h,resultJson(receipt,"result")); return 0;
}
int bridge(DWORD parentPid) {
  checkParent(parentPid); auto parent=process(parentPid); auto selfToken=token(GetCurrentProcess()); auto parentToken=token(parent.h);
  const auto user=sid(selfToken.h); sameSid(user,sid(parentToken.h));
#ifndef MURAGE_TRANSPORT_FIXTURE
  const auto expected=fs::path(ownImage()).parent_path().parent_path()/L"Murage.exe";
  need(lower(image(parent.h))==lower(expected.wstring()),E_ACCESSDENIED);
#endif
  Guard inputGuard{parent.h}; HANDLE input=GetStdHandle(STD_INPUT_HANDLE), output=GetStdHandle(STD_OUTPUT_HANDLE);
  need(line(input,inputGuard)=="MURAGE_RECOVERY_1"); const auto nonce=line(input,inputGuard); parseNonce(nonce); activeNonce=nonce;
  const auto source=wide(line(input,inputGuard)), destination=wide(line(input,inputGuard)), journal=wide(line(input,inputGuard));
  auto sourcePins=pin(source); const auto split=destination.find_last_of(L'\\'); need(split!=std::wstring::npos && part(destination.substr(split+1)));
  auto destinationPins=pin(destination.substr(0,split),FILE_READ_ATTRIBUTES | FILE_ADD_FILE | FILE_ADD_SUBDIRECTORY);
  const auto sourceFinal=lower(finalPath(sourcePins.back().h)); const auto destFinal=lower(finalPath(destinationPins.back().h)+L"\\"+destination.substr(split+1));
  need(destFinal!=sourceFinal && !destFinal.starts_with(sourceFinal+L"\\") && !sourceFinal.starts_with(destFinal+L"\\"));
  const auto sourceId=identity(sourcePins.back().h), destinationId=identity(destinationPins.back().h);
  write(output,"{\"event\":\"prepared\",\"nonce\":\""+nonce+"\",\"sourceIdentity\":"+identityJson(sourceId)+",\"destinationParentIdentity\":"+identityJson(destinationId)+",\"sid\":\""+utf8(user)+"\"}\n");
  if(line(input,inputGuard)!="CONFIRM "+nonce) throw Error{HRESULT_FROM_WIN32(ERROR_CANCELLED)};
  Security security(user);
  Handle cancel(CreateEventW(&security.attributes,TRUE,FALSE,eventName(nonce).c_str())); need(cancel.h && GetLastError()!=ERROR_ALREADY_EXISTS,E_ACCESSDENIED);
  struct CancelOnExit { HANDLE h; ~CancelOnExit(){SetEvent(h);} } cancelOnExit{cancel.h};
  Handle pipe(CreateNamedPipeW(pipeName(nonce).c_str(),PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE | FILE_FLAG_OVERLAPPED,
    PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,1,128*1024,128*1024,0,&security.attributes));
  Handle connected(CreateEventW(nullptr,TRUE,FALSE,nullptr));
  struct Connection {
    HANDLE pipe; OVERLAPPED operation{}; bool pending=false;
    ~Connection() { if(pending) { CancelIoEx(pipe,&operation); DWORD count=0; GetOverlappedResult(pipe,&operation,&count,TRUE); } }
  } connection{pipe.h}; connection.operation.hEvent=connected.h;
  const BOOL ready=ConnectNamedPipe(pipe.h,&connection.operation); const auto connectError=ready?ERROR_SUCCESS:GetLastError();
  connection.pending=!ready && connectError==ERROR_IO_PENDING;
  need(ready || connectError==ERROR_IO_PENDING || connectError==ERROR_PIPE_CONNECTED);
  auto executable=ownImage(); const auto parameters=L"--elevated "+std::to_wstring(GetCurrentProcessId())+L" "+wide(nonce);
  HANDLE rawChild=nullptr;
#ifdef MURAGE_TRANSPORT_FIXTURE
  // Test build only: exercise the transport under the same runner token. This
  // does not prove UAC, an integrity-level transition, or user consent.
  std::wstring command=L"\""+executable+L"\" "+parameters; STARTUPINFOW start{sizeof(start)}; PROCESS_INFORMATION childInfo{};
  win(CreateProcessW(executable.c_str(),command.data(),nullptr,nullptr,FALSE,CREATE_NO_WINDOW,nullptr,nullptr,&start,&childInfo)); CloseHandle(childInfo.hThread); rawChild=childInfo.hProcess;
#else
  hr(CoInitializeEx(nullptr,COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE));
  SHELLEXECUTEINFOW launch{sizeof(launch)}; launch.fMask=SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC; launch.lpVerb=L"runas"; launch.lpFile=executable.c_str(); launch.lpParameters=parameters.c_str(); launch.nShow=SW_HIDE;
  const BOOL launched=ShellExecuteExW(&launch); const DWORD launchError=GetLastError(); CoUninitialize();
  need(launched,HRESULT_FROM_WIN32(launchError)); rawChild=launch.hProcess;
#endif
  Handle child(rawChild); need(child.h!=nullptr);
  Guard peerGuard{parent.h,cancel.h,input};
  if(connection.pending) { while(WaitForSingleObject(connected.h,20)==WAIT_TIMEOUT) { peerGuard.check(); need(WaitForSingleObject(child.h,0)==WAIT_TIMEOUT,E_ACCESSDENIED); } DWORD count=0; win(GetOverlappedResult(pipe.h,&connection.operation,&count,FALSE)); connection.pending=false; }
  peerGuard.check();
  need(expectedPeer(pipe.h,GetProcessId(child.h),true),E_ACCESSDENIED);
  const auto request="MURAGE_RECOVERY_1\n"+nonce+"\n"+utf8(source)+"\n"+utf8(destination)+"\n"+utf8(journal)+"\n"+
    std::to_string(sourceId.VolumeSerialNumber)+"\n"+fileId(sourceId)+"\n"+std::to_string(destinationId.VolumeSerialNumber)+"\n"+fileId(destinationId)+"\n";
  // Complete overlapped connection before synchronous bounded I/O on the pipe.
  write(pipe.h,request,true);
  Handle receipt(CreateFileW((destination+L".capture.json").c_str(),GENERIC_WRITE,0,&security.attributes,CREATE_NEW,FILE_ATTRIBUTE_NORMAL,nullptr));
  for(unsigned messages=0; messages<8; ++messages) {
    const auto response=line(pipe.h,peerGuard,true);
    need(response.size()<8192 && response.find("\"nonce\":\""+nonce+"\"")!=std::string::npos);
    LARGE_INTEGER zero{}; win(SetFilePointerEx(receipt.h,zero,nullptr,FILE_BEGIN)); write(receipt.h,response+"\n"); win(SetEndOfFile(receipt.h)); win(FlushFileBuffers(receipt.h));
    if(response.starts_with("{\"event\":\"result\"")) { write(output,response+"\n"); need(WaitForSingleObject(child.h,10000)==WAIT_OBJECT_0,HRESULT_FROM_WIN32(ERROR_TIMEOUT)); return 0; }
    need(response.starts_with("{\"event\":\"checkpoint\""));
  }
  throw Error{E_INVALIDARG};
}
}
int wmain(int argc,wchar_t** argv) {
  try {
    if(argc==3 && std::wstring(argv[1])==L"--bridge") return bridge(number(argv[2]));
    if(argc==4 && std::wstring(argv[1])==L"--elevated") return elevated(number(argv[2]),utf8(argv[3]));
  } catch(const Error& error) {
      if(!activeNonce.empty()) std::cout<<"{\"event\":\"result\",\"nonce\":\""<<activeNonce<<"\",\"status\":"<<static_cast<unsigned long>(error.code)<<"}\n";
      std::cerr<<"recovery broker status "<<static_cast<unsigned long>(error.code)<<'\n';
    }
    catch(...) { std::cerr<<"recovery broker failed\n"; }
  return 1;
}
