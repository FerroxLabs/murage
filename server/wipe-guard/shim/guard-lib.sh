# POSIX sh only. All wg_* variables belong to this short-lived shim process.
# Never eval input: eval below only addresses a numeric slot; data is expanded
# by the assignment itself, after the shell has parsed that assignment.



# Decode JSON Unicode with a builtin printf. Only escaped guard-file codepoints
# need a subshell; path argument processing never launches a process.



wg_load_request() {
    [ "${wg_request_loaded-}" != 1 ] || return 0
    [ -r "$wg_dir/guard-request.sh" ] || return 1
    . "$wg_dir/guard-request.sh"
    wg_request_loaded=1
}

wg_fast_string() {
    case $wg_json in '"'*) ;; *) return 1 ;; esac
    wg_tail=${wg_json#?}; wg_value=${wg_tail%%\"*}
    case $wg_value in *'\'*)
        wg_load_request && wg_string ;;
        *) case $wg_tail in *'"'*) wg_json=${wg_tail#*\"} ;; *) return 1 ;; esac ;;
    esac
}

# BASH_VERSION alone proves nothing: another sh inherits it from the
# environment. Only a shell whose builtin printf -v works is treated as bash
# (no fork; dash rejects the option). Bash 4 or newer also caps each read,
# which Git Bash needs for a single oversized line; Bash 3.2 reads one byte
# per system call with -n, so it keeps plain reads and the length check.
wg_shell_caps() {
    wg_bash=0; wg_bash_read=0; wg_probe=
    [ -n "${BASH_VERSION-}" ] || return 0
    printf -v wg_probe %s 1 >/dev/null 2>&1
    [ "$wg_probe" = 1 ] || return 0
    wg_bash=1
    case $BASH_VERSION in [0-3].*) ;; *) wg_bash_read=1 ;; esac
}

# $1 is the IFS for this one read; it never outlives the read builtin.
# Returns read's own status: 1 is end of file, above 1 an error (an option the
# shell lacks, an I/O error), which must never read as an empty guard.
wg_read_line() {
    wg_read_ifs=$1; shift
    if [ "${wg_bash_read-}" = 1 ]; then IFS=$wg_read_ifs read -r -n "$wg_read_count" "$@"
    else IFS=$wg_read_ifs read -r "$@"
    fi
}

