# POSIX sh JSON grammar, path and argv scanning, and matched-request serialization. Loaded on demand.
# Owner: wg-shim; callback/client consumer: wg-callback.

wg_ws() {
    case $wg_json in ["$wg_space"]*)
        wg_json=${wg_json#"${wg_json%%[!"$wg_space"]*}"} ;;
    esac
}

wg_string() {
    wg_ws
    case $wg_json in '"'*) wg_json=${wg_json#?} ;; *) return 1 ;; esac
    # Nearly every guard-file string has no JSON escapes. Avoid the slower
    # character-class scan and escape decoder for those strings.
    wg_value=${wg_json%%\"*}
    case $wg_value in *'\'*) ;; *)
        case $wg_json in *'"'*) wg_json=${wg_json#*\"}; return 0 ;; *) return 1 ;; esac ;;
    esac
    wg_value=
    while :; do
        wg_chunk=${wg_json%%[\"\\]*}
        wg_value=$wg_value$wg_chunk
        wg_json=${wg_json#"$wg_chunk"}
        case $wg_json in
            '"'*) wg_json=${wg_json#?}; return 0 ;;
            '\'*)
                wg_json=${wg_json#?}
                wg_escape=${wg_json%"${wg_json#?}"}; wg_json=${wg_json#?}
                case $wg_escape in
                    '"'|'\'|/) wg_value=$wg_value$wg_escape ;;
                    n) wg_value=$wg_value$wg_nl ;;
                    r) wg_value=$wg_value$wg_cr ;;
                    t) wg_value=$wg_value$wg_tab ;;
                    b) wg_value=$wg_value$wg_bs ;;
                    f) wg_value=$wg_value$wg_ff ;;
                    u)
                        wg_hex=${wg_json%"${wg_json#????}"}; wg_json=${wg_json#????}
                        case $wg_hex in ???? ) ;; *) return 1 ;; esac
                        case $wg_hex in *[!0-9a-fA-F]*) return 1 ;; esac
                        wg_code=$((0x$wg_hex))
                        if [ "$wg_code" -ge 55296 ] && [ "$wg_code" -le 56319 ]; then
                            case $wg_json in '\u'*) wg_json=${wg_json#??} ;; *) return 1 ;; esac
                            wg_hex=${wg_json%"${wg_json#????}"}; wg_json=${wg_json#????}
                            case $wg_hex in ???? ) ;; *) return 1 ;; esac
                            case $wg_hex in *[!0-9a-fA-F]*) return 1 ;; esac
                            wg_low=$((0x$wg_hex))
                            [ "$wg_low" -ge 56320 ] && [ "$wg_low" -le 57343 ] || return 1
                            wg_code=$((65536 + (wg_code - 55296) * 1024 + wg_low - 56320))
                        elif [ "$wg_code" -ge 56320 ] && [ "$wg_code" -le 57343 ]; then
                            return 1
                        fi
                        [ "$wg_code" -gt 0 ] || return 1
                        wg_utf8
                        wg_value=$wg_value$wg_char ;;
                    *) return 1 ;;
                esac ;;
            *) return 1 ;;
        esac
    done
}

# Format into a variable without a subshell. Bash (Git Bash included) has
# printf -v; every other target shell needs the substitution fallback, which
# is the only command substitution in the shim and never runs under bash.
wg_fmt() {
    wg_fmt_var=$1; shift
    if [ -n "${BASH_VERSION-}" ]; then
        printf -v "$wg_fmt_var" "$@"
    else
        wg_fmt_out=$(printf "$@")
        eval "$wg_fmt_var=\$wg_fmt_out"
    fi
}

wg_octet() {
    wg_bytes=$wg_bytes'\'$((wg_byte / 64))$((wg_byte / 8 % 8))$((wg_byte % 8))
}

