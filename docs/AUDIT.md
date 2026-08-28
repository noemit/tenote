# Tenote code audit

**Date:** 2026-08-28 (supersedes the 2026-08-09 audit)
**Scope:** `main.js`, `preload.js`, `logger.js`, `lib/host.js`, `renderer/*`, `scripts/*`, `plugins/*`, `package.json`.

**Overall:** Small, readable Electron app with solid baseline security (`contextIsolation`, `sandbox`, no `nodeIntegration`, CSP, privileged-scheme path checks, `safeId`). Plugin host isolates failures (3-strikes suspension, per-owner teardown). Notes and settings write atomically (tmp + rename). 19 node:test suites cover the plugin host.

---

## Fixed in 1.3.1 (UX correctness cluster)

- **Topbar double-click zoom/fullscreen/crash** — Chromium's drag-region double-click zooms on macOS even with `maximizable: false`; the now-screen-sized transparent window swallowed clicks and could take down the renderer. Main process now force-reverts `maximize` / `enter-full-screen`.
- **Resize never ended if mouse was released off-window** — `mouseup` on `window` doesn't fire outside the BrowserWindow, leaving the 16 ms resize interval running forever (window followed the cursor; everything downstream felt slow; quit seemed dead). Resize now uses pointer capture (`pointerup`/`pointercancel` delivered off-window), with `mouseup`/`blur` as fallback.
- **Slow/janky settings popover growth** — `ensureMenuSize` used animated `setBounds`, which is janky on transparent windows. Now instant.
- **Plugin chips cut off** — replaced scroll arrows with fit-what-fits + a `+N` overflow dropdown (proxy buttons forward clicks/hover to the real chips). Strip width is a fixed 46% so overflow measurement can't oscillate.

## Fixed in 1.3.2 (audit P0/P1)

- **Plugin install moved the user's picked folder** — `placePlugin` renamed the source into the plugins dir. Now always copies; bare `.js` installs wrap into `<name>/index.js` so the directory scanner actually discovers them.
- **Popover size-restore lost across window hide** — `menuGrowFrom` was nulled on hide while the renderer kept the popover open. It now survives hide; restore happens on next show.
- **No note size cap** — notes now cap at 4 MB, enforced in renderer and main, with a clear status message.
- **`listNotes` read every note fully** — now reads only the first 2 KB (frontmatter + title + 140-char snippet never need more).
- **Log rotation only at startup** — runtime rotation via in-process byte tracking; rotates at 5 MB, keeps one `.1` backup.
- **Orphaned pasted images accumulated forever** — daily startup sweep deletes Tenote-named images (`img-<base36>-<rand>.<ext>`) that no note references. User files in `images/` are never touched.
- **Disabling the plugin owning the active theme dangled** — renderer now falls back to a live theme (latte, else first available) and persists it.

## Fixed in 1.3.3 (audit P2)

- **`tenotectl` shell-string launch** — `exec('open "' + appPath + '"')` → `execFile('open', [appPath])`.
- **Theme CSS cache never invalidated** — cached with file mtime; editing a theme on disk applies on next theme switch, no restart.
- **Shortcut bookkeeping was single-slot** — `pluginShortcuts` is now owner→Set (disable unregisters all of a plugin's shortcuts), and the tray label is reserved for `core-shortcuts` so later registrations can't clobber it.
- **Name-collision theme leak** — a plugin skipped for a name collision no longer registers its themes globally.
- **Dead code** — removed the unused `shortcuts` array and the unexported-anyway `HOOK_EVENTS` export (kept as an in-code documentation list).

## Fixed in 1.3.4 (event-loop blocking + self-audit hardening)

- **Sync note I/O froze the whole app on iCloud-evicted files** — with Desktop & Documents iCloud sync, `readFileSync` on a cloud-only note blocks until it downloads, and because it ran on the main event loop, *every* IPC queued behind it: gear dead, chips dead, plugin toggles appeared to snap back, opening the notes list took a minute. `listNotes` / `readNote` / `recentNotes` / the image sweep now use `fs.promises` (downloads stall a worker thread, never the loop), and `wrapIpc` handles async handlers.
- **Image sweep ran synchronously at startup** — now delayed 30 s past bootstrap and fully async.
- **Plugin toggle could look reverted while its IPC was in flight** — the checkbox is disabled until the call returns.
- **Image sweep vs sync-folder lag** — files younger than 7 days are never swept (a note referencing them may not have synced yet).
- **Empty chips strip claimed 46% of the topbar** — strip visibility now follows *visible* chips, so a plugin that hides all its chips leaves no empty strip.
- **`TENOTE_NO_PLUGINS=1`** starts with all plugins listed-but-inactive (bisect escape hatch; they can still be enabled live one at a time).

## Known limitations (accepted, watch items)

- **`document.execCommand('bold'/'italic'/'insertText')`** is deprecated API. It works in current Chromium and the serializer handles both `<b>`/`<strong>` and `<i>`/`<em>`, but a future Electron may remove it — the fix then is a Selection/Range-based formatter.
- **`listNotes` still scans every note file** (2 KB heads now) and the panel refreshes after each save. Fine into the low thousands of notes; beyond that, add an mtime-indexed cache.
- **Renderer plugin code is fully trusted** (user-installed local JS injected via `executeJavaScript`). That's the intended threat model — plugins can do anything the app can.
- **Markdown preview is a small hand-rolled escape-first parser**, not a full Markdown implementation. Multiline YAML frontmatter in hand-edited notes parses loosely.
- **Plugin timers survive live-disable** until relaunch (documented best-effort teardown).
- **macOS-only in practice** (`ditto` for zip installs, login items, tray template images).

## Fixed earlier (2026-08-09 audit items)

- `flushSave` before `openNote` (data loss on quick note switching)
- First-run flag wiring (`isFirstSession` one-shot)
- Atomic writes for notes and settings
- `TENOTE_SOCKET` honored in main process
- Tray menu rebuilds when settings change from the UI
- Automated tests now exist (`npm test`, 19 suites)
- Releases are signed + notarized (see `docs/SIGNING.md`)

## Priority if more issues appear

1. Data-loss/crash class first (writes, saves, window state)
2. Renderer freezes / stuck loops (intervals, observers)
3. Scaling costs (listNotes, panel refresh, images)
4. API deprecations (`execCommand`) when Electron removes them
