# Tenote code audit

Read-only review of the app sources (`main.js`, `preload.js`, `logger.js`, `renderer/*`, `scripts/*`, `package.json`). No files were changed as part of the audit. Syntax check (`npm run check`) passes.

**Date:** 2026-08-09  
**Overall:** Small, readable Electron app with solid baseline security (`contextIsolation`, `sandbox`, no `nodeIntegration`, CSP, privileged `timg` path checks, `safeId`). Most issues are real edge cases: a couple of user-facing data/UX bugs, a few reliability gaps as notes grow, and some incomplete wiring.

---

## Critical / high — can lose data or break intended behavior

### 1. Unsaved text can be lost when opening another note

**Where:** `renderer/app.js` — `openNote()` vs callers of `newNote()` / hide

`flushSave()` is used for New, Close, Esc, panel open, and window hide. It is **not** called before `openNote()` (recents strip or all-notes list).

If the user types and within the 350 ms debounce clicks a recent note, that text is never written.

**Suggestion:** Call `flushSave()` (or await the save chain) at the start of `openNote()`.

---

### 2. First-run UI never actually runs

**Where:** `main.js` ~110–115 vs `state:get` ~367 vs `renderer/app.js` ~416–418

Bootstrap does:

```js
settings.firstRunDone = true;
saveSettings();
// then later show window
```

`state:get` returns `firstRun: !settings.firstRunDone`, so by the time the renderer calls `getState()`, `firstRun` is always `false`. The 9 s hint on first launch is dead code.

**Suggestion:** Keep a one-shot flag separate from persistence (e.g. in-memory `isFirstSession`), or set `firstRunDone` only after the first show / after the renderer has read it.

---

### 3. Non-atomic note writes

**Where:** `main.js` `saveNote` → `fs.writeFileSync(file, ...)`

A crash, kill, or full disk mid-write can leave a truncated/corrupt `.md` file (including frontmatter). Same pattern for settings and images.

**Suggestion:** Write to `file + '.tmp'` then `fs.renameSync` (atomic on same volume).

---

## Medium — reliability, consistency, scaling

### 4. `TENOTE_SOCKET` is documented but ignored by the app

**Where:** README env table; `scripts/tenotectl.js` reads it; **`main.js` does not**

Socket path is hardcoded:

```js
path.join(os.tmpdir(), `tenote-${uid}.sock`)
```

If someone sets `TENOTE_SOCKET`, skhd/tenotectl and the app talk to different sockets → “hotkey does nothing.”

**Suggestion:** Use `process.env.TENOTE_SOCKET || default` in `main.js` as well.

---

### 5. Tray menu desyncs when settings change from the UI

**Where:** `settings:setHideOnBlur` vs `settings:setLaunchAtLogin`

`setLaunchAtLogin` calls `rebuildTrayMenu()`; `setHideOnBlur` does not. The tray “Hide when focus lost” checkbox can disagree with the in-app toggle until restart.

**Suggestion:** Call `rebuildTrayMenu()` from every setting that appears in the tray.

---

### 6. Log rotation only runs at process start

**Where:** `logger.js`

`rotateIfNeeded()` runs only from `init()`. Once the write stream is open, a long-lived session never rotates; `main.log` can grow without bound. After rename on next start, only one backup (`.1`) is kept.

**Suggestion:** Check size periodically (or before each write / every N lines), close stream, rotate, reopen.

---

### 7. `listNotes` / history scale poorly

**Where:** `main.js` `listNotes`, `recentNotes`

Every list reads **every** `.md` file fully. History open + frequent `refreshPanel` after saves re-reads everything. Fine for dozens of notes; painful for thousands (sync folders, heavy users).

**Suggestion:** Cache metadata, or sort/list with mtime + lazy body for title/snippet; debounce panel refresh.

---

### 8. No note size limit

**Where:** `saveNote`

Images are capped at 15 MB; note body is not. Huge pastes go over IPC and to disk without guard.

**Suggestion:** Cap text length (e.g. a few MB) and return a clear error.

---

### 9. Pasted images are never garbage-collected

**Where:** `attachImage` + empty-note delete

Images land in `images/` with random names. Deleting a note (or emptying it) does not remove referenced images. `noteId` is sent from the renderer but unused.

