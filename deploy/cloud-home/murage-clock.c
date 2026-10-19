/* SPDX-License-Identifier: AGPL-3.0-or-later */
#define _GNU_SOURCE
#include <stdio.h>
#include <string.h>
#include <time.h>
#include <sys/timex.h>
#include <fcntl.h>
#include <unistd.h>
#include <ctype.h>

static double milliseconds(struct timespec value) {
    return (double)value.tv_sec * 1000.0 + (double)value.tv_nsec / 1000000.0;
}

int main(int argc, char **argv) {
    (void)argv;
    struct timespec wall, boot, mono;
    struct timex health = {0}; /* modes=0: query only, never set the clock. */
    char id[38] = {0};
    if (argc != 1 || clock_gettime(CLOCK_REALTIME, &wall) ||
        clock_gettime(CLOCK_BOOTTIME, &boot) || clock_gettime(CLOCK_MONOTONIC, &mono)) return 1;
    int state = adjtimex(&health);
    if (state < 0) return 1;
    int fd = open("/proc/sys/kernel/random/boot_id", O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
    if (fd < 0) return 1;
    ssize_t count = read(fd, id, sizeof(id));
    close(fd);
    if (count != 37 || id[36] != '\n') return 1;
    id[36] = 0;
    for (int i = 0; i < 36; i++) {
        if (i == 8 || i == 13 || i == 18 || i == 23) { if (id[i] != '-') return 1; }
        else if (!isxdigit((unsigned char)id[i])) return 1;
    }
    int synced = state != TIME_ERROR && !(health.status & (STA_UNSYNC | STA_CLOCKERR));
    if (printf("{\"wallMs\":%.6f,\"bootMs\":%.6f,\"monoMs\":%.6f,\"bootId\":\"%s\",\"ntpSynced\":%s}\n",
        milliseconds(wall), milliseconds(boot), milliseconds(mono), id, synced ? "true" : "false") < 0) return 1;
    return 0;
}
