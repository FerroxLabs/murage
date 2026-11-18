/* Disposable OS-feasibility probe owner: Builder B; native build/execution owner: MAIN. Never a candidate or slice-6 witness. */
#include <windows.h>
#include <stdio.h>
int main(void) {
    wchar_t directory[32768], path[32768];
    DWORD length = GetEnvironmentVariableW(L"TEMP", directory, 32768);
    if (!length || length > 32000) return 3;
    if (swprintf(path, 32768, L"%ls\\s4-native-marker.json", directory) < 0) return 3;
    HANDLE token = NULL;
    BOOL opened = OpenProcessToken(GetCurrentProcess(), TOKEN_ADJUST_PRIVILEGES | TOKEN_QUERY, &token);
    DWORD error = opened ? ERROR_SUCCESS : GetLastError();
    if (token) CloseHandle(token);
    HANDLE output = CreateFileW(path, GENERIC_WRITE, 0, NULL, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, NULL);
    if (output == INVALID_HANDLE_VALUE) return 3;
    char bytes[256];
    int size = snprintf(bytes, sizeof bytes, "{\"api\":\"OpenProcessToken\",\"requestedAccess\":40,\"succeeded\":%s,\"error\":%lu,\"osFeasibilityOnly\":true}", opened ? "true" : "false", (unsigned long)error);
    DWORD written = 0;
    BOOL ok = size > 0 && WriteFile(output, bytes, (DWORD)size, &written, NULL) && written == (DWORD)size && FlushFileBuffers(output);
    CloseHandle(output);
    return ok ? 0 : 3;
}
