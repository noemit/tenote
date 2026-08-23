# Plugin batch audit (examples/ + kernel additions)

Read-only quality review of the 18 example plugins and the kernel surfaces they use (`lib/host.js` emit/on changes, renderer `loader.js` views/chips/events). Follows the format of docs/AUDIT.md. Bugs found were fixed during this audit; judgment calls are listed as-is.

**Date:** 2026-08-22
**Verification after fixes:** `npm run check` green · 15/15 host tests · all 21 plugins activate with zero failures.

---

## Fixed during this audit

### 1. Custom event names were rejected twice — daily-pages was dead on arrival

**Where:** `lib/host.js` (`api.on`, `api.emit`), `renderer/loader.js` (`state.listeners`)

Three separate gates each rejected plugin-defined events:

- `api.emit()` validated names through `slug()` (`[\w.-]`) which bans the colon in `daily:open`
- `api.on()` validated against the fixed `HOOK_EVENTS` list, so no plugin could subscribe to custom names either
- Loader's `state.listeners` was a dict literal with six keys; `events.on('daily:open')` silently no-op'd

Net effect: daily-pages' renderer half never received anything, and any future plugin using its own event namespace would fail invisibly.

**Fix:** one relaxed `EVENT_NAME_RE` (`[\w.:-]`) for on/emit in the host; loader listeners are now a get-or-create map. Regression test added (source plugin emits `daily:open`, sink plugin receives it).

### 2. voice-notes crashed the main process on transcription errors without stderr matching

**Where:** `examples/voice-notes/index.js` `shortErr()`

`(tail || m ? m[1] : '')` parses as `(tail || m) ? m[1] : ''`. With stderr present but no `Command failed\n…` pattern in the error message (spawn ENOENT, timeout, maxBuffer), `m` is null and `m[1]` throws a TypeError inside the execFile callback — an uncaught exception in main. Confirmed by reproduction.

**Fix:** tail-first, then `err.message`. No regex games.

### 3. word-goal double-counted the open note after its first autosave

**Where:** `examples/word-goal/renderer.js`

`total = savedWordsToday + current`: before the first autosave the note isn't on disk (fine); ~350 ms later it is, so its words appear in both terms and the chip jumps to roughly double. 

**Fix:** `note:saved` carries the id; the active note is excluded from the saved-today sum since `current` already covers it. Cached sum invalidates per save as before.

### 4. voice-notes fed the microphone back through the speakers while recording

**Where:** `renderer.js` — ScriptProcessorNode connected straight to `ctx.destination`.

The node must be connected to pump, but direct connection monitors input at full volume (howling feedback on laptops with speakers live).

**Fix:** route through a zero-gain node.

### 5. focus-timer had dead code and settings that required a relaunch

**Where:** `renderer.js`

`toggleBreak()` defined and immediately voided; duration fields had no `onChange`, so edits only applied after restart — inconsistent with every other plugin's live settings.

**Fix:** dead code removed; `onChange` updates the running durations.

### 6. search shipped with a leftover `void corpus;`

Harmless but sloppy. Removed.

---

## Reviewed and left as-is (judgment calls)

| # | Item | Why it stands |
|---|---|---|
| 7 | **templates**: composer keeps showing raw `!meeting` until reopen; disk has the expansion | Renderer autosave always sends composer text, so re-expansion is idempotent — disk state stays correct, UI converges on reopen. Making it live-expand needs a renderer half; noted for later |
| 8 | **daily-pages** marks the streak/day counters even when the dated note is untouched | note-streak counts "days with a saved note"; auto-creating counts. Defensible semantics; changing it means cross-plugin coupling |
| 9 | **search** reads up to 500 full note bodies into memory on first query after any save | Fine for hundreds of notes; the cache key (id+updated) makes repeat queries free. Same scaling wall AUDIT.md #7 flags for listNotes |
| 10 | **typing-speed/task-counter** call `composer.getText()` per keystroke (full DOM serialize) | Negligible below thousands of lines; word-goal already throttles. Revisit if profiles complain |
| 11 | **task-counter/checklists-plus** don't recognize uppercase `[X]` | Both sides consistent today; adding `[Xx]` costs nothing whenever someone cares |
| 12 | **writing-grader heuristics** (syllables via vowel groups, passive = be-verb + `-ed/-en`) | Deliberately crude, documented as such; ±1 grade accuracy is the spec |
| 13 | **age-badges** MutationObserver never disconnects | Plugins don't unload; observer dies with the page. Non-issue until hot-reload exists |
| 14 | **voice-notes** uses deprecated-but-functional ScriptProcessorNode | AudioWorklet is the modern path but needs a separate worklet file served to the sandboxed page — not worth the plumbing for v2 of a niche plugin |
| 15 | **export-image** truncates long notes at ~16 body lines with an ellipsis card | Intended poster behavior; canvas text layout beyond that gets ugly fast |

## What's in good shape

- The emit → broadcast pipe now has test coverage, including plugin-to-plugin custom events
- Every plugin's failure surface is bounded by host isolation (verified: broken plugins fail alone, 21/21 activate)
- Settings schemas render generically and persist atomically; `onChange` used consistently after fix #5
- No plugin writes outside `dataDir()`/namespaced settings; templates' file lookup is charset-bounded inside its own dir
- search escapes interpolated HTML; chip labels are host-rendered so theme variables can't be bypassed

## Priority order if you touch these next

1. Manual GUI pass (chips/hover/canvas/mic can't be exercised headlessly) — still the biggest unknown
2. Live template expansion (needs a small renderer echo channel)
3. Search corpus off the main thread or capped smarter once real note counts exist
