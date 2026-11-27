FROM node:24-bookworm@sha256:9af606de2e947cfb3f276633b7c5130c4cd22365aa10f5a647b7675d5cfce0c0

RUN set -eux; \
    printf '%s\n' '#!/bin/sh' 'exit 101' >/usr/sbin/policy-rc.d; \
    printf '%s\n' \
      'deb [check-valid-until=no] https://snapshot.debian.org/archive/debian/20261001T000000Z/ bookworm main' \
      'deb [check-valid-until=no] https://snapshot.debian.org/archive/debian-security/20261001T000000Z/ bookworm-security main' \
      >/etc/apt/sources.list; \
    rm -f /etc/apt/sources.list.d/debian.sources; \
    apt-get -o Acquire::Retries=2 update; \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      dovecot-core=1:2.3.19.1+dfsg1-2.1+deb12u6 \
      dovecot-imapd=1:2.3.19.1+dfsg1-2.1+deb12u6 \
      openssl=3.0.22-1~deb12u1 \
      postfix=3.7.11-0+deb12u1 \
      sqlite3=3.40.1-2+deb12u2; \
    useradd --system --no-create-home --shell /usr/sbin/nologin mailfixture; \
    rm -rf /var/lib/apt/lists/* /etc/dovecot/private /etc/ssl/private/dovecot.pem /etc/ssl/certs/dovecot.pem \
      /etc/postfix/main.cf /var/mail/*

WORKDIR /work
