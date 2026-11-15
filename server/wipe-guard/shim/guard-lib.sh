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

wg_read_guard() {
    wg_split_guard=0
    # read can split the two arrays in C while it reads the compact file. This
    # avoids shell glob searches over a growing roots array. The final variable
    # preserves the remainder verbatim. Unusual brackets/formatting fall back.
    if IFS='[]' read -r wg_header wg_root_items wg_between wg_client_items wg_tail < "$MURAGE_WIPE_GUARD"; then
        : # A newline may precede further content: use the complete reader.
    else
        case $wg_header:$wg_between:$wg_tail in
            *'"roots":':',"client":':',"realTools":{'*)
                wg_guard_text=$wg_header'['$wg_root_items']'$wg_between'['$wg_client_items']'$wg_tail
                [ "${#wg_guard_text}" -le 262144 ] || return 1
                wg_split_guard=1
                return 0 ;;
        esac
    fi
    wg_guard_text=; wg_join=
    while IFS= read -r wg_line || [ -n "$wg_line" ]; do
        wg_guard_text=$wg_guard_text$wg_join$wg_line; wg_join=$wg_nl
        [ "${#wg_guard_text}" -le 262144 ] || return 1
    done < "$MURAGE_WIPE_GUARD"
}

# The turn writer uses JSON.stringify in this fixed schema order. The fast
# reader decodes only roots and this tool's real path; unrelated realTools,
# client and token bytes need no work. A match always undergoes the full parser
# before callback. Pretty/alternate-order JSON uses that same full parser.
wg_fast_guard() {
    [ "$wg_split_guard" = 1 ] || return 1
    # Check only the short header; matching across roots with several wildcards
    # causes quadratic backtracking in supported shells.
    case $wg_header in
        '{"v":1,"socket":"'*'","threadId":"'*'","token":"'*'","roots":') ;;
        *) return 1 ;;
    esac
    wg_json=${wg_tail#',"realTools":{'}
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
    wg_root_text='['$wg_root_items']'
    wg_json=$wg_root_text
    case $wg_root_text in
        *'\'*|*'"'[a-zA-Z]':'*)
            # Escaped/non-POSIX roots need the complete decoder and normalizer.
            wg_load_request || return 1
            wg_array=roots
            wg_strings || return 1
            [ -z "$wg_json" ] || return 1 ;;
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

wg_device() {
    # Character sinks and ordinary /dev files are benign. Real block devices,
    # Linux disk families, BSD raw disks and Windows physical drives match.
    case $wg_path in
        /dev/sd[a-z]*|/dev/hd[a-z]*|/dev/vd[a-z]*|/dev/xvd[a-z]*|/dev/nvme[0-9]*|/dev/mmcblk[0-9]*|/dev/loop[0-9]*|/dev/disk[0-9]*|/dev/rdisk[0-9]*|/dev/mapper/*|/dev/disk/*|//./PhysicalDrive[0-9]*|//./physicaldrive[0-9]*) return 0 ;;
    esac
    [ -b "$wg_path" ]
}

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
                wg_match=$wg_root; return 0
            fi
        fi
        wg_i=$((wg_i + 1))
    done
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
    wg_cwd=$PWD
    CDPATH= cd -P . 2>/dev/null || return 1
    wg_cwd=$PWD
    case $wg_dir in /*) ;; *) wg_dir=$wg_cwd/$wg_dir ;; esac
    CDPATH= cd -P -- "$wg_dir" 2>/dev/null || return 1
    wg_shim_dir=$PWD
    CDPATH= cd -P -- "$wg_cwd" 2>/dev/null || return 1
    wg_valid=0; wg_fast=0; wg_fast_roots=0; wg_request_loaded=0
    if [ -n "${MURAGE_WIPE_GUARD-}" ] && [ -r "$MURAGE_WIPE_GUARD" ] && wg_read_guard 2>/dev/null; then
        if wg_fast_guard; then wg_valid=1
        else
            wg_roots=0; wg_clients=0; wg_fast_roots=0
            if wg_load_request && wg_guard; then wg_valid=1; fi
        fi
    fi
    wg_find_real || return 1
    if [ "$wg_valid" = 1 ] && [ "$wg_off" = 0 ] && [ "${MURAGE_WIPE_GUARD_OFF-}" != 1 ]; then
        # Canonicalize the roots once as well (also normalizes Windows forms).
        wg_k=1
        while [ "$wg_k" -le "$wg_roots" ]; do
            eval 'wg_value=${wg_root_'"$wg_k"'}'
            # Guard-file roots are already canonical by contract. Only unusual
            # forms (including Git Bash drive paths) need normalization here.
            case $wg_value in
                '') wg_exec "$@" ;;
                [a-zA-Z]:*|/[a-zA-Z]/*|*/../*|*/./*|*/..|*/.|*/)
                    if ! wg_canon "$wg_value"; then wg_exec "$@"; fi
                    eval "wg_root_$wg_k=\$wg_path" ;;
            esac
            wg_k=$((wg_k + 1))
        done
        if wg_argv "$@"; then
            [ -n "$wg_match" ] || wg_children
            if [ -n "$wg_match" ]; then
                if [ "$wg_fast" = 1 ]; then
                    wg_roots=0; wg_clients=0
                    if ! wg_load_request || ! wg_guard; then wg_exec "$@"; fi
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