wg_read_guard() {
    wg_split_guard=0
    # read can split the two arrays in C while it reads the compact file. This
    # avoids shell glob searches over a growing roots array. The final variable
    # preserves the remainder verbatim. Unusual brackets/formatting fall back.
    wg_end=; wg_read_count=1048577
    {
        wg_read_line '[]' wg_header wg_root_items wg_between wg_client_items wg_guard_tail
        wg_status=$?
        [ "$wg_status" -le 1 ] || return 3
        [ "$wg_status" != 0 ] || wg_end=$wg_nl
        case $wg_header:$wg_between:$wg_guard_tail in
            *'"roots":':',"client":':',"realTools":{'*)
                # Count the four brackets and the writer's final newline.
                [ $((${#wg_header} + ${#wg_root_items} + ${#wg_between} + ${#wg_client_items} + ${#wg_guard_tail} + ${#wg_end} + 4)) -le 1048576 ] || return 2
                wg_read_count=1
                if [ -z "$wg_end" ] || { wg_read_line '' wg_more; [ "$?" = 1 ] && [ -z "$wg_more" ]; }; then
                    wg_guard_text=
                    wg_split_guard=1
                    return 0
                fi ;;
        esac
    } < "$MURAGE_WIPE_GUARD"
    wg_guard_text=
    while :; do
        wg_read_count=$((1048577 - ${#wg_guard_text}))
        wg_end=
        wg_read_line '' wg_line
        wg_status=$?
        if [ "$wg_status" = 0 ]; then wg_end=$wg_nl
        elif [ "$wg_status" != 1 ]; then return 3
        elif [ -z "$wg_line" ]; then break
        fi
        wg_guard_text=$wg_guard_text$wg_line$wg_end
        [ "${#wg_guard_text}" -le 1048576 ] || return 2
    done < "$MURAGE_WIPE_GUARD"
}

# Validate compact roots without decoding, splitting or storing each one:
# whole-string patterns only, since
# a per-root loop alone cost Bash 3.2 about 0.2 s at 8,192 roots. Accept exactly
# "/r1","C:r2",...: every inner quote lies in one "," separator followed by an
# absolute or drive root, so no root holds a quote. The full parser accepts all
# of these; anything else (spacing, empty or relative roots) goes to that parser.
wg_compact_roots() {
    [ -n "$wg_root_items" ] || return 0
    # One case: each expansion of the 1 MiB text costs Bash 3.2 about 10 ms.
    case $wg_root_items in
        *'"'[!,/a-zA-Z]*|*'"'[a-zA-Z]|*'"'[a-zA-Z][!:]*|*'",'[!\"]*|*'","'[!/a-zA-Z]*|*'","'|*[!,]'"/'*|*[!,]'"'[a-zA-Z]':'*|*[!\"]',"/'*|*[!\"]',"'[a-zA-Z]':'*) return 1 ;;
        '"/'*'"'|'"'[a-zA-Z]':'*'"') return 0 ;;
    esac
    return 1
}

# The turn writer uses JSON.stringify in this fixed schema order. The fast
# reader decodes only roots and this tool's real path; unrelated realTools,
# client and token bytes need no work. A match always undergoes the full parser
# before callback. Pretty/alternate-order JSON uses that same full parser.
wg_fast_guard() {
    wg_drive_list=0
    wg_fast_read && return 0
    # Before 1.0.20-win the compact check refused every drive list before any
    # field was read, so the full parser started from nothing. Keep that start:
    # a file that fails later must not leave this reader's tool or off state.
    if [ "$wg_drive_list" = 1 ]; then wg_real=; wg_off=0; wg_thread=; wg_version=; fi
    return 1
}

wg_fast_read() {
    [ "$wg_split_guard" = 1 ] || return 1
    # Before 1.0.20 a file ending in the writer's newline always took the full
    # parser. Keep its decisions: only roots the compact matcher reads exactly
    # as that parser does may skip it (no spacing, empty or relative roots).
    # Every other field still gets that parser, in its order, with the roots
    # list emptied; it is short. A file that fails here takes the full parser.
    if [ -n "$wg_end" ]; then
        wg_compact_roots || return 1
        case $wg_root_items in '"'[a-zA-Z]':'*|*'","'[a-zA-Z]':'*) wg_drive_list=1 ;; esac
        wg_load_request || return 1
        wg_guard "$wg_header"'[]'"$wg_between"'['"$wg_client_items"']'"$wg_guard_tail" || return 1
        wg_full_real=$wg_real; wg_full_off=$wg_off
    fi
    # Check only the short header; matching across roots with several wildcards
    # causes quadratic backtracking in supported shells.
    case $wg_header in
        '{"v":1,"socket":"'*'","threadId":"'*'","token":"'*'","roots":') ;;
        *) return 1 ;;
    esac
    wg_json=${wg_guard_tail#',"realTools":{'}
    case $wg_json in
        *'},"off":false}') wg_off=0; wg_json=${wg_json%'},"off":false}'} ;;
        *'},"off":true}') wg_off=1; wg_json=${wg_json%'},"off":true}'} ;;
        *) return 1 ;;
    esac
    wg_needle='"'$wg_tool'":'
    case $wg_json in *"$wg_needle"*)
        wg_json=${wg_json#*"$wg_needle"}
        wg_fast_string || return 1
        wg_real=$wg_value ;;
    esac
    # A drive list took the full parser before: keep its reading of the tool
    # and off fields (the last duplicate key wins there).
    if [ "$wg_drive_list" = 1 ]; then wg_real=$wg_full_real; wg_off=$wg_full_off; fi
    wg_root_text='['$wg_root_items']'
    wg_json=$wg_root_text
    wg_decode=0
    # Writer-format roots that wg_main canonicalises (one-letter top folder,
    # dot segments, trailing slash) need the decoder too; compared as raw text
    # they would miss their target. The decoder is what these files always
    # used, so a broader pattern (fewer scans) only costs time. Never the plain
    # root "/": the writer always lists it, so matching it would decode always.
    if [ -n "$wg_end" ]; then
        case $wg_root_text in
            *'\'*|*'"'[a-zA-Z]':'*|*'/.'[./\"]*|*'"/'[a-zA-Z]'/'*|*[!\"]'/"'*) wg_decode=1 ;;
        esac
    else
        case $wg_root_text in *'\'*|*'"'[a-zA-Z]':'*) wg_decode=1 ;; esac
    fi
    case $wg_decode in
        1)
            # Escaped/non-POSIX roots need the complete decoder and normalizer.
            # A writer-format list (checked above) splits at its quotes instead.
            wg_load_request || return 1
            if [ -n "$wg_end" ] && wg_split_roots; then wg_split=1
            else
                wg_roots=0; wg_array=roots; wg_json=$wg_root_text
                wg_strings || return 1
                [ -z "$wg_json" ] || return 1
            fi ;;
        *) wg_fast_roots=1 ;;
    esac
    wg_fast=1
}


