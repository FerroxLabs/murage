/* Linux-only native Fuigo updater isolation; Windows remains unqualified. */
#define _GNU_SOURCE
#include <arpa/inet.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/socket.h>
#include <sys/syscall.h>
#include <sys/un.h>
#include <unistd.h>
static int connection(int family, int port) {
  int value = socket(family, SOCK_STREAM, 0); if (value < 0) return errno == EPERM ? 0 : -1;
  struct sockaddr_in v4 = { .sin_family = AF_INET, .sin_port = htons((unsigned short)port), .sin_addr.s_addr = htonl(INADDR_LOOPBACK) };
  struct sockaddr_in6 v6 = { .sin6_family = AF_INET6, .sin6_port = htons((unsigned short)port), .sin6_addr = IN6ADDR_LOOPBACK_INIT };
  int result = connect(value, family == AF_INET ? (struct sockaddr *)&v4 : (struct sockaddr *)&v6, family == AF_INET ? sizeof(v4) : sizeof(v6));
  close(value); return result == 0;
}
static int unix_connection(const char *path) {
  int value = socket(AF_UNIX, SOCK_STREAM, 0); if (value < 0) return errno == EPERM ? 0 : -1;
  struct sockaddr_un address = { .sun_family = AF_UNIX };
  if (strlen(path) >= sizeof(address.sun_path)) { close(value); return -1; }
  strcpy(address.sun_path, path);
  int result = connect(value, (struct sockaddr *)&address, sizeof(address)); close(value); return result == 0;
}
static int private_pair(void) {
  int pair[2]; char value = 0;
  if (socketpair(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC | SOCK_NONBLOCK, 0, pair)) return 0;
  int result = write(pair[0], "x", 1) == 1 && read(pair[1], &value, 1) == 1 && value == 'x';
  close(pair[0]); close(pair[1]); return result;
}
static int denied_pair(int family, int type, int protocol) {
  int pair[2]; errno = 0;
  if (socketpair(family, type, protocol, pair) == -1) return errno == EPERM;
  close(pair[0]); close(pair[1]); return 0;
}
int main(int argc, char **argv) {
  if (argc == 2 && !strcmp(argv[1], "hold")) { printf("%ld\n", (long)getpid()); fflush(stdout); sleep(60); return 0; }
  if (argc != 7) return 2;
  FILE *outside = fopen(argv[4], "rb"), *inside = fopen(argv[5], "rb");
  int outsideRead = outside != NULL, insideRead = inside != NULL, denied = 1;
  if (outside) fclose(outside); if (inside) fclose(inside);
  if (!strcmp(argv[1], "restricted")) {
    errno = 0; if (syscall(SYS_io_uring_setup, 0, NULL) != -1 || errno != EPERM) denied = 0;
    errno = 0; if (syscall(SYS_pidfd_getfd, -1, 0, 0) != -1 || errno != EPERM) denied = 0;
    errno = 0; if (syscall(SYS_process_vm_readv, getppid(), NULL, 0, NULL, 0, 0) != -1 || errno != EPERM) denied = 0;
    if (!denied_pair(AF_INET, SOCK_STREAM, 0) || !denied_pair(AF_UNIX, SOCK_DGRAM, 0) || !denied_pair(AF_UNIX, SOCK_STREAM, 1)) denied = 0;
  }
  printf("{\"network4\":%d,\"network6\":%d,\"outsideRead\":%d,\"insideRead\":%d,\"isolated\":%d,\"syscallsDenied\":%d,\"administrator\":%d,\"namedUnix\":%d,\"privatePair\":%d}\n", connection(AF_INET, atoi(argv[2])), connection(AF_INET6, atoi(argv[3])), outsideRead, insideRead, prctl(PR_GET_NO_NEW_PRIVS, 0, 0, 0, 0) == 1, denied, geteuid() == 0, unix_connection(argv[6]), private_pair());
  return 0;
}
