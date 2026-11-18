# Fuigo 1.0.42 pin

Release digest tables transcribed from the supplied FUIGO-1042-PIN.md (2026-11-10).

- npm: `fuigo@1.0.42`, dist-tag `latest`
- Tag `v1.0.42` → commit `c1605c300fdd2d6c8cece9450b4cac11a3870f69`
- `fuigo --version` → `fuigo 1.0.42 (c1605c300fdd)`
- Release: https://github.com/FerroxLabs/fuigo/releases/tag/v1.0.42

## npm packages (all at 1.0.42)

| package | dist.integrity | dist.shasum |
|---|---|---|
| fuigo | sha512-LKOt+o6GZHUUg4RDX4i46rXH/LxDf5D0Mr51xWZ4856KhyhInVdRK9T7yARWOjUf9EExSEZ6i8Xfq+HqRoYjzg== | 0324fb41bbb9d0b2928ac46a35980ad1206c8317 |
| @fuigo/linux-x64 | sha512-fuNrxUXCsoMHg9MgHCcoKGHjr9mikZ+AYxWNcnoOhZmxxciS9NqDMhePwCiTijhEa3bMotKmUt+RbVrK3jk64w== | 174beae3a1f0cd391c03cd1efc7ac2e017eb96ee |
| @fuigo/linux-arm64 | sha512-6t30AqVzoWCa8VybH0TCkRdSnKxHPe6DBN5q+fyjE2HQMcc5SkZUopsO437Kdz56KaytaR34l2/n0zx+1hugRg== | dccdefed101f3b476333338c02c755bafac37162 |
| @fuigo/darwin-arm64 | sha512-pm7oPQo8gkYKo6N9ux4+i7euLGInPeYUqPcEBnZrpQ5tBX1kd3nJ76BUbXx1rnOP4Vwm/nXAGZQlLMpqVujdIQ== | 7a61c6e97c51945e4d5c4becdf47c16bda50eb66 |
| @fuigo/darwin-x64 | sha512-ZCEws2zOefBAyZc19lrwzIGPaLh1iQtYklyJfwdmbVsVTHITPhlfOo2chcj69CSaqDKfigIfvZeLcUPmF/WNAw== | 7653e324effff55a2915dca3593842ea853de7a8 |
| @fuigo/win32-x64 | sha512-0guliPEUYUnYiNf9+ULagyqwL4sAHyI6nO1VjE/AsGhUdBZVywb0tE6R7gzuRLyvKLlTO1oeeHMgQnBKhYyldg== | ce3470bfabf98dfca84384f3fa0f5f477a21ce86 |
| @fuigo/win32-arm64 | sha512-kZ8Xnxitp37D39kDllA3BF0YwJdUaaCCfFFSj2oO8ea+RQjm31J7rFUMh2xyqWxhDYLxI1NIF2XSUgrOBTL9RQ== | 64d0e5307c65644ef65f2791da0783088db0bc40 |

## Binary sha256 (GitHub Release SHA256SUMS)

| asset | sha256 |
|---|---|
| fuigo-1.0.42-linux-aarch64 | d086bf107572f5104c78dc200ab15a21e27ddae92495d0d8df20a55e1ac5cf9e |
| fuigo-1.0.42-linux-x86_64 | 2062dfcb24505f2e3ed83af20b32b1c81bf65669b17fa3f316a9226d2d475a0c |
| fuigo-1.0.42-macos-aarch64 | 1d99663baf3aeae0d424c1d7536a00180cd11a4cfb67146aa2ed18a9f2a2b6cc |
| fuigo-1.0.42-macos-x86_64 | 71238a85f2106de22d3c5911dbd1cd3547d58b42a29a7224a76369d2148828d2 |
| fuigo-1.0.42-windows-aarch64 | d8b359f8bb22c4dd1e5c1571c4553dbd3379228ba3050ea025960abcdc82372c |
| fuigo-1.0.42-windows-x86_64 | 460e7bdc6b81f6a96a475d725b732cb588f842f2a6223ca1d7187cefe715d8f1 |
| fuigo-1.0.42.tgz | 60e99b0fb954b4fa96dda6caae2f370d5ad91eb7a66e8f790ab69eb10c4722e8 |
| fuigo-darwin-arm64-1.0.42.tgz | 2ee35d53ce049e814cdc02270be0e837b531979a2cbd603dd258d6a6fd445c3e |
| fuigo-darwin-x64-1.0.42.tgz | 2f162e7fba8cba52f51c341395fc816f353363edfa9d7e2483c46c714144419c |
| fuigo-linux-arm64-1.0.42.tgz | c85c684bbc1a4998c9cf142c03f70dd11b01523bae3d5c07bf277413530b9f1d |
| fuigo-linux-x64-1.0.42.tgz | 819c8ba3495fcd22b57ae7e2169fb9eb405369bc0381c21018c98a373bd88403 |
| fuigo-win32-arm64-1.0.42.tgz | 1b2308be7a48fa0e9266a8fcc6c23b608c4ddabf7c953a1e3c16d9c71e61c015 |
| fuigo-win32-x64-1.0.42.tgz | bf6ee5530bbb17916558ec02760affc8f3cad1ce9d1bb6ab523e1006a5123059 |
| release-manifest.json | 8200e8ce1259a38c2cffbea156d87588ecf1619a47a97ebd5b9b48ab5b336785 |

## Upstream verification receipt

- **Release gate** (`final-gate.sh --network none`) on hub `413f407d6`, tree `b1ca098c` (the shipped tree): 476/476 test targets, failing set 0, 2026-11-10 12:52Z–13:46Z, log sha256 `22d7bf9d17e05d623140a1bd2cc66703e8b5f047fc50ef9799da95bf2e69d9d2`. Selftest 404/404. Evidence: build host `/root/fuigo-builds/u42-gate/GATE-RESULT.md`, run dir `runs/20261110T125245Z-4024897`. The first attempt (run `20261110T115025Z-2375506`) had 13 failures: 12 came from a private TMPDIR I set and pass without it; 1 was real (P54 identity-body guard counts for three new test-literal sites), fixed in `413f407d6` before the passing run.
