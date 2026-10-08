// SPDX-License-Identifier: AGPL-3.0-or-later
// Non-elevated browser pipe/credential boundary. Never invokes a shell or UAC.
#define NOMINMAX
#define _WIN32_WINNT 0x0602
#include <windows.h>
#include <sddl.h>
#include <aclapi.h>
#include <tlhelp32.h>
#include <atomic>
#include <array>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>
#include <algorithm>
#include <stdexcept>
#include <cstdint>
#include <cstring>
#include <cwctype>

namespace {
constexpr DWORD limit=1024*1024, chunkLimit=65536;
void need(bool value){if(!value)throw std::runtime_error("browser_native_unavailable");}
void win(BOOL value){need(value!=FALSE);}
struct Handle {HANDLE value; explicit Handle(HANDLE h=nullptr):value(h){need(h!=INVALID_HANDLE_VALUE);} ~Handle(){if(value)CloseHandle(value);} Handle(const Handle&)=delete;};
struct Local {void* value=nullptr;~Local(){if(value)LocalFree(value);}};
std::wstring currentSid(HANDLE process=GetCurrentProcess()) {
 HANDLE raw=nullptr;win(OpenProcessToken(process,TOKEN_QUERY,&raw));Handle token(raw);
 DWORD bytes=0;GetTokenInformation(raw,TokenUser,nullptr,0,&bytes);need(bytes>0);
 std::vector<BYTE> data(bytes);win(GetTokenInformation(raw,TokenUser,data.data(),bytes,&bytes));
 LPWSTR text=nullptr;win(ConvertSidToStringSidW(reinterpret_cast<TOKEN_USER*>(data.data())->User.Sid,&text));Local owner{text};return text;
}
struct Security {
 Local descriptor; SECURITY_ATTRIBUTES attributes{sizeof(SECURITY_ATTRIBUTES),nullptr,FALSE};
 explicit Security(const std::wstring& sid,bool inherit=false){
  const auto flags=inherit?L"OICI":L"";const auto sddl=std::wstring(L"O:")+sid+L"D:P(A;"+flags+L";FA;;;SY)(A;"+flags+L";FA;;;"+sid+L")";
  PSECURITY_DESCRIPTOR raw=nullptr;win(ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.c_str(),SDDL_REVISION_1,&raw,nullptr));descriptor.value=raw;attributes.lpSecurityDescriptor=raw;
 }
};
void privateAcl(HANDLE handle,const std::wstring& user) {
 PSID owner=nullptr;PACL acl=nullptr;PSECURITY_DESCRIPTOR descriptor=nullptr;
 need(GetSecurityInfo(handle,SE_FILE_OBJECT,OWNER_SECURITY_INFORMATION|DACL_SECURITY_INFORMATION,&owner,nullptr,&acl,nullptr,&descriptor)==ERROR_SUCCESS);Local actual{descriptor};
 PSID current=nullptr,system=nullptr;win(ConvertStringSidToSidW(user.c_str(),&current));Local a{current};win(ConvertStringSidToSidW(L"S-1-5-18",&system));Local b{system};
 need(owner&&EqualSid(owner,current));SECURITY_DESCRIPTOR_CONTROL control{};DWORD revision=0;win(GetSecurityDescriptorControl(descriptor,&control,&revision));
 need((control&SE_DACL_PROTECTED)&&acl&&acl->AceCount==2);bool sawUser=false,sawSystem=false;
 for(DWORD i=0;i<2;i++){void* raw=nullptr;win(GetAce(acl,i,&raw));auto* ace=static_cast<ACCESS_ALLOWED_ACE*>(raw);
  need(ace->Header.AceType==ACCESS_ALLOWED_ACE_TYPE&&ace->Mask==FILE_ALL_ACCESS);
  need((ace->Header.AceFlags&~(OBJECT_INHERIT_ACE|CONTAINER_INHERIT_ACE|INHERITED_ACE))==0);
  PSID who=&ace->SidStart;need(IsValidSid(who));
  if(EqualSid(who,current)){need(!sawUser);sawUser=true;}else{need(EqualSid(who,system)&&!sawSystem);sawSystem=true;}
 }need(sawUser&&sawSystem);
}
void validPath(const std::wstring& path){need(path.size()>3&&path.size()<8192&&iswalpha(path[0])&&path[1]==L':'&&path[2]==L'\\');need(path.find_first_of(L"\r\n\"<>|?*/")==std::wstring::npos&&path.find(L':',2)==std::wstring::npos);
 size_t at=3;while(at<path.size()){const auto end=path.find(L'\\',at);const auto part=path.substr(at,end==std::wstring::npos?end:end-at);need(!part.empty()&&part!=L"."&&part!=L".."&&part.back()!=L'.'&&part.back()!=L' ');if(end==std::wstring::npos)break;at=end+1;}}
