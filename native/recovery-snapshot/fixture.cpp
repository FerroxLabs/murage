// TEST-ONLY executable. Not packaged, signed, installed or used for elevation.
#define NOMINMAX
#include "capture.h"
#include <filesystem>
#include <fstream>
#include <iostream>
#include <sstream>

using namespace murage::recovery;
namespace fs = std::filesystem;
struct Context { fs::path receipt; bool notified = false; };
std::string guid(const GUID& value) {
  wchar_t text[40]{}; StringFromGUID2(value, text, 40);
  return std::string(text, text + wcslen(text));
}
std::string facts(const CaptureReceipt& r) {
  std::ostringstream out;
  out << "{\"nonce\":\"" << guid(r.nonce) << "\",\"snapshotId\":\"" << guid(r.snapshotId)
      << "\",\"status\":" << static_cast<unsigned long>(r.status)
      << ",\"cleanupStatus\":" << static_cast<unsigned long>(r.cleanupStatus)
      << ",\"copyComplete\":" << (r.copyComplete ? "true" : "false")
      << ",\"snapshotReleased\":" << (r.snapshotReleased ? "true" : "false")
      << ",\"captureTime\":\"" << r.captureTime << "\",\"volumeSerial\":\"" << r.sourceIdentity.VolumeSerialNumber
      << "\",\"fileId\":\"";
  const char* digits = "0123456789abcdef";
  for (auto byte : r.sourceIdentity.FileId.Identifier) out << digits[byte >> 4] << digits[byte & 15];
  out << "\",\"volume\":\"";
  for (auto c : r.volume) { if (c == L'\\') out << '\\'; out << static_cast<char>(c); }
  out << "\",\"bytes\":" << r.bytes << ",\"entries\":" << r.entries << "}"; return out.str();
}
void save(const CaptureReceipt& receipt, void* opaque) {
  auto& context = *static_cast<Context*>(opaque);
  const auto body = facts(receipt);
  // Durable receipt stays outside source and clone. Preserve it on failure.
  HANDLE file = CreateFileW(context.receipt.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (file == INVALID_HANDLE_VALUE) throw std::runtime_error("receipt open");
  DWORD written = 0;
  const bool okay = WriteFile(file, body.data(), static_cast<DWORD>(body.size()), &written, nullptr) && written == body.size() && FlushFileBuffers(file);
  CloseHandle(file); if (!okay) throw std::runtime_error("receipt write");
  if (receipt.captureTime && !context.notified) {
    context.notified = true;
    std::cout << "{\"event\":\"captured\"}" << std::endl;
    std::string command; std::getline(std::cin, command);
    if (command != "continue") throw std::runtime_error("fixture interrupted");
  }
}
int wmain(int argc, wchar_t** argv) {
  if (argc != 4 || !std::getenv("GITHUB_ACTIONS")) return 90;
  const fs::path root = fs::canonical(argv[1]);
  const auto temporary = fs::canonical(fs::path(std::getenv("RUNNER_TEMP")));
  if (root.parent_path() != temporary || !root.filename().wstring().starts_with(L"murage-vss-fixture-")) return 91;
  const std::wstring scenario(argv[2]);
  if (scenario != L"idle" && scenario != L"concurrent" && scenario != L"journal" && scenario != L"restore" && scenario != L"reparse" && scenario != L"quota" && scenario != L"cancel" && scenario != L"identity" && scenario != L"unc" && scenario != L"overlap" && scenario != L"invalid-records") return 92;
  HRESULT status = CoInitializeEx(nullptr, COINIT_MULTITHREADED); if (FAILED(status)) return 93;
  status = CoInitializeSecurity(nullptr, -1, nullptr, nullptr, RPC_C_AUTHN_LEVEL_PKT_PRIVACY,
    RPC_C_IMP_LEVEL_IMPERSONATE, nullptr, EOAC_DYNAMIC_CLOAKING, nullptr);
  if (FAILED(status)) { CoUninitialize(); return 94; }
  ApprovedCapture request;
  request.source = (root / L"source").wstring(); request.destination = (root / L"clone").wstring();
  request.restoreJournalLeaf = argv[3]; request.maxBytes = scenario == L"quota" ? 128 : 16*1024*1024;
  CoCreateGuid(&request.nonce);
  HANDLE source = CreateFileW(request.source.c_str(), FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
    nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
  if (source == INVALID_HANDLE_VALUE || !GetFileInformationByHandleEx(source, FileIdInfo, &request.sourceIdentity, sizeof(request.sourceIdentity))) return 95;
  CloseHandle(source);
  if (scenario == L"identity") ++request.sourceIdentity.FileId.Identifier[0];
  if (scenario == L"unc") request.source = L"\\\\localhost\\C$\\unsupported";
  if (scenario == L"overlap") request.destination = request.source + L"\\clone";
  if (scenario == L"cancel") request.cancelEvent = CreateEventW(nullptr, TRUE, TRUE, nullptr);
  Context context{root / L"receipt.json"};
  auto receipt = captureApprovedInstallation(request, save, &context);
  std::cout << "{\"event\":\"result\",\"receipt\":" << facts(receipt) << "}" << std::endl;
  if (request.cancelEvent) CloseHandle(request.cancelEvent);
  CoUninitialize(); return 0;
}
