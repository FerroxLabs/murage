#!/bin/sh
# Keep this file beside guard-lib.sh and invoke through a tool-named symlink.
# The library never rewrites the original positional arguments.
set +e
set +u
set +f
# Match JSON/path bytes in the C locale, then restore the caller's exact
# LC_ALL presence/value before executing either external program.
wg_locale_set=${LC_ALL+x}; wg_locale_value=${LC_ALL-}
LC_ALL=C
export LC_ALL
wg_restore_locale() {
    if [ "$wg_locale_set" = x ]; then LC_ALL=$wg_locale_value; export LC_ALL
    else unset LC_ALL
    fi
}
wg_exec() {
    wg_restore_locale
    exec "$wg_real" "$@"
}
wg_tool=${0##*/}
case $0 in
    */*) wg_dir=${0%/*} ;;
    *) wg_dir=; wg_search=${PATH-}:
       while [ -n "$wg_search" ]; do
           wg_piece=${wg_search%%:*}; wg_search=${wg_search#*:}
           [ -n "$wg_piece" ] || wg_piece=.
           if [ -f "$wg_piece/guard-lib.sh" ] && [ -f "$wg_piece/$wg_tool" ]; then
               wg_dir=$wg_piece; break
           fi
       done ;;
esac
# A missing library still uses PATH past this directory, never the shim again.
if [ -n "$wg_dir" ] && [ -r "$wg_dir/guard-lib.sh" ]; then
    . "$wg_dir/guard-lib.sh"
    wg_main "$@"
fi
wg_search=${PATH-}:
while [ -n "$wg_search" ]; do
    wg_piece=${wg_search%%:*}; wg_search=${wg_search#*:}
    [ -n "$wg_piece" ] || wg_piece=.
    [ "$wg_piece" = "$wg_dir" ] && continue
    [ -f "$wg_piece/guard-lib.sh" ] && continue
    if [ -f "$wg_piece/$wg_tool" ] && [ -x "$wg_piece/$wg_tool" ]; then
        wg_restore_locale
        exec "$wg_piece/$wg_tool" "$@"
    fi
done
printf '%s\n' "wipe guard: real $wg_tool is unavailable" >&2
exit 127