wg_utf8() {
    wg_bytes=
    if [ "$wg_code" -lt 128 ]; then
        wg_byte=$wg_code; wg_octet
    elif [ "$wg_code" -lt 2048 ]; then
        wg_byte=$((192 + wg_code / 64)); wg_octet
        wg_byte=$((128 + wg_code % 64)); wg_octet
    elif [ "$wg_code" -lt 65536 ]; then
        wg_byte=$((224 + wg_code / 4096)); wg_octet
        wg_byte=$((128 + wg_code / 64 % 64)); wg_octet
        wg_byte=$((128 + wg_code % 64)); wg_octet
    else
        wg_byte=$((240 + wg_code / 262144)); wg_octet
        wg_byte=$((128 + wg_code / 4096 % 64)); wg_octet
        wg_byte=$((128 + wg_code / 64 % 64)); wg_octet
        wg_byte=$((128 + wg_code % 64)); wg_octet
    fi
    wg_fmt wg_char "$wg_bytes."
    wg_char=${wg_char%.}
}

wg_strings() {
    wg_ws
    case $wg_json in '['*) wg_json=${wg_json#?} ;; *) return 1 ;; esac
    wg_ws
    case $wg_json in ']'*) wg_json=${wg_json#?}; return 0 ;; esac
    while :; do
        wg_string || return 1
        case $wg_array in
            roots) wg_roots=$((wg_roots + 1)); eval "wg_root_$wg_roots=\$wg_value" ;;
            client) wg_clients=$((wg_clients + 1)); eval "wg_client_$wg_clients=\$wg_value" ;;
        esac
        wg_ws
        case $wg_json in
            ','*) wg_json=${wg_json#?} ;;
            ']'*) wg_json=${wg_json#?}; return 0 ;;
            *) return 1 ;;
        esac
    done
}

wg_tools() {
    wg_ws
    case $wg_json in '{'*) wg_json=${wg_json#?} ;; *) return 1 ;; esac
    wg_ws
    case $wg_json in '}'*) wg_json=${wg_json#?}; return 0 ;; esac
    while :; do
        wg_string || return 1
        wg_key=$wg_value
        wg_ws
        case $wg_json in ':'*) wg_json=${wg_json#?} ;; *) return 1 ;; esac
        wg_string || return 1
        [ "$wg_key" != "$wg_tool" ] || wg_real=$wg_value
        wg_ws
        case $wg_json in
            ','*) wg_json=${wg_json#?} ;;
            '}'*) wg_json=${wg_json#?}; return 0 ;;
            *) return 1 ;;
        esac
    done
}

wg_callback_guard() {
    # A writer-format file passed wg_compact_roots before the fast matcher ran.
    if [ "$wg_fast_roots" = 1 ] && { [ -n "$wg_end" ] || wg_compact_roots; }; then
        wg_guard "$wg_header"'[]'"$wg_between"'['"$wg_client_items"']'"$wg_guard_tail"
    else
        wg_guard
    fi
}

wg_guard() {
    if [ "$#" -gt 0 ]; then wg_json=$1
    elif [ "$wg_split_guard" = 1 ]; then
        wg_json=$wg_header'['$wg_root_items']'$wg_between'['$wg_client_items']'$wg_guard_tail
    else wg_json=$wg_guard_text
    fi
    wg_ws
    case $wg_json in '{'*) wg_json=${wg_json#?} ;; *) return 1 ;; esac
    while :; do
        wg_string || return 1
        wg_key=$wg_value
        wg_ws
        case $wg_json in ':'*) wg_json=${wg_json#?} ;; *) return 1 ;; esac
        case $wg_key in
            socket|threadId|token)
                wg_string || return 1
                [ "$wg_key" != threadId ] || wg_thread=$wg_value ;;
            roots|client) wg_array=$wg_key; wg_strings || return 1 ;;
            realTools) wg_tools || return 1 ;;
            v) wg_ws; case $wg_json in 1*) wg_json=${wg_json#?}; wg_version=1 ;; *) return 1 ;; esac ;;
            off) wg_ws; case $wg_json in
                true*) wg_off=1; wg_json=${wg_json#true} ;;
                false*) wg_json=${wg_json#false} ;;
                *) return 1 ;;
            esac ;;
            *) return 1 ;;
        esac
        wg_ws
        case $wg_json in
            ','*) wg_json=${wg_json#?} ;;
            '}'*) wg_json=${wg_json#?}; break ;;
            *) return 1 ;;
        esac
    done
    wg_ws
    [ -z "$wg_json" ] && [ "$wg_version" = 1 ]
}