**Suggestion:** Track refs, or periodic orphan cleanup; or namespace images by note id.

---

### 10. `tenotectl` launch path is shell-string based

**Where:** `scripts/tenotectl.js`

```js
exec(`open "${appPath}"`)
```

A malicious or malformed `TENOTE_APP_PATH` with quotes can break out of the string (same-user / env injection). Uncommon, but easy to harden with `spawn('open', [appPath], { shell: false })`.

---

### 11. Save chain errors can stall later saves

**Where:** `renderer/app.js` `saveChain`

```js
saveChain = saveChain.then(async () => { ... });
```

If a handler threw outside the inner `try/catch` (or a future change does), the chain rejects and later `.then` callbacks never run → silent stop of autosave.

**Suggestion:** Always `.catch` on the chain and reset, e.g.  
`saveChain = saveChain.then(...).catch(...)`.

---

## Lower / security & polish

### 12. Markdown preview: solid XSS stance, small residual risks

**Where:** `mdToHtml`

Escape-first is the right approach; only `http(s)` links/images. Residual notes:

- CSP allows `img-src https:` → remote images load in preview (tracking/beacon risk if the user pastes a remote image URL).
- Link clicks rely on `will-navigate` / `setWindowOpenHandler`; keep those handlers if you ever loosen CSP or markdown rules.

---

### 13. `timg` path checks are good; symlinks are not blocked

**Where:** `setupImageProtocol`

Prefix + `path.resolve` under `NOTES_DIR` is correct for `../` style escapes. A symlink under `images/` to elsewhere would still be followed by `readFileSync` (same-user local threat model; low for this app).

---

### 14. Unix socket: brief permission race

**Where:** `startSocketServer`

Socket is created, then `chmod 0o600`. On a shared machine there is a short window with default umask permissions. Commands are only show/hide/quit/status (no note R/W). Prefer setting umask before `listen`, or use a private dir.

---

### 15. Settings file is trust-on-read

**Where:** `loadSettings`

`Object.assign(defaultSettings(), raw)` with no schema validation. A hand-edited `settings.json` can put non-booleans into flags (`"hideOnBlur": "false"` is truthy in JS if ever used raw). Coercion on read would be safer.

---

### 16. Frontmatter is minimal, not a full YAML parser

**Where:** `parseNote` / `serializeNote`

Fine for app-owned files. Hand-edited notes with multiline values, nested structures, or odd characters may parse oddly. Tags are sanitized on write.

---

### 17. IPC surface is appropriately small; log channel is unbounded

**Where:** `preload.js` / `ipcMain.on('log')`

No arbitrary FS API from the renderer — good. Renderer can still spam the log channel with huge messages (sliced only on `console-message`, not on the `log` IPC).

---

### 18. Packaging / product notes (not runtime bugs)

| Item | Note |
|------|------|
| Unsigned app (`identity: null`) | Expected; Gatekeeper friction as README says |
| `scripts/**` in build `files` | Ships setup/tenotectl inside the app bundle; setup is really a source/dev flow |
| `docs/screenshot.png` ~3 MB | Fine for GitHub; large for clones |
| No automated tests | High regression risk as features grow |
| macOS-only in practice | Linux paths exist in logger; product is Mac |

---

## What’s in good shape

- **Process isolation:** sandbox + contextIsolation + no node in renderer
- **Single instance** + toggle coalesce for skhd double-fire
- **`safeId`** blocks path separators for note ids
- **Empty note → delete** is intentional and documented
- **`gen` + save chain** largely avoid applying stale save results after `newNote`
- **External links** don’t load inside the frameless window
- **skhd setup** is idempotent (won’t duplicate bindings)
- **prestart** self-heals wrong-arch Electron binaries
- Clear logging to a user-visible log dir

---

## Priority order if you fix things later

1. **`flushSave` before `openNote`** — real data loss
2. **Atomic writes** for notes (and ideally settings)
3. **`firstRun` flag wiring** — broken onboarding
4. **`TENOTE_SOCKET` in main** — matches docs / ops
5. **Tray rebuild on hide-on-blur** — small but confusing
6. **Log rotation during runtime**
7. **Note size limit + listNotes performance** as usage grows
8. **Image orphan cleanup**
