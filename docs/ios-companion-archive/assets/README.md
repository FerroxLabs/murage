# The app icon — the one asset here that Phase D actually builds from

MASTER-PLAN §3 Phase D row D-b sources every PWA icon from
`ios/App/Assets.xcassets/AppIcon.appiconset/icon-1024.png` and cites it by that
exact path. `ios/` is deleted, so **this is where it lives now**:

```
docs/ios-companion-archive/assets/AppIcon.appiconset/icon-1024.png   <- the file D-b wants
docs/ios-companion-archive/assets/AppIcon.appiconset/Contents.json   <- the Xcode catalog entry, for the record
docs/ios-companion-archive/assets/icon-1024.png                      <- identical flat copy, so a path guess lands either way
```

All three are byte-identical to `HEAD:ios/App/Assets.xcassets/AppIcon.appiconset/icon-1024.png`:

```
sha256  d3a97c48fa60f6f85c14346a7e7c47ade5c4f34abb3decd05aabd8f476aa796b
```

`Assets.xcassets` contained nothing else — those two files were the entire
catalog. There was no launch-screen asset.

## Measured properties

| Property | Value | Why it matters |
|---|---|---|
| Dimensions | 1024 × 1024 | Big enough to `sips` down to 192 and 512 without resampling artefacts. |
| Colour mode | RGB, `hasAlpha: no` | **Opaque.** A PWA icon with transparency gets a white plate behind it on iOS home screens. |
| Corner pixel | `(16, 15, 21)` = `#100F15` | The ground. Confirms the plan's sampled `background_color`. Use this for the manifest so the splash has no seam. |
| Centre pixel | `(249, 84, 9)` | The mark itself. |

## Do not substitute another file

Every other icon-shaped asset in the repo is RGBA with a fully transparent
corner, which is the wrong input for a home-screen icon:

| Candidate | Mode | Size | Corner |
|---|---|---|---|
| `electron/resources/app-icon.png` | RGBA | 1024 × 1024 | transparent |
| `brand/MurageIcon-Dark.png` | RGBA | 1254 × 1254 | transparent |
| `brand/MurageIconIsolated.png` | RGBA | 1254 × 1254 | transparent |
| `public/murage-logo.png` | RGBA | 2172 × 724 | transparent (and a wordmark, not a square icon) |

None of them is byte-equal to the archived file. It is the only opaque square
1024 icon in the repository, which is exactly why row D-b named it.