wg_quote() {
    wg_text=$1; wg_quoted='"'
    while [ -n "$wg_text" ]; do
        wg_chunk=${wg_text%%[\"\\"$wg_controls"]*}
        wg_quoted=$wg_quoted$wg_chunk
        wg_text=${wg_text#"$wg_chunk"}
        [ -n "$wg_text" ] || break
        wg_char=${wg_text%"${wg_text#?}"}; wg_text=${wg_text#?}
        case $wg_char in
            '"') wg_quoted=$wg_quoted'\"' ;;
            '\') wg_quoted=$wg_quoted'\\' ;;
            "$wg_nl") wg_quoted=$wg_quoted'\n' ;;
            "$wg_cr") wg_quoted=$wg_quoted'\r' ;;
            "$wg_tab") wg_quoted=$wg_quoted'\t' ;;
            "$wg_bs") wg_quoted=$wg_quoted'\b' ;;
            "$wg_ff") wg_quoted=$wg_quoted'\f' ;;
            *)
                # Only on a match; printf is a shell builtin in all target shells.
                wg_fmt wg_num '%d' "'$wg_char"
                wg_fmt wg_escape '\\u%04x' "$wg_num"
                wg_quoted=$wg_quoted$wg_escape ;;
        esac
    done
    wg_quoted=$wg_quoted'"'
}

wg_call() {
    wg_args=; wg_sep=
    for wg_arg do
        wg_quote "$wg_arg"
        wg_args=$wg_args$wg_sep$wg_quoted; wg_sep=,
    done
    wg_target_json=; wg_sep=; wg_j=1
    while [ "$wg_j" -le "$wg_targets" ]; do
        eval 'wg_path=${wg_target_'"$wg_j"'}'
        wg_quote "$wg_path"; wg_target_json=$wg_target_json$wg_sep$wg_quoted; wg_sep=,
        wg_j=$((wg_j + 1))
    done
    wg_quote "$wg_thread"; wg_thread_json=$wg_quoted
    wg_quote "$wg_tool"; wg_tool_json=$wg_quoted
    wg_quote "$wg_cwd"; wg_cwd_json=$wg_quoted
    wg_request='{"v":1,"kind":"wipe-exec","id":"shim-'$$'","threadId":'$wg_thread_json',"tool":'$wg_tool_json',"argv":['$wg_args'],"cwd":'$wg_cwd_json',"targets":['$wg_target_json']}'
    # This function owns its positional parameters; wg_main retains real argv.
    set --
    wg_j=1
    while [ "$wg_j" -le "$wg_clients" ]; do
        eval 'wg_value=${wg_client_'"$wg_j"'}'
        set -- "$@" "$wg_value"
        wg_j=$((wg_j + 1))
    done
    [ "$#" -gt 0 ] || return 11
    # The token stays in the guard file. Protocol chatter cannot alter the real
    # command's output; diagnostics are deliberately a single shim-owned line.
    wg_restore_locale
    ELECTRON_RUN_AS_NODE=1 "$@" wipe-exec "$wg_request" >/dev/null 2>&1
}

