# Writing Tenote plugins

A Tenote plugin is a folder (or single `.js` file) dropped into
`~/Library/Application Support/Tenote/plugins/`. No build step, no manifest
required for JS-only plugins, no dependencies.

**Trust model, stated plainly:** a plugin is code running with your user's full
privileges — Node and Electron in the main process, the page in the note card.
There is no sandbox and no permission prompt. Installing a plugin means running
that author's code on your machine. Read it or trust it.

## Install

**The easy way:** ⚙ → Plugins → **Install from file…** — pick the plugin you
downloaded (a `.zip`, a `.js`, or a folder, e.g. straight from your Downloads
folder). Tenote unpacks it, puts it in the right place, and asks for a restart.

Also in that section: **Open plugins folder** if you prefer moving files
yourself. Either way, restart Tenote and the plugin appears in ⚙ → Plugins with
an enable/disable toggle; changes apply at relaunch.

For development you can skip installing: launch with
`TENOTE_PLUGINS=/path/to/plugin:/path/to/other` (colon-separated).

## Layout

```
my-plugin/
  plugin.json    optional manifest
  index.js       main-process part (optional)
  renderer.js    card-UI part (optional)
```

```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "description": "…",
  "main": "index.js",
  "renderer": "renderer.js",
  "themes": [{ "id": "forest", "name": "Forest", "css": "forest.css", "swatch": ["#1c241c", "#39473a"] }]
}
```

A folder with only `plugin.json` + theme CSS files is a valid zero-JS theme pack.
Plugin identity = `manifest.name`, else the folder/file name. Name collisions:
the built-in layer wins, later layers are skipped with a warning.

## Main-process part

```js
'use strict';
module.exports = function myPlugin(tenote) {
  tenote.on('note:saved', ({ id }) => tenote.log.info('saved', id));
};
```

| API | What it does |
| --- | --- |
| `tenote.on(event, fn)` | `ready`, `window:shown`, `window:hidden`, `note:before-save`, `note:saved`, `note:opened`, `app:before-quit`. A hook that throws 3 times is suspended (logged). |
| `tenote.registerCommand(name, fn)` | New `tenotectl <name>` / socket command. Return a string or object (JSON reply). |
| `tenote.registerService({ method(args) })` | Callable from the renderer: `tenote.invokePlugin('<plugin>', '<method>', args)`. |
| `tenote.registerTrayItem({ label, click })` | Item under the tray menu's Plugins section. |
| `tenote.registerGlobalShortcut(acc, fn)` | Global hotkey; returns false if the OS refused it. |
| `tenote.settings.get(key, fallback)` / `.set(key, value)` | Namespaced under `plugins.values.<plugin>` in settings.json, written atomically. |
| `tenote.notes.list/read/save/recent` | Note storage through the kernel's safe wrappers. |
| `tenote.window.toggle/show/hide()`, `tenote.app.quit()` | Window control. |
| `tenote.dataDir()` | Private writable folder `userData/plugin-data/<plugin>/`. |
| `tenote.log` | Prefixed logger. |

`note:before-save` is a pipeline: handlers run in activation order; return
`{ id, text, tags }` to replace the payload, return nothing to pass it through.
That one hook covers auto-tagging, templates, scrubbing.

## Renderer part (`renderer.js`)

Authored exactly like the main part — `module.exports = function (tenote) {}` —
but it runs inside the note card's page:

