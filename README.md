# devtools-hatchery

Bun monorepo for Chrome DevTools extensions and shared build helpers.

## Extensions

### Network++ (`extensions/network-export`)

A Chrome DevTools panel that augments the built-in Network tab with powerful analysis tools.

**Features:**
- Sortable, resizable request table with time, name, source, and size columns
- In-flight request tracking (optional): user can allow `http://*/*` and `https://*/*` in the panel to show pending rows; finished requests use DevTools APIs only
- Impact analysis — tabbed right panel with **By Resource** (top files / by type donut chart) and **By Domain** (percentage bar chart) views
- Persistent glob/wildcard filters to exclude noise from capture
- Pause/resume capture mode
- **AI Prompt Generator** — record user interactions (clicks, navigations), capture the network waterfall, and generate context-rich markdown prompts with three built-in lenses:
  - **Performance Audit** — bundle breakdown, large resource detection, duplicate request flagging
  - **Route Analysis** — from/to URL, API vs static split, trigger identification
  - **Action Trace** — interaction timeline correlated with request cascade, parallel/sequential pattern detection
- Light and dark theme support (follows DevTools theme)
- One-click copy of request data to clipboard

**Install from Chrome Web Store:** *(link pending)*

**Load unpacked (dev):**
1. `chrome://extensions` → enable **Developer mode**
2. **Load unpacked** → choose `extensions/network-export/dist`
3. Open DevTools on any tab → **Network++** panel

## Layout

| Path | Purpose |
|------|---------|
| [`packages/extension-build`](packages/extension-build) | Shared TypeScript base config and `buildExtension()` (Bun bundling + static copy to `dist/`) |
| [`extensions/network-export`](extensions/network-export) | **Network++** — DevTools panel for network analysis |

## Build

```bash
bun install
bun run build
```

The loadable extension is emitted to `extensions/network-export/dist`.

### Icons

Master asset: `extensions/network-export/icons/logo_network.jpg` (square crop). Regenerate PNGs for the manifest after editing:

```bash
bun run --cwd extensions/network-export icons
```

### Pack for Chrome Web Store

After a successful build, create a zip ready for upload:

```bash
bun run --cwd extensions/network-export pack
```

This writes `extensions/network-export/network-export.zip`. Upload it in the [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole).

### Permissions (store review)

The manifest declares **`storage`**, **`webRequest`**, and **`optional_host_permissions`** for `http://*/*` and `https://*/*` only (no default `<all_urls>`). The DevTools **Network** API supplies completed requests without host access; **`webRequest`** is used only after the user clicks **Allow** in the panel, to show in-flight rows. **`file://`** pages are unchanged (no optional grant applies).

**`webRequest` justification (English):** Used only when the user opts in; registers non-blocking listeners on `http://*/*` and `https://*/*` to correlate `requestId` with the inspected tab and show pending requests. No request/response bodies are read.

**Optional host justification:** Not requested at install. If the user allows it, the extension can observe request start/finish metadata for any http(s) page so pending indicators work on arbitrary sites the developer is debugging.

## Add another extension

1. Create `extensions/<name>/` with `src/manifest.json`, HTML, and TS entrypoints.
2. Add a `build.ts` that imports `buildExtension` from `packages/extension-build/build-extension.ts`.
3. Add `package.json` with a `build` script — the root workspace glob `extensions/*` picks it up automatically.

## License

MIT — see [LICENSE](LICENSE).