# Path resolution and argv scanning. Parsed only after the guard file and arguments need them.
# Return a canonical path in wg_path without spawning a process. cd resolves
# symlinks *before* .., unlike lexical normalization. Missing tail components
# are normalized relative to the deepest existing physical directory.
wg_canon() {
    wg_path=$1; wg_entry=
    case $wg_path in
        [a-zA-Z]:*|/[a-zA-Z]/*)
            # Convert Git Bash drive spellings, including mixed separators.
            wg_tail=$wg_path; wg_path=
            while :; do
                case $wg_tail in
                    *'\'*) wg_path=$wg_path${wg_tail%%\\*}/; wg_tail=${wg_tail#*\\} ;;
                    *) wg_path=$wg_path$wg_tail; break ;;
                esac
            done
            case $wg_path in [a-zA-Z]:/*)
                wg_drive=${wg_path%%:*}; wg_tail=${wg_path#?:}
                case $wg_drive in
                    A) wg_drive=a ;; B) wg_drive=b ;; C) wg_drive=c ;; D) wg_drive=d ;;
                    E) wg_drive=e ;; F) wg_drive=f ;; G) wg_drive=g ;; H) wg_drive=h ;;
                    I) wg_drive=i ;; J) wg_drive=j ;; K) wg_drive=k ;; L) wg_drive=l ;;
                    M) wg_drive=m ;; N) wg_drive=n ;; O) wg_drive=o ;; P) wg_drive=p ;;
                    Q) wg_drive=q ;; R) wg_drive=r ;; S) wg_drive=s ;; T) wg_drive=t ;;
                    U) wg_drive=u ;; V) wg_drive=v ;; W) wg_drive=w ;; X) wg_drive=x ;;
                    Y) wg_drive=y ;; Z) wg_drive=z ;;
                esac
                wg_path=/$wg_drive$wg_tail ;;
            esac ;;
    esac
    [ -n "$wg_path" ] || return 1
    case $wg_path in /*) ;; *) wg_path=$wg_cwd/$wg_path ;; esac
    while [ "$wg_path" != / ] && [ "${wg_path%/}" != "$wg_path" ]; do wg_path=${wg_path%/}; done
    if [ -L "$wg_path" ]; then
        wg_parent=${wg_path%/*}; wg_leaf=${wg_path##*/}
        [ -n "$wg_parent" ] || wg_parent=/
        if CDPATH= cd -P -- "$wg_parent" 2>/dev/null; then
            wg_entry=${PWD%/}/$wg_leaf
            CDPATH= cd -P -- "$wg_cwd" 2>/dev/null || return 1
        fi
    fi
    if [ -d "$wg_path" ] && CDPATH= cd -P -- "$wg_path" 2>/dev/null; then
        wg_path=$PWD
        CDPATH= cd -P -- "$wg_cwd" 2>/dev/null || return 1
        return 0
    fi
    wg_parent=${wg_path%/*}; wg_leaf=${wg_path##*/}
    [ -n "$wg_parent" ] || wg_parent=/
    if [ -n "$wg_leaf" ] && [ -d "$wg_parent" ] && CDPATH= cd -P -- "$wg_parent" 2>/dev/null; then
        wg_path=${PWD%/}/$wg_leaf
        CDPATH= cd -P -- "$wg_cwd" 2>/dev/null || return 1
        return 0
    fi
    wg_tail=${wg_path#/}; wg_path=
    while [ -n "$wg_tail" ]; do
        wg_part=${wg_tail%%/*}
        case $wg_tail in */*) wg_tail=${wg_tail#*/} ;; *) wg_tail= ;; esac
        case $wg_part in
            ''|.) ;;
            ..) wg_path=${wg_path%/*} ;;
            *) wg_path=$wg_path/$wg_part
               if [ -d "$wg_path" ] && CDPATH= cd -P -- "$wg_path" 2>/dev/null; then
                   wg_path=$PWD
                   CDPATH= cd -P -- "$wg_cwd" 2>/dev/null || return 1
               fi ;;
        esac
    done
    [ -n "$wg_path" ] || wg_path=/
}

# JSON encode in chunks, with a slow byte path only for C0 controls. No argv
# expansion, word splitting, external tools, or per-argument subshells.

# Normal compact roots contain no escapes. Membership can use their JSON string
# boundaries directly, independent of the number of protected projects. Only
# roots that are parents of actual operands need child enumeration/decoding.
wg_root_member() {
    case $1 in *[\"\\"$wg_controls"]*) return 1 ;; esac
    wg_needle='"'$1'"'
    case $wg_root_text in
        '['"$wg_needle"']'|'['"$wg_needle"','*|*','"$wg_needle"','*|*','"$wg_needle"']') return 0 ;;
    esac
    return 1
}

wg_candidate() {
    wg_i=1
    while [ "$wg_i" -le "$wg_roots" ]; do
        eval 'wg_root=${wg_root_'"$wg_i"'}'
        [ "$wg_root" != "$wg_parent" ] || return 0
        wg_i=$((wg_i + 1))
    done
    wg_roots=$((wg_roots + 1))
    eval "wg_root_$wg_roots=\$wg_parent"
    wg_i=$wg_roots
}

# Count distinct existing child entries as operands arrive. Keys contain only
# alphanumerics and numeric escapes, so eval never parses path bytes as code.
# The alphabet has at most 255 bytes (LC_ALL=C); its scans have bounded cost.
wg_select_child() {
    wg_selection=$1
    wg_parent=${wg_selection%/*}; [ -n "$wg_parent" ] || wg_parent=/
    if [ "$wg_fast_roots" = 1 ]; then
        wg_root_member "$wg_parent" || return 0
        wg_candidate
    else
        wg_i=1
        while [ "$wg_i" -le "$wg_roots" ]; do
            eval 'wg_root=${wg_root_'"$wg_i"'}'
            [ "$wg_root" != "$wg_parent" ] || break
            wg_i=$((wg_i + 1))
        done
        [ "$wg_i" -le "$wg_roots" ] || return 0
    fi
    [ -e "$wg_selection" ] || [ -L "$wg_selection" ] || return 0
    wg_key=; wg_key_tail=${wg_selection##*/}
    while [ -n "$wg_key_tail" ]; do
        wg_key_run=${wg_key_tail%%[!a-zA-Z0-9]*}
        wg_key=$wg_key$wg_key_run; wg_key_tail=${wg_key_tail#"$wg_key_run"}
        [ -n "$wg_key_tail" ] || break
        wg_key_byte=${wg_key_tail%"${wg_key_tail#?}"}; wg_key_tail=${wg_key_tail#?}
        case $wg_alphabet in *"$wg_key_byte"*) ;; *) wg_alphabet=$wg_alphabet$wg_key_byte ;; esac
        wg_key_prefix=${wg_alphabet%%"$wg_key_byte"*}
        wg_key=${wg_key}_${#wg_key_prefix}_
    done
    eval 'wg_seen=${wg_seen_'"${wg_i}_${wg_key}"'-0}'
    if [ "$wg_seen" = 0 ]; then
        eval "wg_seen_${wg_i}_${wg_key}=1"
        eval 'wg_selected=${wg_selected_'"$wg_i"'-0}'
        eval "wg_selected_$wg_i=$((wg_selected + 1))"
    fi
}