std::wstring parentPath(const std::wstring& path){validPath(path);const auto slash=path.find_last_of(L'\\');need(slash>2);return path.substr(0,slash);}
std::vector<std::shared_ptr<Handle>> pinDirectories(const std::wstring& path){
 validPath(path);std::vector<std::shared_ptr<Handle>> pins;size_t end=3;
 for(;;){const auto part=path.substr(0,end);auto h=std::make_shared<Handle>(CreateFileW(part.c_str(),FILE_READ_ATTRIBUTES|READ_CONTROL,FILE_SHARE_READ|FILE_SHARE_WRITE,nullptr,OPEN_EXISTING,FILE_FLAG_BACKUP_SEMANTICS|FILE_FLAG_OPEN_REPARSE_POINT,nullptr));
  FILE_ATTRIBUTE_TAG_INFO info{};win(GetFileInformationByHandleEx(h->value,FileAttributeTagInfo,&info,sizeof(info)));need((info.FileAttributes&FILE_ATTRIBUTE_DIRECTORY)&&!(info.FileAttributes&FILE_ATTRIBUTE_REPARSE_POINT));pins.push_back(h);
  if(end==path.size())break;const auto next=path.find(L'\\',end==3?3:end+1);const auto leaf=path.substr(end==3?3:end+1,next==std::wstring::npos?next:next-(end==3?3:end+1));need(!leaf.empty()&&leaf!=L"."&&leaf!=L".."&&leaf.back()!=L'.'&&leaf.back()!=L' ');end=next==std::wstring::npos?path.size():next;
 }return pins;
}
std::vector<BYTE> readPrivate(const std::wstring& path){
 auto parents=pinDirectories(parentPath(path));const auto sid=currentSid();privateAcl(parents.back()->value,sid);
 Handle file(CreateFileW(path.c_str(),GENERIC_READ|READ_CONTROL,FILE_SHARE_READ,nullptr,OPEN_EXISTING,FILE_FLAG_OPEN_REPARSE_POINT,nullptr));
 FILE_ATTRIBUTE_TAG_INFO info{};win(GetFileInformationByHandleEx(file.value,FileAttributeTagInfo,&info,sizeof(info)));need(!(info.FileAttributes&(FILE_ATTRIBUTE_DIRECTORY|FILE_ATTRIBUTE_REPARSE_POINT)));privateAcl(file.value,sid);
 LARGE_INTEGER size{};win(GetFileSizeEx(file.value,&size));need(size.QuadPart>=0&&size.QuadPart<=limit);std::vector<BYTE> bytes(static_cast<size_t>(size.QuadPart));DWORD count=0;if(!bytes.empty())win(ReadFile(file.value,bytes.data(),static_cast<DWORD>(bytes.size()),&count,nullptr));need(count==bytes.size());return bytes;
}
void writeAll(HANDLE handle,const BYTE* data,DWORD size){while(size){DWORD done=0;win(WriteFile(handle,data,size,&done,nullptr));need(done>0);data+=done;size-=done;}}
bool readAll(HANDLE handle,BYTE* data,DWORD size){while(size){DWORD done=0;if(!ReadFile(handle,data,size,&done,nullptr)||!done)return false;data+=done;size-=done;}return true;}
std::vector<BYTE> stdinValue(){DWORD size=0;need(readAll(GetStdHandle(STD_INPUT_HANDLE),reinterpret_cast<BYTE*>(&size),4)&&size<=limit);std::vector<BYTE> bytes(size);need(readAll(GetStdHandle(STD_INPUT_HANDLE),bytes.data(),size));return bytes;}
void makePrivateDirectory(const std::wstring& path){auto parents=pinDirectories(parentPath(path));Security security(currentSid(),true);if(!CreateDirectoryW(path.c_str(),&security.attributes))need(GetLastError()==ERROR_ALREADY_EXISTS);auto dirs=pinDirectories(path);privateAcl(dirs.back()->value,currentSid());}
void writePrivate(const std::wstring& path,const std::vector<BYTE>& bytes){
 auto parents=pinDirectories(parentPath(path));const auto sid=currentSid();privateAcl(parents.back()->value,sid);
 if(GetFileAttributesW(path.c_str())!=INVALID_FILE_ATTRIBUTES)(void)readPrivate(path);
 const auto temporary=path+L".new-"+std::to_wstring(GetCurrentProcessId());Security security(sid);
 bool created=false;
 try { {Handle file(CreateFileW(temporary.c_str(),GENERIC_WRITE|READ_CONTROL,0,&security.attributes,CREATE_NEW,FILE_ATTRIBUTE_NORMAL,nullptr));created=true;privateAcl(file.value,sid);writeAll(file.value,bytes.data(),static_cast<DWORD>(bytes.size()));win(FlushFileBuffers(file.value));}
  win(MoveFileExW(temporary.c_str(),path.c_str(),MOVEFILE_REPLACE_EXISTING|MOVEFILE_WRITE_THROUGH));
 }catch(...){if(created)DeleteFileW(temporary.c_str());throw;}
}
void checkParent(DWORD expected){Handle snap(CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS,0));PROCESSENTRY32W entry{sizeof(entry)};win(Process32FirstW(snap.value,&entry));bool found=false;do{if(entry.th32ProcessID==GetCurrentProcessId()){need(entry.th32ParentProcessID==expected);found=true;break;}}while(Process32NextW(snap.value,&entry));need(found);Handle parent(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION,FALSE,expected));need(currentSid(parent.value)==currentSid());}
DWORD processId(const std::wstring& text){need(!text.empty()&&text.size()<11&&std::all_of(text.begin(),text.end(),iswdigit));const auto value=std::stoull(text);need(value>0&&value<=MAXDWORD);return static_cast<DWORD>(value);}
std::atomic<bool> stopping=false;std::mutex outputMutex,connectionsMutex;
struct Connection {DWORD id;std::shared_ptr<Handle> pipe;std::atomic<bool> closed=false;std::mutex writing;};
std::map<DWORD,std::shared_ptr<Connection>> connections;
void emit(BYTE kind,DWORD id,const BYTE* data=nullptr,DWORD size=0){need(size<=chunkLimit);std::lock_guard lock(outputMutex);DWORD length=size+5;HANDLE out=GetStdHandle(STD_OUTPUT_HANDLE);writeAll(out,reinterpret_cast<BYTE*>(&length),4);writeAll(out,reinterpret_cast<BYTE*>(&id),4);writeAll(out,&kind,1);if(size)writeAll(out,data,size);}
void closeConnection(const std::shared_ptr<Connection>& c){if(!c->closed.exchange(true))CancelIoEx(c->pipe->value,nullptr);}
DWORD transfer(const std::shared_ptr<Connection>& c,BYTE* data,DWORD size,bool writing){
 Handle event(CreateEventW(nullptr,TRUE,FALSE,nullptr));OVERLAPPED op{};op.hEvent=event.value;DWORD count=0;
 BOOL okay=writing?WriteFile(c->pipe->value,data,size,&count,&op):ReadFile(c->pipe->value,data,size,&count,&op);
 if(!okay){if(GetLastError()!=ERROR_IO_PENDING)return 0;const auto deadline=GetTickCount64()+5000;
  while(WaitForSingleObject(event.value,100)==WAIT_TIMEOUT){if(stopping||c->closed||(writing&&GetTickCount64()>deadline)){CancelIoEx(c->pipe->value,&op);GetOverlappedResult(c->pipe->value,&op,&count,TRUE);return 0;}}
  if(!GetOverlappedResult(c->pipe->value,&op,&count,FALSE))return 0;
 }return count;
}
int broker(const std::wstring& name,DWORD parent){
 checkParent(parent);const std::wstring prefix=L"\\\\.\\pipe\\murage-browser-";need(name.starts_with(prefix)&&name.size()==prefix.size()+64&&std::all_of(name.begin()+prefix.size(),name.end(),[](wchar_t c){return(c>=L'0'&&c<=L'9')||(c>=L'a'&&c<=L'f');}));
 const auto sid=currentSid();Security security(sid);std::vector<std::pair<std::thread,std::shared_ptr<std::atomic<bool>>>> readers;std::atomic<HANDLE> accepting=nullptr;
 auto first=std::make_shared<Handle>(CreateNamedPipeW(name.c_str(),PIPE_ACCESS_DUPLEX|FILE_FLAG_OVERLAPPED|FILE_FLAG_FIRST_PIPE_INSTANCE,PIPE_TYPE_BYTE|PIPE_READMODE_BYTE|PIPE_WAIT|PIPE_REJECT_REMOTE_CLIENTS,17,chunkLimit,chunkLimit,0,&security.attributes));
 privateAcl(first->value,sid);emit(4,0);
 // The acceptor owns the first pipe instance: a second reference here would keep the first client's pipe open after the broker closed it.
 std::thread acceptor([&,pipe=std::move(first)]() mutable {try{DWORD next=1;while(!stopping){accepting=pipe->value;Handle ready(CreateEventW(nullptr,TRUE,FALSE,nullptr));OVERLAPPED op{};op.hEvent=ready.value;
  const BOOL connected=ConnectNamedPipe(pipe->value,&op);const DWORD error=connected?ERROR_SUCCESS:GetLastError();need(connected||error==ERROR_PIPE_CONNECTED||error==ERROR_IO_PENDING);
  if(error==ERROR_IO_PENDING){while(WaitForSingleObject(ready.value,100)==WAIT_TIMEOUT&&!stopping){}if(stopping){CancelIoEx(pipe->value,&op);DWORD ignored;GetOverlappedResult(pipe->value,&op,&ignored,TRUE);break;}DWORD ignored;win(GetOverlappedResult(pipe->value,&op,&ignored,FALSE));}
  // A client that exits right after connecting makes this check fail: drop that client only, open a fresh pipe instance, keep accepting.
  try{ULONG peer=0;win(GetNamedPipeClientProcessId(pipe->value,&peer));Handle process(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION,FALSE,peer));need(currentSid(process.value)==sid);}
  catch(...){DisconnectNamedPipe(pipe->value);pipe=std::make_shared<Handle>(CreateNamedPipeW(name.c_str(),PIPE_ACCESS_DUPLEX|FILE_FLAG_OVERLAPPED,PIPE_TYPE_BYTE|PIPE_READMODE_BYTE|PIPE_WAIT|PIPE_REJECT_REMOTE_CLIENTS,17,chunkLimit,chunkLimit,0,&security.attributes));privateAcl(pipe->value,sid);continue;}
  auto c=std::make_shared<Connection>();c->id=next++;need(next!=0);c->pipe=pipe;
  // A full table refuses only the excess client; it never stops the broker or the sessions it already serves.
  bool full=false;{std::lock_guard lock(connectionsMutex);full=connections.size()>=16;if(!full)connections[c->id]=c;}
  if(full){DisconnectNamedPipe(pipe->value);pipe=std::make_shared<Handle>(CreateNamedPipeW(name.c_str(),PIPE_ACCESS_DUPLEX|FILE_FLAG_OVERLAPPED,PIPE_TYPE_BYTE|PIPE_READMODE_BYTE|PIPE_WAIT|PIPE_REJECT_REMOTE_CLIENTS,17,chunkLimit,chunkLimit,0,&security.attributes));privateAcl(pipe->value,sid);continue;}
  for(auto it=readers.begin();it!=readers.end();){if(it->second->load()){it->first.join();it=readers.erase(it);}else ++it;}
  auto finished=std::make_shared<std::atomic<bool>>(false);
  emit(1,c->id);readers.emplace_back(std::thread([c,finished]{try{std::array<BYTE,chunkLimit> bytes;while(!stopping&&!c->closed){const DWORD size=transfer(c,bytes.data(),chunkLimit,false);if(!size)break;emit(2,c->id,bytes.data(),size);}}catch(...){}closeConnection(c);DisconnectNamedPipe(c->pipe->value);try{emit(3,c->id);}catch(...){}std::lock_guard lock(connectionsMutex);connections.erase(c->id);*finished=true;}),finished);
  pipe=std::make_shared<Handle>(CreateNamedPipeW(name.c_str(),PIPE_ACCESS_DUPLEX|FILE_FLAG_OVERLAPPED,PIPE_TYPE_BYTE|PIPE_READMODE_BYTE|PIPE_WAIT|PIPE_REJECT_REMOTE_CLIENTS,17,chunkLimit,chunkLimit,0,&security.attributes));privateAcl(pipe->value,sid);
 }}catch(...){stopping=true;try{emit(5,0);}catch(...){}CancelIoEx(GetStdHandle(STD_INPUT_HANDLE),nullptr);}accepting=nullptr;});
 try {for(;;){DWORD length=0;if(!readAll(GetStdHandle(STD_INPUT_HANDLE),reinterpret_cast<BYTE*>(&length),4))break;need(length>=5&&length<=chunkLimit+5);std::vector<BYTE> frame(length);need(readAll(GetStdHandle(STD_INPUT_HANDLE),frame.data(),length));DWORD id=0;memcpy(&id,frame.data(),4);const BYTE kind=frame[4];std::shared_ptr<Connection> c;{std::lock_guard lock(connectionsMutex);auto found=connections.find(id);if(found!=connections.end())c=found->second;}if(!c)continue;if(kind==2){closeConnection(c);continue;}need(kind==1);std::lock_guard lock(c->writing);DWORD at=5;while(at<length){const DWORD sent=transfer(c,frame.data()+at,length-at,true);if(!sent){closeConnection(c);break;}at+=sent;}}}catch(...){}
 stopping=true;if(accepting.load())CancelIoEx(accepting.load(),nullptr);acceptor.join();{std::lock_guard lock(connectionsMutex);for(auto& [id,c]:connections)closeConnection(c);}for(auto& thread:readers)thread.first.join();return 0;
}
std::wstring quote(const std::wstring& value){std::wstring out=L"\"";size_t slashes=0;for(wchar_t ch:value){if(ch==L'\\'){slashes++;continue;}out.append(ch==L'"'?slashes*2+1:slashes,L'\\');slashes=0;out+=ch;}out.append(slashes*2,L'\\');return out+L"\"";}
std::wstring wide(const std::string& text){const int size=MultiByteToWideChar(CP_UTF8,MB_ERR_INVALID_CHARS,text.data(),static_cast<int>(text.size()),nullptr,0);need(size>0);std::wstring out(size,L'\0');win(MultiByteToWideChar(CP_UTF8,MB_ERR_INVALID_CHARS,text.data(),static_cast<int>(text.size()),out.data(),size));return out;}
int launch(){
 std::wstring own(32768,L'\0');const DWORD length=GetModuleFileNameW(nullptr,own.data(),static_cast<DWORD>(own.size()));need(length>0&&length<own.size());own.resize(length);
 const auto bytes=readPrivate(own+L".launch");const std::string text(bytes.begin(),bytes.end());std::vector<std::wstring> paths;size_t at=0;while(at<text.size()){const auto end=text.find('\n',at);need(end!=std::string::npos);paths.push_back(wide(text.substr(at,end-at)));at=end+1;}need(paths.size()==3);for(const auto& p:paths)validPath(p);
 // Browser origin argv is not used as authority. The manifest and HMAC broker are authoritative.
 std::wstring command=quote(paths[0])+L" "+quote(paths[1])+L" "+quote(paths[2]);win(SetEnvironmentVariableW(L"ELECTRON_RUN_AS_NODE",L"1"));
 STARTUPINFOEXW startup{};startup.StartupInfo.cb=sizeof(startup);startup.StartupInfo.dwFlags=STARTF_USESTDHANDLES;
 std::array<HANDLE,3> inherited{};for(int i=0;i<3;i++)win(DuplicateHandle(GetCurrentProcess(),GetStdHandle(i==0?STD_INPUT_HANDLE:i==1?STD_OUTPUT_HANDLE:STD_ERROR_HANDLE),GetCurrentProcess(),&inherited[i],0,TRUE,DUPLICATE_SAME_ACCESS));
 startup.StartupInfo.hStdInput=inherited[0];startup.StartupInfo.hStdOutput=inherited[1];startup.StartupInfo.hStdError=inherited[2];
 SIZE_T size=0;InitializeProcThreadAttributeList(nullptr,1,0,&size);std::vector<BYTE> attributes(size);startup.lpAttributeList=reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(attributes.data());win(InitializeProcThreadAttributeList(startup.lpAttributeList,1,0,&size));
 win(UpdateProcThreadAttribute(startup.lpAttributeList,0,PROC_THREAD_ATTRIBUTE_HANDLE_LIST,inherited.data(),sizeof(inherited),nullptr,nullptr));
 PROCESS_INFORMATION child{};const BOOL started=CreateProcessW(paths[0].c_str(),command.data(),nullptr,nullptr,TRUE,EXTENDED_STARTUPINFO_PRESENT|CREATE_NO_WINDOW,nullptr,nullptr,&startup.StartupInfo,&child);
 DeleteProcThreadAttributeList(startup.lpAttributeList);for(HANDLE h:inherited)CloseHandle(h);win(started);Handle process(child.hProcess),thread(child.hThread);WaitForSingleObject(process.value,INFINITE);DWORD code=72;win(GetExitCodeProcess(process.value,&code));return static_cast<int>(code);
}
void registration(const std::wstring& browser,const std::wstring& hostName,const std::wstring& manifest,bool remove){
 need(!hostName.empty()&&hostName.size()<=255&&hostName.find(L'.')!=std::wstring::npos&&hostName.front()!=L'.'&&hostName.back()!=L'.'&&hostName.find(L"..") == std::wstring::npos);
 need(std::all_of(hostName.begin(),hostName.end(),[](wchar_t c){return(c>=L'a'&&c<=L'z')||(c>=L'0'&&c<=L'9')||c==L'_'||c==L'.';}));
 validPath(manifest);std::wstring vendor;if(browser==L"chrome")vendor=L"Google\\Chrome";else if(browser==L"edge")vendor=L"Microsoft\\Edge";else if(browser==L"brave")vendor=L"Chromium";else if(browser==L"chromium")vendor=L"Chromium";else throw std::runtime_error("browser");
 const auto key=L"Software\\"+vendor+L"\\NativeMessagingHosts\\"+hostName;HKEY raw=nullptr;DWORD disposition=0;
 const auto opened=remove?RegOpenKeyExW(HKEY_CURRENT_USER,key.c_str(),0,KEY_QUERY_VALUE|KEY_SET_VALUE,&raw):RegCreateKeyExW(HKEY_CURRENT_USER,key.c_str(),0,nullptr,0,KEY_QUERY_VALUE|KEY_SET_VALUE,nullptr,&raw,&disposition);
 if(remove&&opened==ERROR_FILE_NOT_FOUND)return;need(opened==ERROR_SUCCESS);struct Key{HKEY value;~Key(){RegCloseKey(value);}}held{raw};
 std::array<wchar_t,32768> existing{};DWORD size=sizeof(existing),type=0;const auto found=RegQueryValueExW(raw,nullptr,nullptr,&type,reinterpret_cast<BYTE*>(existing.data()),&size);
 if(found==ERROR_SUCCESS)need(type==REG_SZ&&size>=sizeof(wchar_t)&&size<=sizeof(existing)&&existing[size/sizeof(wchar_t)-1]==0&&std::wstring(existing.data())==manifest);else need(!remove&&found==ERROR_FILE_NOT_FOUND);
 if(remove){need(RegDeleteValueW(raw,nullptr)==ERROR_SUCCESS);DWORD children=0,values=0;need(RegQueryInfoKeyW(raw,nullptr,nullptr,nullptr,&children,nullptr,nullptr,&values,nullptr,nullptr,nullptr,nullptr)==ERROR_SUCCESS);RegCloseKey(raw);held.value=nullptr;if(!children&&!values)need(RegDeleteKeyW(HKEY_CURRENT_USER,key.c_str())==ERROR_SUCCESS);}else need(RegSetValueExW(raw,nullptr,0,REG_SZ,reinterpret_cast<const BYTE*>(manifest.c_str()),static_cast<DWORD>((manifest.size()+1)*sizeof(wchar_t)))==ERROR_SUCCESS);
}

}
int wmain(int argc,wchar_t** argv){try{
 if(argc==5&&(std::wstring(argv[1])==L"--register"||std::wstring(argv[1])==L"--unregister")){registration(argv[2],argv[3],argv[4],std::wstring(argv[1])==L"--unregister");return 0;}
 if(argc==1||(argc>1&&std::wstring(argv[1]).starts_with(L"chrome-extension://")))return launch();
 if(argc==4&&std::wstring(argv[1])==L"--broker")return broker(argv[2],processId(argv[3]));
 if(argc==3&&std::wstring(argv[1])==L"--mkdir"){makePrivateDirectory(argv[2]);return 0;}
 if(argc==3&&std::wstring(argv[1])==L"--read"){const auto bytes=readPrivate(argv[2]);writeAll(GetStdHandle(STD_OUTPUT_HANDLE),bytes.data(),static_cast<DWORD>(bytes.size()));return 0;}
 if(argc==3&&std::wstring(argv[1])==L"--write"){writePrivate(argv[2],stdinValue());return 0;}
 throw std::runtime_error("usage");
}catch(...){const char text[]="Browser native helper unavailable.\n";DWORD count;WriteFile(GetStdHandle(STD_ERROR_HANDLE),text,sizeof(text)-1,&count,nullptr);return 72;}}
