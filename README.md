# Vault Automation

Schema-agnostic automation API for Obsidian. It emits frontmatter-change and path events and offers property, note, canvas, and Window Spaces actions; **adapters** (other plugins) bring the meaning. The contract is [`src/api.ts`](src/api.ts), reachable at runtime as `app.plugins.plugins["vault-automation"].api` (version 1).

| Area | API |
| --- | --- |
| Adapters | `registerAdapter({ id, activate(api) })` |
| Events | `onPropertyChange({ folder?, keys?, where? }, handler)`, `onPathEvent({ folder?, pattern?, types?, folders? }, handler)`, `batch(fn)` |
| Actions | `props.get/set`, `notes.*` (list, move, createFromTemplate, resolveLink, …), `canvas.sync(spec, { rebuild? })`, `spaces.*` |
| Utilities | `schema.load(path)` (JSON Schema `$defs` subset), `debounce(key, ms, fn)` |

`spaces.*` drives [Window Spaces (RLOS fork)](https://github.com/EugeneChan00/obsidian-window-spaces) and returns null / no-ops when it is not installed.

## Install

With [BRAT](https://github.com/TfTHacker/obsidian42-brat): *Add beta plugin* → `EugeneChan00/obsidian-vault-automation`.

## Develop

```bash
npm install
npm run build                 # type-check + bundle main.js
RLOS_VAULT=/path/to/vault npm run deploy   # copy into <vault>/.obsidian/plugins/vault-automation
```

## Release

Bump `version` in `manifest.json` and `package.json`, commit, push, then `npm run release` (builds and creates a GitHub release with the plugin files, which BRAT installs).