wg_find_real() {
    case $wg_real in
        /*|[a-zA-Z]:[\\/]*)
            # Refuse a mistaken realTools entry pointing back at any shim.
            if [ -x "$wg_real" ] && [ ! "$wg_real" -ef "$wg_dir/$wg_tool" ]; then return 0; fi ;;
    esac
    wg_real=
    wg_search=${PATH-}:
    while [ -n "$wg_search" ]; do
        wg_piece=${wg_search%%:*}; wg_search=${wg_search#*:}
        [ -n "$wg_piece" ] || wg_piece=.
        # Resolve directory aliases too (PATH may contain symlinks or dots).
        case $wg_piece in /*) ;; *) wg_piece=$wg_cwd/$wg_piece ;; esac
        if CDPATH= cd -P -- "$wg_piece" 2>/dev/null; then
            wg_piece=$PWD
            CDPATH= cd -P -- "$wg_cwd" 2>/dev/null || return 1
        else continue
        fi
        [ "$wg_piece" = "$wg_shim_dir" ] && continue
        [ -r "$wg_piece/guard-lib.sh" ] && continue
        if [ -f "$wg_piece/$wg_tool" ] && [ -x "$wg_piece/$wg_tool" ]; then
            wg_real=$wg_piece/$wg_tool; return 0
        fi
    done
    return 1
}

wg_device() {
    # Character sinks and ordinary /dev files are benign. Real block devices,
    # Linux disk families, BSD raw disks and Windows physical drives match.
    case $wg_path in
        /dev/sd[a-z]*|/dev/hd[a-z]*|/dev/vd[a-z]*|/dev/xvd[a-z]*|/dev/nvme[0-9]*|/dev/mmcblk[0-9]*|/dev/loop[0-9]*|/dev/disk[0-9]*|/dev/rdisk[0-9]*|/dev/mapper/*|/dev/disk/*|//./PhysicalDrive[0-9]*|//./physicaldrive[0-9]*) return 0 ;;
    esac
    [ -b "$wg_path" ]
}

# Non-recursive rm cannot remove a protected root, so it needs no path work: the
# common ordinary-path case decides from argv alone and parses nothing further.
wg_plain_rm() {
    [ "$wg_tool" = rm ] || return 1
    for wg_arg do
        case $wg_arg in
            --) return 0 ;;
            --recursive) return 1 ;;
            --*) ;;
            -?*) case ${wg_arg#-} in *[rR]*) return 1 ;; esac ;;
        esac
    done
    return 0
}

# The one outcome when the check cannot finish: under an active guard anything
# but a plain rm refuses. Absent, unreadable or switched-off guards return 1 and
# the caller runs the tool as before (the specified fail-open direction).
# wg_main decides "active" once, in the caller's folder, before any cd: a
# relative guard path must not read as absent from another folder.
wg_unchecked() {
    if [ "${wg_active-1}" = 1 ] && ! wg_plain_rm "$@"; then
        printf '%s\n' 'wipe guard: could not check; refused' >&2
        exit 126
    fi
    return 1
}

wg_main() {
    wg_nl='
'
    # Literal C0 bytes keep startup fork-free. Derive the named controls with
    # parameter expansion; no printf command substitution on the fast path.
    wg_controls='	
'
    wg_bs=${wg_controls#???????}; wg_bs=${wg_bs%"${wg_bs#?}"}
    wg_tab=${wg_controls#????????}; wg_tab=${wg_tab%"${wg_tab#?}"}
    wg_ff=${wg_controls#???????????}; wg_ff=${wg_ff%"${wg_ff#?}"}
    wg_cr=${wg_controls#????????????}; wg_cr=${wg_cr%"${wg_cr#?}"}
    wg_space=" $wg_nl$wg_tab$wg_cr"
    wg_alphabet=
    wg_roots=0; wg_clients=0; wg_targets=0; wg_real=; wg_match=
    wg_version=; wg_off=0; wg_thread=; wg_disk_command=
    wg_active=0
    if [ -n "${MURAGE_WIPE_GUARD-}" ] && [ -r "$MURAGE_WIPE_GUARD" ] && [ "${MURAGE_WIPE_GUARD_OFF-}" != 1 ]; then wg_active=1; fi
    wg_cwd=$PWD
    CDPATH= cd -P . 2>/dev/null || wg_unchecked "$@" || return 1
    wg_cwd=$PWD
    # cd resolves a relative folder from wg_cwd and keeps the shell's own
    # absolute forms, e.g. Git Bash's D:/... (never prefix those with wg_cwd).
    CDPATH= cd -P -- "$wg_dir" 2>/dev/null || wg_unchecked "$@" || return 1
    wg_dir=$PWD; wg_shim_dir=$PWD
    CDPATH= cd -P -- "$wg_cwd" 2>/dev/null || wg_unchecked "$@" || return 1
    wg_valid=0; wg_fast=0; wg_fast_roots=0; wg_split=0; wg_request_loaded=0
    wg_shell_caps
    # A guard path that is readable but not a file (a folder) reads as end of
    # file with no bytes; it is not an absent guard.
    if [ -n "${MURAGE_WIPE_GUARD-}" ] && [ -r "$MURAGE_WIPE_GUARD" ] && [ ! -f "$MURAGE_WIPE_GUARD" ]; then
        wg_unchecked "$@"
    fi
    if [ -n "${MURAGE_WIPE_GUARD-}" ] && [ -r "$MURAGE_WIPE_GUARD" ] && wg_read_guard 2>/dev/null; then
        if wg_fast_guard; then wg_valid=1
        else
            wg_roots=0; wg_clients=0; wg_fast_roots=0; wg_split=0
            # A missing parser is not a malformed file: the check cannot run.
            if ! wg_load_request; then wg_unchecked "$@"
            elif wg_guard; then wg_valid=1
            fi
        fi
    else
        case $? in
            2) printf '%s\n' 'wipe guard: guard file too large; refused' >&2; exit 126 ;;
            3) wg_unchecked "$@" || return 1 ;;
        esac
    fi
    wg_find_real || wg_unchecked "$@" || return 1
    if [ "$wg_valid" = 1 ] && [ "$wg_off" = 0 ] && [ "${MURAGE_WIPE_GUARD_OFF-}" != 1 ]; then
        if wg_plain_rm "$@"; then wg_exec "$@"; fi
        # Path resolution and argv scanning live in the on-demand library.
        wg_load_request || wg_unchecked "$@" || wg_exec "$@"
        # Canonicalize the roots once as well (also normalizes Windows forms).
        wg_k=1
        while [ "$wg_k" -le "$wg_roots" ]; do
            eval 'wg_value=${wg_root_'"$wg_k"'}'
            # Guard-file roots are already canonical by contract. Only unusual
            # forms (including Git Bash drive paths) need normalization here.
            case $wg_value in
                '') wg_exec "$@" ;;
                [a-zA-Z]:*|/[a-zA-Z]/*|*/../*|*/./*|*/..|*/.|*/)
                    if ! wg_canon_root "$wg_value"; then wg_unchecked "$@" || wg_exec "$@"; fi
                    eval "wg_root_$wg_k=\$wg_path" ;;
            esac
            wg_k=$((wg_k + 1))
        done
        if wg_argv "$@" || wg_unchecked "$@"; then
            [ -n "$wg_match" ] || wg_children
            if [ -n "$wg_match" ]; then
                if [ "$wg_fast" = 1 ]; then
                    wg_roots=0; wg_clients=0
                    if ! wg_load_request || ! wg_callback_guard; then wg_exec "$@"; fi
                fi
                wg_call "$@"
                wg_result=$?
                case $wg_result in
                    0) ;;
                    10) wg_quote "$wg_match"; printf '%s\n' "wipe guard: refused $wg_quoted" >&2; exit 10 ;;
                    *) wg_quote "$wg_match"; printf '%s\n' "wipe guard: app unreachable; refused $wg_quoted" >&2; exit 126 ;;
                esac
            fi
        fi
    fi
    wg_exec "$@"
}
