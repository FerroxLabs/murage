# Call audio decoder fixtures

Small files for `MurageCallAudioCoreTests` (spec §6.1): each is under
100 KB and holds a synthetic voice (`say`, Samantha) or a sine. Nothing here
is a recording of a person.

| File | What it covers |
|---|---|
| `voice-id3.mp3` | MP3 behind a padded ID3v2 tag (6,156 bytes, longer than the decoder's 4 KB parse step, so a parse boundary falls inside it), CBR 48 kbps, 44.1 kHz mono, 10 s. Also the 10 s timing clip. |
| `voice-vbr.mp3` | VBR MP3 (`-V 6`), 22.05 kHz mono. |
| `voice.wav` | WAV, 16 kHz mono 16-bit, 2.5 s. |
| `voice.aac` | ADTS AAC, 24 kHz mono, 32 kbps. |
| `voice-stereo.mp3` | Stereo MP3, silence on the left and a 440 Hz sine on the right, 2 s. Only a downmix makes it audible in mono. |
| `voice.m4a` | MP4/M4A with `moov` after `mdat` (ffmpeg's default without `+faststart`), which cannot be streamed. |

Generated on macOS with `say`, LAME 4.0 and ffmpeg 8.1.2:

```sh
T=$(mktemp -d)
say -v Samantha -o $T/long.aiff "Hello, this is the Murage call audio test. The voice you hear is streamed in small pieces, decoded on the phone, and played through the echo canceller, so you can talk over it at any time."
say -v Samantha -o $T/short.aiff "Hello, this is a short test clip for the decoder."

ffmpeg -v error -y -i $T/long.aiff -t 10 -ac 1 -ar 44100 $T/long.wav
lame --quiet -m m -b 48 --resample 44.1 --add-id3v2 --id3v2-only --pad-id3v2-size 6000 \
  --tt "Murage fixture" --ta "Murage" $T/long.wav voice-id3.mp3

ffmpeg -v error -y -i $T/short.aiff -ac 1 -ar 22050 $T/short22.wav
lame --quiet -m m -V 6 $T/short22.wav voice-vbr.mp3

ffmpeg -v error -y -i $T/short.aiff -t 2.5 -ac 1 -ar 16000 -c:a pcm_s16le voice.wav

ffmpeg -v error -y -i $T/short.aiff -ac 1 -ar 24000 -c:a aac -b:a 32k -f adts voice.aac

ffmpeg -v error -y -f lavfi -i "anullsrc=r=44100:cl=mono" -f lavfi -i "sine=frequency=440:sample_rate=44100" \
  -filter_complex "[0:a][1:a]join=inputs=2:channel_layout=stereo[a]" -map "[a]" -t 2 $T/stereo.wav
lame --quiet -m s -b 96 --resample 44.1 $T/stereo.wav voice-stereo.mp3

ffmpeg -v error -y -i $T/short.aiff -ac 1 -ar 24000 -c:a aac -b:a 32k -f mp4 voice.m4a

rm -rf $T
```