wg_target() {
    [ -n "$1" ] || return 0
    wg_canon "$1" || return 1
    wg_targets=$((wg_targets + 1))
    eval "wg_target_$wg_targets=\$wg_path"
    [ -n "$wg_entry" ] || wg_entry=$wg_path
    eval "wg_entry_$wg_targets=\$wg_entry"
    case $wg_tool in dd|shred|wipefs|mkfs|mkfs.*)
        if wg_device; then wg_match=$wg_path; fi ;;
    esac
    if [ "$wg_fast_roots" = 1 ]; then
        if wg_root_member "$wg_path"; then wg_match=$wg_path; fi
    else
        wg_i=1
        while [ "$wg_i" -le "$wg_roots" ]; do
            eval 'wg_root=${wg_root_'"$wg_i"'}'
            [ "$wg_path" != "$wg_root" ] || wg_match=$wg_path
            wg_i=$((wg_i + 1))
        done
    fi
    case $wg_tool in rm|rmdir|mv)
        wg_select_child "$wg_path"
        [ "$wg_entry" = "$wg_path" ] || wg_select_child "$wg_entry" ;;
    esac
    if [ "$wg_tool" = rmdir ] && [ "$wg_parents" = 1 ]; then
        wg_ancestor=$wg_path
        while [ "$wg_ancestor" != / ]; do
            wg_ancestor=${wg_ancestor%/*}; [ -n "$wg_ancestor" ] || wg_ancestor=/
            if [ "$wg_fast_roots" = 1 ]; then
                if wg_root_member "$wg_ancestor"; then wg_match=$wg_ancestor; fi
            else
                wg_i=1
                while [ "$wg_i" -le "$wg_roots" ]; do
                    eval 'wg_root=${wg_root_'"$wg_i"'}'
                    [ "$wg_ancestor" != "$wg_root" ] || wg_match=$wg_root
                    wg_i=$((wg_i + 1))
                done
            fi
        done
    fi
}

# Filesystem tools reuse option letters with different arities. Unknown
# variants conservatively retain operands rather than swallow an erase target.
wg_mkfs_value_option() {
    case $wg_tool:$wg_flag in
        mkfs.ext[234]:[bLUmOEIJNT]) return 0 ;;
        mkfs.fat:[bDfFghilmMnrRsS]|mkfs.vfat:[bDfFghilmMnrRsS]|mkfs.msdos:[bDfFghilmMnrRsS]) return 0 ;;
    esac
    return 1
}

wg_argv() {
    wg_options=1; wg_recursive=0; wg_pending=; wg_operands=0; wg_destination=0; wg_disk_command=; wg_disk_sub=
    wg_parents=0
    for wg_arg do
        case $wg_arg in
            --) break ;;
            --help|--version) return 0 ;;
            --parents) [ "$wg_tool" != rmdir ] || wg_parents=1 ;;
            --*) ;;
            -?*) if [ "$wg_tool" = rmdir ]; then
                case ${wg_arg#-} in *p*) wg_parents=1 ;; esac
            fi ;;
        esac
    done
    # First pass decides whether rm is recursive before any root comparison.
    if [ "$wg_tool" = rm ]; then
        for wg_arg do
            if [ "$wg_options" = 1 ]; then
                case $wg_arg in
                    --) wg_options=0 ;;
                    --recursive) wg_recursive=1 ;;
                    --*) ;;
                    -?*) case ${wg_arg#-} in *[rR]*) wg_recursive=1 ;; esac ;;
                esac
            fi
        done
        [ "$wg_recursive" = 1 ] || return 0
    fi
    wg_options=1
    for wg_arg do
        if [ -n "$wg_pending" ]; then
            case $wg_pending in target) wg_target "$wg_arg" || return 1 ;; esac
            wg_pending=; continue
        fi
        case $wg_tool in
            dd)
                case $wg_arg in of=*) wg_target "${wg_arg#of=}" || return 1 ;; esac
                continue ;;
        esac
        if [ "$wg_options" = 1 ]; then
            case $wg_arg in
                --) wg_options=0; continue ;;
                --target-directory=*) [ "$wg_tool" != mv ] || wg_destination=1; continue ;;
                --target-directory) [ "$wg_tool" != mv ] || { wg_destination=1; wg_pending=skip; }; continue ;;
                --backup|--suffix|--interactive|--preserve-root|--no-preserve-root|--one-file-system|--verbose|--force|--recursive|--dir|--parents|--ignore-fail-on-non-empty|--no-target-directory|--strip-trailing-slashes) continue ;;
                --*)
                    case $wg_tool:$wg_arg in
                        shred:--iterations|shred:--size|shred:--random-source|wipefs:--offset|wipefs:--types|wipefs:--output|mkfs:--type|mkfs.fat:--offset|mkfs.vfat:--offset|mkfs.msdos:--offset|mkfs.fat:--variant|mkfs.vfat:--variant|mkfs.msdos:--variant|mkfs.fat:--codepage|mkfs.vfat:--codepage|mkfs.msdos:--codepage) wg_pending=skip ;;
                    esac
                    continue ;;
                -?*)
                    wg_flags=${wg_arg#-}
                    case $wg_tool in
                        mv)
                            # -t and -S consume the remainder, or the next argv.
                            while [ -n "$wg_flags" ]; do
                                wg_flag=${wg_flags%"${wg_flags#?}"}; wg_flags=${wg_flags#?}
                                case $wg_flag in
                                    t) wg_destination=1; [ -n "$wg_flags" ] || wg_pending=skip; break ;;
                                    S) [ -n "$wg_flags" ] || wg_pending=skip; break ;;
                                esac
                            done ;;
                        shred|wipefs|mkfs|mkfs.*)
                            while [ -n "$wg_flags" ]; do
                                wg_flag=${wg_flags%"${wg_flags#?}"}; wg_flags=${wg_flags#?}
                                case $wg_tool in mkfs.*)
                                    if wg_mkfs_value_option; then
                                        [ -n "$wg_flags" ] || wg_pending=skip
                                        break
                                    fi ;;
                                esac
                                case $wg_tool:$wg_flag in
                                    shred:n|shred:s|wipefs:o|wipefs:t|wipefs:O|mkfs:t)
                                        [ -n "$wg_flags" ] || wg_pending=skip
                                        break ;;
                                esac
                            done ;;
                    esac
                    continue ;;
            esac
        fi
        case $wg_tool in
            mv)
                wg_operands=$((wg_operands + 1))
                eval "wg_operand_$wg_operands=\$wg_arg" ;;
            diskutil)
                if [ -z "$wg_disk_command" ]; then wg_disk_command=$wg_arg
                elif [ -z "$wg_disk_sub" ]; then wg_disk_sub=$wg_arg
                fi ;;
            *) wg_target "$wg_arg" || return 1 ;;
        esac
    done
    if [ "$wg_tool" = mv ]; then
        [ "$wg_destination" = 1 ] || wg_operands=$((wg_operands - 1))
        wg_k=1
        while [ "$wg_k" -le "$wg_operands" ]; do
            eval 'wg_value=${wg_operand_'"$wg_k"'}'
            wg_target "$wg_value" || return 1
            wg_k=$((wg_k + 1))
        done
    elif [ "$wg_tool" = mkfs ] || [ "${wg_tool#mkfs.}" != "$wg_tool" ]; then
        # Formatting a file image is an erase too; the callback owns approval.
        [ "$wg_targets" -eq 0 ] || wg_match=$wg_path
    elif [ "$wg_tool" = diskutil ]; then
        case $wg_disk_command:$wg_disk_sub in
            erase*:*|secureErase:*|zeroDisk:*|randomDisk:*|partitionDisk:*|resetFusion:*|apfs:deleteVolume|apfs:deleteContainer|apfs:eraseVolume)
                wg_match=$wg_disk_command
                # Preserve diskutil operands as callback targets as well.
                for wg_arg do wg_last=$wg_arg; done
                if [ -n "$wg_last" ]; then
                    wg_target "$wg_last" || return 1
                    wg_match=$wg_path
                fi ;;
        esac
    fi
}

# Enumerate each candidate root once. Selection counts were deduplicated
# during argv processing, so child coverage costs O(argv bytes + children).
wg_children() {
    [ "$wg_tool" = rm ] || [ "$wg_tool" = rmdir ] || [ "$wg_tool" = mv ] || return 0
    wg_i=1
    while [ "$wg_i" -le "$wg_roots" ]; do
        eval 'wg_selected=${wg_selected_'"$wg_i"'-0}'
        if [ "$wg_selected" -gt 0 ]; then
            eval 'wg_root=${wg_root_'"$wg_i"'}'
            wg_base=${wg_root%/}; wg_total=0
            for wg_child in "$wg_base"/* "$wg_base"/.[!.]* "$wg_base"/..?*; do
                [ -e "$wg_child" ] || [ -L "$wg_child" ] || continue
                wg_total=$((wg_total + 1))
            done
            if [ "$wg_total" -gt 0 ] && { [ "$wg_selected" -eq "$wg_total" ] || { [ "$wg_selected" -ge 2 ] && [ $((wg_selected * 10)) -ge $((wg_total * 9)) ]; }; }; then
                [ "$wg_fast_roots" = 1 ] && [ -n "$wg_end" ] || { wg_match=$wg_root; return 0; }
                # Compact candidates are numbered in argv order. A writer-format
                # file names the first root in file order, as the full parser did.
                wg_pos=${wg_root_text%%\""$wg_root"\"[],]*}
                if [ -z "$wg_match" ] || [ "${#wg_pos}" -lt "$wg_match_pos" ]; then
                    wg_match=$wg_root; wg_match_pos=${#wg_pos}
                fi
            fi
        fi
        wg_i=$((wg_i + 1))
    done
}