| API | What it does |
| --- | --- |
| `tenote.ui.chips.add({ icon?, label?, variant?, onClick?, tooltip? \| onHover? })` | Chip in the topbar strip. Returns `{ update(label, variant?), show(), hide(), remove() }`. Variants: `default`, `accent` — colors come from the active theme, plugins cannot style chips directly. Hover popover drops below the chip and never steals focus. |
| `tenote.ui.markdown.addRule({ name, toHtml, beforeSerialize })` | Extend rendering. `toHtml(html)` runs after escaping + core rules; `beforeSerialize(root)` mutates the DOM before core serialization. Both are required — a rule that renders but can't serialize back would lose data on save. |
| `tenote.ui.styles.add(css)` | Stylesheet via constructed stylesheets (theme-variable friendly, CSP-safe). |
| `tenote.ui.keys.add({ combo, handler })` | Combo like `'mod+k'`; handler returns truthy to consume the key. |
| `tenote.ui.settings.declare(fields)` | Schema-rendered modal in ⚙ → Plugins → ⚙. Field types: `toggle`, `text`, `number`, `select`; optional per-field `onChange(value)`. |
| `tenote.events.on(name, fn)` | `composer:input` (throttled ~250 ms), `note:saved`, `note:opened`, `window:shown`, `window:hidden`, `theme:changed`. |
| `tenote.composer.insertText(str)` / `.isEmpty()` | Insert at caret / empty check. |
| `tenote.notes.*`, `tenote.settings.get/set` | Same as main side; renderer `settings.get` reads a cache primed before activation. |

### Markdown rule example (round-trip checklist)

```js
tenote.ui.markdown.addRule({
  name: 'checklists',
  toHtml(html) {
    html = html.replace(/<li>\[x\]\s*/g, '<li class="tk done"><button class="tk-b" data-c="1"></button>');
    html = html.replace(/<li>\[ \]\s*/g, '<li class="tk"><button class="tk-b" data-c="0"></button>');
    return html;
  },
  beforeSerialize(root) {
    root.querySelectorAll('li.tk').forEach((li) => {
      const box = li.querySelector('.tk-b');
      const checked = !!box && box.dataset.c === '1';
      if (box) box.remove();
      const text = li.textContent.replace(/^\[[ x]\]\s*/, '');
      li.textContent = (checked ? '[x] ' : '[ ] ') + text;
      li.classList.remove('tk', 'done');
    });
  },
});
```

## Themes

Each theme is one CSS block defining the full variable set — copy
`plugins/builtin/core-themes/midnight.css` as a template — plus a manifest entry
with two swatch colors. Theme ids join the same registry as the built-ins;
`settings.json → theme` stores whichever id is active.

## Failure isolation

Activation errors mark the plugin `failed` and boot continues. Hook/command
throws are contained per call; three failures suspend a subscription. Current
states are visible via `tenotectl status`.

## Examples

See `examples/` in the repo. Install any of them via ⚙ → Plugins → Install from file… (or point `TENOTE_PLUGINS` at the folder while developing):

| Plugin | What it does |
| --- | --- |
| `ping` | Socket command + service demo (`tenotectl ping`) |
| `word-count` | Live word-count chip, format cycling, settings schema |
| `checklists-plus` | `- [ ]` checkboxes that round-trip to Markdown |
| `theme-pack-1` | Zero-JS themes (Forest, Terminal) |
| `typing-speed` | Live WPM chip for the last minute of typing |
| `note-streak` | 🔥 chip counting consecutive days with a saved note |
| `task-counter` | `2/5 ✓` progress chip for task lines |
| `word-goal` | Daily word goal chip, accent when you hit it |
| `focus-timer` | Pomodoro chip (⌘⇧F) |
| `word-of-the-day` | Daily vocabulary chip; hover = definition, click = insert |
| `prompt-of-the-day` | Daily writing prompt chip; click inserts it |
| `writing-grader` | Readability grade chip + worst-offense tip on hover |
| `search` | ⌘F full-text search across notes (plugin views API) |
| `daily-pages` | `tenotectl today` opens/creates today's dated note (+ tray item) |
| `templates` | First line `!meeting` expands from a template on save |
| `age-badges` | Dims notes older than N days in recents/all-notes |
| `export-image` | ⌘⇧E renders the note as a shareable image → clipboard + images/ |
| `voice-notes` | Dictation via a local transcription command (e.g. Parakeet); chip shows ready/recording/transcribing |

For `voice-notes`, configure a command that reads a wav file and prints text,
with `{wav}` as the placeholder — e.g.
`parakeet-run {wav}` or any local ONNX/whisper wrapper you have.

## Not yet (by design)

Pluggable storage, sandboxing/permissions, a package manager, hot reload of
main-process plugins, drag-to-reorder chips. See docs/PLUGIN_PLAN.md for the
reasoning.
