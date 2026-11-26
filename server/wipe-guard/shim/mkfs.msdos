#!/bin/sh
# Keep this file beside guard-lib.sh and invoke through a tool-named symlink.
# The library never rewrites the original positional arguments.
# Bash imports exported functions, and outside POSIX mode a function named
# like a builtin runs instead of it. Assigning POSIXLY_CORRECT is not a command
# lookup and puts bash in POSIX mode, where the special builtin unset comes
# before any function; unset then removes every function named like a builtin
# (other shells import none). Unsetting the variable again restores both the
# caller's variable and bash's mode, so a shell already in POSIX mode skips it.
wg_names='alias bg bind break builtin caller cd command compgen complete compopt continue declare dirs disown echo enable eval exec exit export false fc fg getopts hash help history jobs kill let local logout mapfile popd printf pushd pwd read readarray readonly return set shift shopt source suspend test times trap true type typeset ulimit umask unalias unset wait . : ['
case :${SHELLOPTS-}: in
    *:posix:*) unset -f $wg_names 2>/dev/null || : ;;
    *) wg_posix_set=${POSIXLY_CORRECT+x}; wg_posix_value=${POSIXLY_CORRECT-}
       POSIXLY_CORRECT=y
       unset -f $wg_names 2>/dev/null || :
       if [ "$wg_posix_set" = x ]; then POSIXLY_CORRECT=$wg_posix_value; else unset POSIXLY_CORRECT; fi ;;
esac
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
# Keep "-", "-x" or a CDPATH name an operand: . and cd read a bare "-" as an
# option or OLDPWD. A shim in / gives an empty folder. The PATH search below
# compares PATH entries with the folder as it was found (wg_found).
wg_found=$wg_dir
case $wg_dir in
    /*|[a-zA-Z]:*) ;;
    '') [ "${0%/*}" = "$0" ] || wg_dir=/ ;;
    *) wg_dir=./$wg_dir ;;
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
    [ "$wg_piece" = "$wg_found" ] && continue
    [ -f "$wg_piece/guard-lib.sh" ] && continue
    if [ -f "$wg_piece/$wg_tool" ] && [ -x "$wg_piece/$wg_tool" ]; then
        wg_restore_locale
        exec "$wg_piece/$wg_tool" "$@"
    fi
done
printf '%s\n' "wipe guard: real $wg_tool is unavailable" >&2
exit 127
