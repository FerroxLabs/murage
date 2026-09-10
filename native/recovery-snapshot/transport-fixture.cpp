// Separate test build. Production broker has no emulated-elevation flag.
#define MURAGE_TRANSPORT_FIXTURE
#define wmain brokerEntry
#include "broker.cpp"
#undef wmain

int wmain(int argc,wchar_t** argv) {
  if(argc>1) return brokerEntry(argc,argv);
  const char* stage="COM/GUID";
  try {
    hr(CoInitializeEx(nullptr,COINIT_MULTITHREADED));
    GUID id{}; hr(CoCreateGuid(&id)); const auto nonce=guid(id);
    stage="caller token/SID"; auto self=token(GetCurrentProcess(),TOKEN_QUERY | TOKEN_DUPLICATE); const auto user=sid(self.h);
    stage="wrong SID refusal";
    bool refused=false; try { sameSid(user,L"S-1-5-18"); } catch(const Error& e) { refused=e.code==E_ACCESSDENIED; } need(refused);
    stage="wrong nonce refusal"; refused=false; try { parseNonce(nonce+"x"); } catch(const Error&) { refused=true; } need(refused);
    stage="pipe security/server";
    Security security(user);
    Handle pipe(CreateNamedPipeW(pipeName(nonce).c_str(),PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE,
      PIPE_TYPE_BYTE | PIPE_REJECT_REMOTE_CLIENTS,1,8192,8192,0,&security.attributes));
    stage="pipe client"; Handle client(CreateFileW(pipeName(nonce).c_str(),GENERIC_READ | GENERIC_WRITE,0,nullptr,OPEN_EXISTING,SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION,nullptr));
    stage="pipe connect";
    const BOOL connected=ConnectNamedPipe(pipe.h,nullptr); need(connected || GetLastError()==ERROR_PIPE_CONNECTED);
    stage="client PID binding"; need(expectedPeer(pipe.h,GetCurrentProcessId(),true)); need(!expectedPeer(pipe.h,GetCurrentProcessId()+1,true));
    stage="server PID binding"; need(expectedPeer(client.h,GetCurrentProcessId(),false)); need(!expectedPeer(client.h,GetCurrentProcessId()+1,false));
    stage="first instance refusal";
    HANDLE duplicate=CreateNamedPipeW(pipeName(nonce).c_str(),PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE,PIPE_TYPE_BYTE,1,8192,8192,0,&security.attributes);
    const DWORD duplicateError=GetLastError();
    std::cerr<<"first-instance duplicate status "<<duplicateError<<'\n';
    need(duplicate==INVALID_HANDLE_VALUE && duplicateError==ERROR_ACCESS_DENIED);
    stage="temporary root";
    wchar_t temporary[32768]{}; need(GetTempPathW(32768,temporary)>0);
    const fs::path root=fs::path(temporary)/(L"murage-transport-access-"+wide(nonce)); win(CreateDirectoryW(root.c_str(),nullptr));
    const auto file=root/L"denied";
    PSECURITY_DESCRIPTOR raw=nullptr;
    const auto sddl=L"D:P(D;;FR;;;"+user+L")(A;;RCWDWO;;;"+user+L")";
    stage="denied-file security descriptor"; win(ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.c_str(),SDDL_REVISION_1,&raw,nullptr));
    SECURITY_ATTRIBUTES attributes{sizeof(attributes),raw,FALSE};
    stage="denied-file handle"; Handle denied(CreateFileW(file.c_str(),READ_CONTROL,0,&attributes,CREATE_NEW,FILE_ATTRIBUTE_NORMAL,nullptr)); LocalFree(raw);
    stage="caller impersonation token"; HANDLE rawToken=nullptr; win(DuplicateToken(self.h,SecurityImpersonation,&rawToken)); Handle caller(rawToken);
    stage="caller access denial"; const HRESULT access=captureReadAccess(denied.h,caller.h,false);
    std::cerr<<"caller access status "<<static_cast<unsigned long>(access)<<'\n'; need(access==E_ACCESSDENIED);
    // Source-directory replacement while confirmation is outstanding is denied
    // by the same pinned native directory handles used by the bridge.
    stage="source pin"; const auto source=root/L"source"; win(CreateDirectoryW(source.c_str(),nullptr)); auto held=pin(source.wstring());
    stage="pinned-source replacement refusal"; const BOOL moved=MoveFileExW(source.c_str(),(root/L"moved").c_str(),0); const DWORD moveError=GetLastError();
    std::cerr<<"pinned-source move status "<<moved<<' '<<moveError<<'\n'; need(!moved); need(moveError==ERROR_SHARING_VIOLATION || moveError==ERROR_ACCESS_DENIED);
    std::cout<<"PASS native peer PID, SID, nonce, first-instance, access denial and pinned-source checks\n";
    CoUninitialize(); return 0;
  } catch(const Error& error) { std::cerr<<"native fixture failed at "<<stage<<" status "<<static_cast<unsigned long>(error.code)<<'\n'; return 1; }
    catch(...) { return 2; }
}
