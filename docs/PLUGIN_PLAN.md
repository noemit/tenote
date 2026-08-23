# Plugin system plan (rev 2)

Tenote grows a plugin system in the spirit of [pi-coding-agent](https://github.com/badlogic/pi-mono): a small kernel, built-in features as plugins, third-party plugins through the exact same path. Rev 2 replaces the rev 1 plan after audit; the significant changes are a renderer-side plugin runtime, the chip/theme/content UI contract, and a deliberately narrower v1 scope (storage stays kernel).

Sources: pi architecture writeups, plus this repo's `main.js`, `preload.js`, `renderer/*`, and `docs/AUDIT.md`.

## What "everything is a plugin" means here

1. The kernel owns only what cannot vary: app lifecycle, window mechanics, the composer and autosave chain, note storage, the plugin hosts (main and renderer), IPC plumbing, settings file mechanics, logging.
2. Everything else ships as a plugin: themes, socket commands, global shortcut, tray extras, and every feature added later. Built-ins and user-dropped plugins go through one path.
3. A plugin is ordinary CommonJS: `module.exports = function (tenote) {}`, metadata on the export or in an optional `plugin.json`. No transpiler, no required manifest for JS-only plugins; manifests exist for theme packs and anything with a renderer part.

Honest caveat: the editor does not become a plugin, and neither does note storage in v1. A notes app whose composer and save path are pluggable is a framework.

## Architecture

```
lib/host.js                 main-process host: discovery, activation, registries, hooks (pure Node, DI'd)
plugins/builtin/            built-in plugins shipped in the bundle
renderer/loader.js          renderer-side runtime: plugin loading, chips, themes, md filters, plugin settings UI
examples/                   sample plugins (never packaged)
docs/PLUGINS.md             authoring guide
test/host.test.js           node:test coverage for the host
```

### Plugin shape

```js
// my-plugin/index.js (dirs) or my-plugin.js (single file)
'use strict';
module.exports = function myPlugin(tenote) {
  tenote.on('note:saved', ({ id }) => tenote.log.info('saved', id));
};
module.exports.name = 'my-plugin';
module.exports.version = '1.0.0';
```

Directory plugins may add `plugin.json`:

```json
{
  "name": "theme-pack",
  "version": "1.0.0",
  "themes": [{ "id": "forest", "name": "Forest", "css": "forest.css", "swatch": "#1c241c,#39473a" }],
  "renderer": "renderer.js"
}
```

- `themes` makes a valid zero-JS plugin (CSS variable overrides; see Theme contract).
- `renderer` opts into a renderer part: `renderer.js` is authored exactly like a main-side plugin (`module.exports = function (tenote) {}`) and runs inside the card's page context.

### Main-process API (`tenote` object)

```js
tenote.on(event, fn)              // ready, window:shown, window:hidden, note:before-save,
                                  // note:saved, note:opened, app:before-quit
tenote.registerCommand(name, fn)  // socket/tenotectl command; reply string or object (JSON)
tenote.registerService(obj)       // methods callable from the renderer via invokePlugin
tenote.registerTrayItem(item)     // { label, type?, checked?, click } appended under a Plugins separator
tenote.registerGlobalShortcut(acc, fn)
tenote.log                        // name-prefixed
tenote.settings.get(key, fallback) / .set(key, value)   // namespaced: plugins.values.<name>.<key>
tenote.dataDir()                  // userData/plugin-data/<name>/
tenote.window.toggle/show/hide()
tenote.app.quit()
tenote.notesDir                   // read-only
tenote.notes.list/read/save/recent                      // kernel storage behind safe wrappers
tenote.system.status()            // plugin states, for status-style commands
```

`note:before-save` is a pipeline: handlers run in activation order, an returned object replaces `{ id, text, tags }`, returning nothing passes through. One hook covers tagging, templates, scrubbing.

### Renderer API

Same authoring style, different surface, executed in the page (trusted, see Trust model):

```js
tenote.ui.chips.add({ icon?, label?, variant?: 'default'|'accent',
                      onClick?, tooltip? | onHover? })
  -> { update(label, variant?), remove() }
tenote.ui.themes.apply(id)                    // switch theme programmatically
tenote.ui.markdown.addRule({ name,
  toHtml(html) -> html,                       // runs after escape-first + core rules
  beforeSerialize(root)                       // mutate rendered DOM before core serialization
})                                            // both required: display must round-trip
tenote.ui.keys.add({ combo, handler })        // consumed in the existing keydown chain
tenote.ui.settings.declare(fields)            // schema -> host-rendered modal; persisted namespaced
tenote.events.on('composer:input' | 'note:saved' | 'note:opened', fn)   // composer:input host-throttled
tenote.composer.insertText(str) / .isEmpty()
tenote.notes.list/read/save/recent            // existing bridge, wrapped
tenote.settings.get/set(key, value)           // same namespace as main side
tenote.log
```

#### Chips (the only topbar real estate)

The kernel owns the strip: `[brand][+] hint …spacer… ‹ chips › [count][⚙][—]`.

- The host renders every chip from descriptors. Two variants built from theme CSS variables: `default` (like the notes-count pill) and `accent` (inverted). A plugin cannot style a chip; it structurally cannot clash with a theme.
- `‹ ›` arrows appear only on overflow; the hint ellipsizes first.
- Hover shows a non-focusable popover dropped below the chip: `tooltip` (static) or `onHover()` (live). Hover informs; click acts. Focus never leaves the composer.

#### Themes (zero-JS)

Each theme is one CSS block defining the full variable set plus a manifest `swatch` pair for the picker. The kernel keeps a minimal `:root` fallback so late theme-sheet adoption cannot flash. Sheets apply via `constructable stylesheet` adoption — no CSP `style-src` changes, no markup parsing. Both hard-coded whitelists die (main.js `setTheme` validates against the registry; renderer applies any registered id).

#### Markdown rules

Escape-first is untouched: rules see escaped HTML, after core block parsing. Rules must provide both directions; a rule that renders but cannot serialize back is a data-loss bug, so `beforeSerialize` is mandatory. Checklists pattern: `toHtml` rewrites `- [ ] `/`- [x] ` bullet contents into checkbox markup inside the existing `<ul>`; `beforeSerialize` rewrites those nodes back to `- [ ] `/`- [x] ` text.

### Discovery layers

| Priority | Location | Notes |
|---|---|---|
| 1 | `plugins/builtin/*` | Shipped |
| 2 | `userData/plugins/*` | `~/Library/Application Support/Tenote/plugins` |
| 3 | `settings.json` → `plugins.paths` | Absolute paths |
| 4 | `TENOTE_PLUGINS=/a:/b` env | Dev ad-hoc |

Boring rules: enable/disable via `plugins.disabled: ["name"]`; name collision skips the later layer with a warning (no silent override); alphabetical within a layer; no dependency resolution.

```json
{ "plugins": { "disabled": [], "paths": [], "values": {} } }
```

### Crossing the process boundary

Preload grows exactly two channels and never grows again:

```js
invokePlugin: (plugin, method, args) => ipcRenderer.invoke('plugin:invoke', { plugin, method, args }),
onPluginEvent: (cb) => ipcRenderer.on('plugin:event', (e, evt) => cb(evt)),
```

- Main: `lib/host.js` routes `plugin:invoke` to registered services (the kernel registers `__host`: plugin list, theme CSS fetch, enable/disable, plugin settings get/set). Errors wrapped like `wrapIpc()`.
- Broadcasts ride the single `plugin:event` channel (`{ event, payload }`).
- Renderer plugin sources are injected with `webContents.executeJavaScript` after `did-finish-load`, wrapped in a CommonJS shim so authoring matches the main side; injection is not subject to page CSP, so the CSP stays untouched (stronger than planned). A `tnplug://` privileged scheme exists alongside `timg://` and serves only allow-listed discovered files (renderer sources, theme css) for direct fetching; path traversal and non-allow-listed paths 403. Injection happens per plugin after `did-finish-load`, individually fault-isolated.

## Trust model, stated plainly

Plugins run with full privileges: Node/Electron in main, the page in the renderer. No sandbox, no prompts, no capability negotiation — pi's stance. Installing a plugin means running that author's code on your machine. Consequences documented rather than engineered away: `plugins.paths` entries are arbitrary code locations (editing `settings.json` is already trust-on-read, AUDIT #15); the socket command surface grows with `registerCommand` (the socket stays `0600`; AUDIT #14's chmod race is pre-existing); `examples/` is never added to `build.files`.

## Failure isolation

- Activation in try/catch: a throw logs, marks the plugin `failed`, boot continues.
- Every hook and command invocation individually wrapped; three failures from one subscription suspends it and logs.
- `status` reports each plugin: `ok | failed | disabled`.
- Per-plugin writes confined to `dataDir()` / namespaced settings.

## Built-in conversions (v1 scope)

| Plugin | Moves | Deliberately not moved |
|---|---|---|
| `core-themes` | the five theme blocks + swatches out of styles.css into per-theme CSS + manifest | `:root` fallback stays kernel |
| `core-commands` | the socket switch (`toggle/show/hide/quit/status`) | socket server plumbing stays kernel |
| `core-shortcuts` | `registerShortcuts()` incl. env override + fallback + coalescing | — |

Explicitly deferred, with reasons: **storage-md/images** (irreplaceable data, zero demand, plan-sanctioned stop point), **tray/settings-field full conversion** (same-menu entanglement; plugin tray items append-only for now), **hot reload** (enable/disable applies at relaunch; `tenotectl plugins` lists states), **package-manager distribution**.

## Phases

Estimates are guesses, not commitments.

0. **Seams without plugins (half day).** Command map, tray-item array, theme registry, shortcut registry as kernel data structures. Zero behavior change. Extend `npm run check` to new files.
1. **Main-process host (one to two days).** Discovery, activation, registries, pipeline, isolation, status. Wire into `bootstrap()` before window/tray/IPC. Ship `examples/ping`. Acceptance: `tenotectl ping` replies through the plugin; disabling it removes it; a broken plugin fails alone.
2. **Renderer runtime (one to two days).** Two preload channels, `tnplug://`, injection shim, chips strip + arrows + hover popover, theme sheet adoption, markdown chains, settings schema modal, Plugins section. Acceptance: `examples/word-count` chip tracks typing; `examples/checklists-plus` round-trips; `examples/theme-pack` adds themes by file drop.
3. **Convert built-ins (one day).** The table above, one commit each, smoke checklist green.
4. **Docs, packaging, tests (half day).** `docs/PLUGINS.md`, `build.files += lib/**, plugins/**`, `node:test` suite for the host, `npm test`.

## Testing story

- `node:test` against `lib/host.js` (pure Node, injected deps): discovery order, collision skip, disabled filtering, failed-activation isolation, three-strikes suspension, before-save replacement semantics, registries, manifest theme collection.
- Manual checklist per phase: skhd toggle, save/reopen, theme switch, tray renders, chip hover/click, `tenotectl status`.
- Checklist round-trip asserted by hand in DevTools until the storage phase ever happens.

## Risks

- A rogue plugin can still hang or crash the app (timers, rejections outside hooks). Documented, not solved.
- Startup cost: measure via the existing bootstrap timestamp; keep discovery stat-only, read CSS lazily.
- `executeJavaScript` injection ordering: plugins activating before `init()` completes must tolerate missing DOM state; the runtime queues activation until the loader is ready.
- Topbar drag region vs chip clicks: chips must not swallow window drags (stop propagation only on click, not mousedown).
