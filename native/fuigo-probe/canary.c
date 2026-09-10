/* Synthetic qualification binary. Not shipped to customers. */
#ifdef _WIN32
#define _WIN32_WINNT 0x0602
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <stdio.h>
#include <wchar.h>
static int connection(int family, int port) {
  SOCKET value = socket(family, SOCK_STREAM, IPPROTO_TCP); if (value == INVALID_SOCKET) return 0;
  u_long one = 1; ioctlsocket(value, FIONBIO, &one);
  struct sockaddr_in v4 = {0}; struct sockaddr_in6 v6 = {0};
  v4.sin_family = AF_INET; v4.sin_port = htons((u_short)port); v4.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  v6.sin6_family = AF_INET6; v6.sin6_port = htons((u_short)port); v6.sin6_addr = in6addr_loopback;
  int result = connect(value, family == AF_INET ? (struct sockaddr *)&v4 : (struct sockaddr *)&v6, family == AF_INET ? sizeof(v4) : sizeof(v6));
  if (result == SOCKET_ERROR && WSAGetLastError() == WSAEWOULDBLOCK) {
    fd_set ready, errors; FD_ZERO(&ready); FD_ZERO(&errors); FD_SET(value, &ready); FD_SET(value, &errors); struct timeval wait = {2, 0};
    if (select(0, NULL, &ready, &errors, &wait) > 0) { int error = 0, size = sizeof(error); getsockopt(value, SOL_SOCKET, SO_ERROR, (char *)&error, &size); result = error ? -1 : 0; }
  }
  closesocket(value); return result == 0;
}
int wmain(int argc, wchar_t **argv) {
  if (argc == 2 && !wcscmp(argv[1], L"hold")) { printf("%lu\n", (unsigned long)GetCurrentProcessId()); fflush(stdout); Sleep(60000); return 0; }
  if (argc != 6) return 2;
  WSADATA data; if (WSAStartup(MAKEWORD(2,2), &data)) return 3;
  HANDLE token = NULL; DWORD app = 0, size = 0; int isolated = 0; BOOL administrator = TRUE; BYTE adminBuffer[SECURITY_MAX_SID_SIZE]; DWORD adminSize = sizeof(adminBuffer);
  if (!CreateWellKnownSid(WinBuiltinAdministratorsSid, NULL, adminBuffer, &adminSize) || !CheckTokenMembership(NULL, adminBuffer, &administrator)) return 4;
  if (OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) { GetTokenInformation(token, TokenIsAppContainer, &app, sizeof(app), &size); isolated = app != 0; CloseHandle(token); }
  FILE *outside = _wfopen(argv[4], L"rb"), *inside = _wfopen(argv[5], L"rb");
  int outsideRead = outside != NULL, insideRead = inside != NULL;
  if (outside) fclose(outside); if (inside) fclose(inside);
  printf("{\"network4\":%d,\"network6\":%d,\"outsideRead\":%d,\"insideRead\":%d,\"isolated\":%d,\"syscallsDenied\":1,\"administrator\":%d}\n", connection(AF_INET, _wtoi(argv[2])), connection(AF_INET6, _wtoi(argv[3])), outsideRead, insideRead, isolated, administrator != FALSE);
  WSACleanup(); return 0;
}
#else
#define _GNU_SOURCE
#include <arpa/inet.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/socket.h>
#include <sys/syscall.h>
#include <unistd.h>
static int connection(int family, int port) {
  int value = socket(family, SOCK_STREAM, 0); if (value < 0) return errno == EPERM ? 0 : -1;
  struct sockaddr_in v4 = { .sin_family = AF_INET, .sin_port = htons((unsigned short)port), .sin_addr.s_addr = htonl(INADDR_LOOPBACK) };
  struct sockaddr_in6 v6 = { .sin6_family = AF_INET6, .sin6_port = htons((unsigned short)port), .sin6_addr = IN6ADDR_LOOPBACK_INIT };
  int result = connect(value, family == AF_INET ? (struct sockaddr *)&v4 : (struct sockaddr *)&v6, family == AF_INET ? sizeof(v4) : sizeof(v6));
  close(value); return result == 0;
}
int main(int argc, char **argv) {
  if (argc == 2 && !strcmp(argv[1], "hold")) { printf("%ld\n", (long)getpid()); fflush(stdout); sleep(60); return 0; }
  if (argc != 6) return 2;
  FILE *outside = fopen(argv[4], "rb"), *inside = fopen(argv[5], "rb");
  int outsideRead = outside != NULL, insideRead = inside != NULL, denied = 1;
  if (outside) fclose(outside); if (inside) fclose(inside);
  if (!strcmp(argv[1], "restricted")) {
    errno = 0; if (syscall(SYS_io_uring_setup, 0, NULL) != -1 || errno != EPERM) denied = 0;
    errno = 0; if (syscall(SYS_pidfd_getfd, -1, 0, 0) != -1 || errno != EPERM) denied = 0;
    errno = 0; if (syscall(SYS_process_vm_readv, getppid(), NULL, 0, NULL, 0, 0) != -1 || errno != EPERM) denied = 0;
    errno = 0; int pair[2]; if (socketpair(AF_UNIX, SOCK_STREAM, 0, pair) != -1 || errno != EPERM) denied = 0;
  }
  printf("{\"network4\":%d,\"network6\":%d,\"outsideRead\":%d,\"insideRead\":%d,\"isolated\":%d,\"syscallsDenied\":%d,\"administrator\":%d}\n", connection(AF_INET, atoi(argv[2])), connection(AF_INET6, atoi(argv[3])), outsideRead, insideRead, prctl(PR_GET_NO_NEW_PRIVS, 0, 0, 0, 0) == 1, denied, geteuid() == 0);
  return 0;
}
#endif
