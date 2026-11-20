2663df6fb5b4c382262854a90eb2594b0b114c1a
T30A notes. Base 2663df6f, branch lane/0162-chrome-t30a. Worktree /Volumes/Fixture/workspace/murage-0162-chrome-t30a.
- Chrome on Hetzner: Playwright Chromium from the mcr.microsoft.com/playwright:v1.59.1-noble image (no Chrome for Testing binary on the box); launched with --no-sandbox in the container. Renderer is standalone: uses Cdp from presence-demo/harness.mjs unchanged, presence.mjs untouched.
- Inter variable font (OFL, from Sean's font folder) copied to scripts/sidepanel-mock/fonts so shots do not depend on installed fonts.
