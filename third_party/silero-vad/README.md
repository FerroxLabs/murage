# Silero VAD

`public/vad/silero_vad.onnx` is the Silero VAD model (the v5 ONNX export),
from https://github.com/snakers4/silero-vad, as distributed with Pipecat
(`pipecat/audio/vad/data/silero_vad.onnx`, commit 5a669336).

SHA-256: 597d30b3ec076608d059477bb14cfeffdf951bf5cae370d38f65d33bbfe82004

Used on calls to tell the owner's speech from other sounds before the bot is
interrupted (`src/lib/silero-vad.ts`). Licensed under the MIT License; see
LICENSE in this directory.
