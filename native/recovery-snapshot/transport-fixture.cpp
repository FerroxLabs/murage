// Separate test build. Production broker has no emulated-elevation flag.
#define MURAGE_TRANSPORT_FIXTURE
#define wmain brokerEntry
#include "broker.cpp"
#undef wmain

int wmain(int argc,wchar_t** argv) {
  if(argc>1) return brokerEntry(argc,argv);
  try {
    hr(CoInitializeEx(nullptr,COINIT_MULTITHREADED));
    GUID id{}; hr(CoCreateGuid(&id)); const auto nonce=guid(id);
    auto self=token(GetCurrentProcess(),TOKEN_QUERY | TOKEN_DUPLICATE); const auto user=sid(self.h);
    bool refused=false; try { sameSid(user,L"S-1-5-18"); } catch(const Error& e) { refused=e.code==E_ACCESSDENIED; } need(refused);
    refused=false; try { parseNonce(nonce+"x"); } catch(const Error&) { refused=true; } need(refused);
    Security security(user);
    Handle pipe(CreateNamedPipeW(pipeName(nonce).c_str(),PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE,
      PIPE_TYPE_BYTE | PIPE_REJECT_REMOTE_CLIENTS,1,8192,8192,0,&security.attributes));
    Handle client(CreateFileW(pipeName(nonce).c_str(),GENERIC_READ | GENERIC_WRITE,0,nullptr,OPEN_EXISTING,SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION,nullptr));
    const BOOL connected=ConnectNamedPipe(pipe.h,nullptr); need(connected || GetLastError()==ERROR_PIPE_CONNECTED);
    need(expectedPeer(pipe.h,GetCurrentProcessId(),true)); need(!expectedPeer(pipe.h,GetCurrentProcessId()+1,true));
    need(expectedPeer(client.h,GetCurrentProcessId(),false)); need(!expectedPeer(client.h,GetCurrentProcessId()+1,false));
    HANDLE duplicate=CreateNamedPipeW(pipeName(nonce).c_str(),PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE,PIPE_TYPE_BYTE,1,8192,8192,0,&security.attributes);
    need(duplicate==INVALID_HANDLE_VALUE && GetLastError()==ERROR_ACCESS_DENIED);
    wchar_t temporary[32768]{}; need(GetTempPathW(32768,temporary)>0);
    const fs::path root=fs::path(temporary)/(L"murage-transport-access-"+wide(nonce)); win(CreateDirectoryW(root.c_str(),nullptr));
    const auto file=root/L"denied";
    PSECURITY_DESCRIPTOR raw=nullptr;
    const auto sddl=L"D:P(D;;FR;;;"+user+L")(A;;RCWDWO;;;"+user+L")";
    win(ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.c_str(),SDDL_REVISION_1,&raw,nullptr));
    SECURITY_ATTRIBUTES attributes{sizeof(attributes),raw,FALSE};
    Handle denied(CreateFileW(file.c_str(),READ_CONTROL,0,&attributes,CREATE_NEW,FILE_ATTRIBUTE_NORMAL,nullptr)); LocalFree(raw);
    HANDLE rawToken=nullptr; win(DuplicateToken(self.h,SecurityImpersonation,&rawToken)); Handle caller(rawToken);
    need(captureReadAccess(denied.h,caller.h,false)==E_ACCESSDENIED);
    // Source-directory replacement while confirmation is outstanding is denied
    // by the same pinned native directory handles used by the bridge.
    const auto source=root/L"source"; win(CreateDirectoryW(source.c_str(),nullptr)); auto held=pin(source.wstring());
    need(!MoveFileExW(source.c_str(),(root/L"moved").c_str(),0)); need(GetLastError()==ERROR_SHARING_VIOLATION || GetLastError()==ERROR_ACCESS_DENIED);
    std::cout<<"PASS native peer PID, SID, nonce, first-instance, access denial and pinned-source checks\n";
    CoUninitialize(); return 0;
  } catch(const Error& error) { std::cerr<<"native fixture failed "<<static_cast<unsigned long>(error.code)<<'\n'; return 1; }
    catch(...) { return 2; }
}
