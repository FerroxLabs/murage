#!/usr/bin/env node
// Launcher/handle producer owner: gnl-harness-r11. Fake consumer owner: gnl-harness-r11.
import {gatedHandle} from '../gated-runtime.mjs';
import {runFake} from '../fakes/release-tool-service.mjs';
await runFake(gatedHandle);
