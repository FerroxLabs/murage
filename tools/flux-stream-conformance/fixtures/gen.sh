#!/usr/bin/env bash
# tools/flux-stream-conformance/fixtures/gen.sh
# Regenerates the committed fixtures. macOS only (say, afconvert). The .pcm
# files are committed so Linux CI and the Flux team never need to run this.
set -euo pipefail
cd "$(dirname "$0")"
VOICE="${VOICE:-Samantha}"
RATE_WPM="${RATE_WPM:-180}"
work="$(mktemp -d)"
source ../../../scripts/safe-wipe.sh   # the only recursive delete scripts may use
trap 'safe_wipe "$work"' EXIT

# id|expected_turns|class|keyterms|text   ([[slnc N]] is an N ms pause; a segment boundary)
cat > "$work/list" <<'LIST'
f01-plain|1|plain||What's the weather like in Bangkok today?
f02-comma|1|pause||My favourite movies are Blues Brothers, [[slnc 1200]] and Heartbreak Ridge.
f03-list|1|pause||Blues Brothers, [[slnc 900]] Trading Places, [[slnc 900]] and Ghostbusters.
f04-clause|1|pause||I wouldn't say cliche because most people [[slnc 1300]] never actually watch it.
f05-tail|1|pause||I appreciate that, and dead on the money [[slnc 1100]] across the board there.
f06-frame|1|pause||Put yourself in the fixer frame [[slnc 1000]] and think about strengths.
f07-two|2|plain||Tell me a joke. [[slnc 3500]] Actually, make it about cats.
f08-stop|1|plain||Stop.
f09-backchannel|1|plain||Uh-huh.
f10-long|1|long||I have been thinking about the trip for a while now and I would like to go somewhere warm in the winter, maybe the south of Thailand or somewhere in Vietnam, with good food and a quiet beach where I can read and swim every morning before it gets too hot to do anything at all.
f12-names|1|plain|Sable|Ask Sable about Heartbreak Ridge.
LIST

echo "[" > manifest.json
first=1
while IFS='|' read -r id turns class keyterms text; do
  say -v "$VOICE" -r "$RATE_WPM" -o "$work/$id.aiff" "$text"
  afconvert -f WAVE -d LEI16@16000 -c 1 "$work/$id.aiff" "$work/$id.wav"
  # the WAV data chunk, found by parsing (afconvert adds a FLLR chunk; the data is not at byte 44)
  stats="$(node --experimental-strip-types analyse.ts --extract "$work/$id.wav" "$id.pcm")"
  plain="$(printf '%s' "$text" | sed -E 's/ ?\[\[slnc [0-9]+\]\] ?/ /g')"
  segs="$(printf '%s' "$text" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.stringify(s.split(/ ?\[\[slnc \d+\]\] ?/).map(x=>x.trim()))))')"
  kt="[]"; [ -n "$keyterms" ] && kt="[\"$keyterms\"]"
  [ $first -eq 0 ] && echo "," >> manifest.json
  first=0
  node -e '
    const [id, turns, cls, text, segs, kt, stats] = process.argv.slice(1);
    const s = JSON.parse(stats);
    process.stdout.write(JSON.stringify({ id, text, segments_text: JSON.parse(segs), expected_turns: Number(turns), class: cls,
      speech_segments: s.segments, speech_end_ms: s.speech_end_ms, duration_ms: s.duration_ms, sha256: s.sha256, keyterms: JSON.parse(kt) }, null, 2));
  ' "$id" "$turns" "$class" "$plain" "$segs" "$kt" "$stats" >> manifest.json
done < "$work/list"

# f11: 8 s of digital silence
head -c $((16000 * 2 * 8)) /dev/zero > f11-silence.pcm
sum="$(shasum -a 256 f11-silence.pcm | cut -d' ' -f1)"
echo "," >> manifest.json
echo "{\"id\":\"f11-silence\",\"text\":\"\",\"segments_text\":[],\"expected_turns\":0,\"class\":\"silence\",\"speech_segments\":[],\"speech_end_ms\":0,\"duration_ms\":8000,\"sha256\":\"$sum\",\"keyterms\":[]}" >> manifest.json
echo "]" >> manifest.json
echo "fixtures written: $(ls *.pcm | wc -l | tr -d ' ')"
