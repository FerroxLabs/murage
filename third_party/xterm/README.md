# xterm.js

The Cloud-home engine sign-in view (`src/components/EngineLoginTerminal.tsx`)
draws the vendor CLI's terminal with [xterm.js](https://github.com/xtermjs/xterm.js),
npm package `@xterm/xterm`, pinned at exactly `6.0.0`. Licence: MIT (see
`LICENSE`). It is bundled unmodified into the renderer by Vite. Murage uses the
core terminal only (no addons) and swallows the OSC 52 (clipboard) and OSC 8
(hyperlink) sequences; links are matched by Murage's own allow-listed detector.
