# Engines and Doctor

## Sub-features

- Confirm the endpoint identifies itself as Murage.
- List configured provider instances without exposing executable paths.
- Distinguish available and unavailable engines.

## User path

Open a bot's model picker or Settings → Engines.

## Driving it

```sh
pnpm control:murage doctor --url http://127.0.0.1:PORT
pnpm control:murage models --url http://127.0.0.1:PORT
```

`doctor.ok` is true only when the endpoint is Murage and at least one
engine is available. The isolated fixture exposes exactly `verification`,
using the fake Claude driver. Its custom instance name deliberately avoids
the product fleet's automatic real-engine additions.

## Gotchas

- Doctor proves server/engine readiness, not authentication against a real
  provider.
- Model-picker rendering is Electron UI and remains outside this first map.
