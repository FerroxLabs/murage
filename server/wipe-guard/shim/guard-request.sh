# POSIX sh JSON grammar and matched-request serialization. Loaded on demand.
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
    wg_char=$(printf "$wg_bytes.")
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

wg_guard() {
    wg_json=$wg_guard_text
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
                wg_num=$(printf '%d' "'$wg_char")
                wg_escape=$(printf '\\u%04x' "$wg_num")
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
