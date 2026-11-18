// SPDX-License-Identifier: AGPL-3.0-or-later
import {installCopyMeter} from "./io-meter.ts";
installCopyMeter();
import {installChildProcessMeter} from "./io-child-meter.ts";
installChildProcessMeter();

import {enableDefaultSentinelCoverage} from "./sentinel-file-sampling.ts";
enableDefaultSentinelCoverage();
