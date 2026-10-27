# Recents strip — UX plan

**Status:** v1 implemented — scroll, pin/snooze, peek, copy as image. Phase 5/6 polish remains.
**Scope:** the horizontal note strip at the bottom of the card (`#recents`), its ordering, scrolling, and a right-click action.

---

## 1. Summary

Three changes, in order of impact:

1. **Opening a note must not reorder the strip.** The current code force-saves unchanged notes on blur and before switching notes, which changes the file mtime and shoves the previous note to the top. Fix the save, don't patch the sort.
2. **Make the strip a horizontal scroller** of up to ~30 notes instead of 3 fixed cards, with the `+N more` card at the end. A partially visible next card is the scroll affordance.
3. **Right-click → Move to bottom.** Implement it as a *snooze*: the note sorts after the normal recents and stays there across launches and opens. Editing its content brings it back to normal recency. Per-device, stored in settings, with an Undo.

Plus three additions from review:

4. **Pin** — the top tier: pinned → normal → snoozed.
5. **Peek** — read-only view of another note without replacing the composer (not a second window; see §13).
6. **Copy as image** — the old `export-image` plugin, built in, with tight padding and the theme's paper pattern.
7. **Hide for screenshot** is deliberately *not* in the note menu; see §13 for why and what to do instead.

The all-notes panel stays as-is (a full, searchable list). The strip is the quick stack.

---

## 2. Today's behavior and the real cause

| Thing | Current behavior |
|---|---|
| Strip | 3 cards, `recentNotes(3)` (`renderer/app.js:259`) |
| Order | file **mtime**, newest first (`main.js:1104`, `NoteStore.swift:239`) |
| Limit | hard-capped at 8 (`Math.min(..., 8)` / `min(..., 8)`) |
| Overflow | `+N more` card opens the all-notes panel (`renderer/app.js:249`) |
| Context menu | none; cards are plain `<button>`s |
| Active note | no highlight; a just-created note is filtered out (`:262`) |

**Why opening appears to reorder it.** It isn't the note you open — it's the note you were in:

- `openNote()` awaits `flushSave()` before swapping (`renderer/app.js:468`).
- `flushSave()` calls `doSave(true, …)` (`:462`).
- `doSave` only skips unchanged text when `force` is false (`:425`): `if (!force && text === state.lastText) return;`.
- So the previous note is rewritten despite having no changes. Its mtime changes, `recentNotes` sorts by mtime, and it jumps to the top.
- The same thing happens on every blur/hide (`:610`). The opened note gets force-saved unchanged too when the card hides.

That force-save is also why notes churn in git, why `updated` frontmatter changes without edits, and part of the audit's data-safety concern. Fixing it is a prerequisite for anything else here.

### Prerequisite fixes

1. **Skip unchanged saves, even when forced.** For an existing note, if `text === state.lastText`, return without writing. Keep the force path only for a new note with text and for the first save after a real change. This removes the false reordering and the mtime churn.
2. **Use one note identity.** Key the strip, snooze set, and `readNote` on the **filename** (without `.md`), not frontmatter `id`. This also fixes the audit bug where a renamed/duplicated note can't be opened or aliases another. Snooze entries must match the id the strip hands back.
3. **One sort source.** Prefer frontmatter `updated` for both the strip and the all-notes panel; fall back to mtime for files without frontmatter. They should not disagree. (If we keep mtime for the strip initially, document it; the index in §10 removes the difference.)

---

## 3. The stack model

The strip is a **recency stack** with a manual override:

- Default order: last **content edit**, newest first.
- **Pinned** notes sort before normal notes. Full order: **pinned (newest first) → normal (newest first) → snoozed (newest first)**.
- Pin is manual and persistent; editing does not unpin. Pin and snooze are mutually exclusive: pinning clears a snooze, moving a pinned note to the bottom unpins it.
- Opening, focusing, or viewing a note **never** changes order.
- Typing in a note moves it to the front **once**, after the debounce save.
- "Move to bottom" marks the note **snoozed**. Snoozed notes sort after all normal notes, newest first among themselves.
- Editing a snoozed note **clears the snooze** and returns it to normal recency. This keeps the list honest: "worked on" beats "parked".
- New notes enter at the front after their first save.
- Deleting a note removes it (and its snooze entry).

Why not a fully manual order?
- A manual order needs drag/drop, insertion rules for new notes, and a story for editing. The user asked for one action (move to bottom), not a reorderable deck.
- Snooze gives the requested control without turning the strip into a second notes manager.

**Pin and move-to-bottom are per-device.** The notes themselves sync via iCloud/Dropbox; the stack order lives in local settings. A note pinned on the Mac is still normal on the iPhone (when that exists). Document this.

---

## 4. The strip

### Layout
- Show up to **30** notes (constant, easy to tune). `total` still drives `+N more`.
- Cards become fixed width (`flex: 0 0 112px`) instead of `flex: 1`; ~3.2 cards visible at the default 480pt card width. The cut-off fourth card is the affordance.
- `#recents` becomes `overflow-x: auto; overflow-y: hidden;` with `scroll-snap-type: x proximity` and `scroll-snap-align: start` on cards (proximity, not mandatory — it shouldn't fight the trackpad).
- Hide the native scrollbar (`scrollbar-width: none`, `::-webkit-scrollbar { display: none }`) or leave the macOS overlay; the partial card and edge fade carry discoverability.
- Optional edge fade (CSS mask) when overflowing; toggled with a class so it doesn't fade a non-scrolling strip.
- The `+N more` card stays at the **end** as "All notes (+N)", opening the panel.
- Preserve `scrollLeft` across re-renders. Skip re-render entirely when the card signature (ids + order + titles) hasn't changed.

### Input
- **Trackpad:** native horizontal scroll.
- **Mouse wheel over the strip:** map `deltaY` to `scrollLeft` when the strip overflows; `preventDefault`. Vertical wheel over a 40px strip should not do nothing.
- **Shift+wheel:** native horizontal scroll.
- **Keyboard:** cards are tabbable; the browser scrolls a focused card into view. Add ArrowLeft/ArrowRight to move focus card-to-card.
- **Optional chevrons** on hover at the edges. Not required for v1; the partial card + wheel is enough.

### Active note
- Give the active card an accent border (`aria-current="true"`) so the strip orients you.
- When a note is opened from the panel or a new note is saved, scroll its card into view (`scrollIntoView({ inline: 'nearest' })`), but do not scroll on every autosave.
- If `hideRecents` is on, keep the existing collapsed count button.

### Performance
- `recentNotes(30)` should read **heads** (2KB), not full files. Both implementations already have `readFileHead`/`readHead`.
- Stat all files, take the top candidates, read heads for title/snippet/updated.
- Avoid re-reading on every keystroke: debounce refreshes, skip identical results, and (follow-up) keep a small in-memory index (see §10).

---

## 5. Right-click menu

Trigger: right-click, Ctrl+click, **Shift+F10** on a focused card, or a small **`…`** button that appears on hover/focus (accessibility and discoverability; right-click alone is not keyboard-accessible).

Items (v1):

| Item | Action |
|---|---|
| Open | Same as click |
| Peek | Read-only rendered note in the existing `#pview` overlay; Edit loads it into the composer |
| Pin / Unpin | Pinned notes sort first; persists across launches |
| Move to bottom | Snooze; label becomes **Move back to recents** if already snoozed |
| Copy as image | Built-in exporter, §13 |
| Reveal in Finder | Show the `.md` file in the chosen notes folder (native: `NSWorkspace`; Electron: `shell.showItemInFolder`) |

No Delete in v1 — deletion is already "clear the note", and a destructive menu item next to a friendly stack is a footgun. Add it later behind a confirmation if wanted.

Menu behavior:
- DOM popover styled with theme variables (same surface/border/pop tokens as the settings popovers). Native `NSMenu` is a later polish, not v1.
- Clamp to the card bounds; flip horizontally/vertically near the window edge.
- Focus the first item; ArrowUp/Down moves; Enter activates; Esc closes and returns focus to the card.
- Close on click outside, scroll, window blur/hide, and Esc.
- `role="menu"` / `role="menuitem"`; the `…` button has an `aria-label` ("Note actions").

### Feedback and undo
- After moving: status/toast **"Moved to bottom — Undo"** for ~6s. Undo clears the snooze and restores the card. If the toast is awkward in the current status span, a small inline action button is worth adding.
- If the moved note is the active one, it stays open; only its card moves (possibly out of the visible strip).
- If the card leaves the 30-note window, the toast is the only easy undo; the all-notes panel still has the note.

### Semantics to spell out
- "Move to bottom" means the bottom of the **current stack**, not the bottom of all notes. With 30 slots and hundreds of notes, a snoozed note may fall out of the strip. The toast + panel cover recovery.
- Editing the note clears the snooze. The toast or menu label can hint: "Returns when you edit it."

---

## 6. Persistence and bridge surface

Add a small, additive settings section:

```json
"recents": {
  "pinned": ["2026-10-20_09-14-02"],
  "snoozed": ["2026-10-26_23-12-05"]
}
```

Per-device, in the app's existing settings file/sandbox container. No schema migration needed; unknown-less parsing should default to `[]`.

### Native

- `Settings`: `recentsSnoozed: Set<String>`, parsed from `recents.snoozed`, written back.
- `NoteStore.recent(limit, snoozed:)`: sort `snoozed` last, then by updated/mtime; return `snoozed: Bool` per note.
- `AppController`:
  - pass `settings.recentsSnoozed` into `recent`;
  - on a successful non-deleted save, remove the id from the set (editing un-snoozes);
  - on delete, remove it;
  - prune ids not present on load (cheap, optional).
- Bridge: `note:snooze` `{ id, snoozed }` in `handleBridge`; `native-bridge.js` exposes `setNoteSnoozed(id, bool)`.
- `renderer` feature-detects: `typeof jot.setNoteSnoozed === 'function'`; hide the move item if absent.

### Electron (frozen, but the renderer is shared)

- `defaultSettings()` adds `recents: { snoozed: [] }`.
- `recentNotes` applies the same sort and returns `snoozed`.
- `ipcMain.handle('note:snooze', …)` updates settings and saves.
- `preload.js` adds `setNoteSnoozed`.
- If this is too much for the frozen build, feature detection hides the item and the scroll still works. Native is the priority.

### Alternatives considered

| Option | Why not |
|---|---|
| Frontmatter `stack:` field | Modifies user files; sync conflicts; the app would have to preserve a new key in every serializer |
| Hidden dotfile in the notes folder | Syncs and conflicts across devices; invisible to users; another file to explain |
| Full manual order array | Needs drag/drop, insertion rules, and a policy for edits; more UI than asked for |
| Native `NSMenu` now | Better macOS feel, but a new bridge method; DOM menu reuses the existing popover styling and works in both builds. Follow-up |

---

## 7. Edge cases

- **0 notes:** strip hidden (today's behavior).
- **1–3 notes:** no overflow, cards still fixed width; no `+N more`.
- **>30 notes:** `+N more` at the end; snoozed notes may fall outside the window.
- **Active note is snoozed:** keep it open; card is at the end with a muted style; `aria-current` still applies.
- **Delete the active note:** card disappears; keep scrollLeft clamped; composer resets.
- **Move the last remaining note:** it stays (bottom of one).
- **Rename externally:** id changes; old snooze entry is stale; prune.
- **`hideRecents` on:** no strip; the context menu isn't reachable; the all-notes panel remains.
- **Window hidden:** close any open menu; preserve scrollLeft.
- **iCloud-evicted file:** head read may stall; keep reads async and don't block the strip.
- **New note:** not in the strip until first save; after save it enters at the front.

---

## 8. Accessibility

- Cards: `role="listitem"` in a `role="list"` strip (or a group with an `aria-label="Recent notes"`); each card a button or `role="button"` with Enter/Space.
- `aria-current="true"` on the active card.
- The `…` button: `aria-haspopup="menu"`, `aria-expanded`, `aria-label="Actions for <title>"`.
- Context menu: `role="menu"`, items `role="menuitem"`, focus trap within the menu, Esc restores focus to the card.
- Shift+F10 / Menu key opens the same menu.
- Horizontal scroll via keyboard: ArrowLeft/Right moves focus; the browser scrolls the focused card into view.
- Announce moves with a polite live region ("Moved <title> to the bottom").
- Respect reduced motion (no snap animation if `prefers-reduced-motion`).

---

## 9. Implementation phases

| Phase | Work | Risk |
|---|---|---|
| **0. Save + id** | Skip unchanged saves; filename-derived ids; align sort on `updated` | Low; high impact; fixes an audit bug |
| **1. Scroller** | Fixed card widths, 30-note limit, head reads, wheel mapping, scroll preservation, active highlight | Low–medium; CSS + `recentNotes` |
| **2. Menu + snooze** | DOM context menu, `…` button, settings persistence, bridge methods, clear-on-edit, undo toast | Medium; new bridge surface in two apps |
| **3. Polish** | Edge fades, chevrons, keyboard arrows, live region, reduced motion | Low |
| **4. Scale** | In-memory recents index shared with the panel; rescan on show/panel open; FSEvents later | Medium; only if note counts grow |

Phase 0 alone fixes the complaint. Phases 1–2 deliver the requested strip.

---

## 10. Acceptance tests

- Open a note and click away: strip order is unchanged; the file's mtime/`updated` are unchanged.
- Type one character: the note moves to the front once; further autosaves don't reorder it again.
- 40 notes: scroll with trackpad, wheel, and keyboard; the next card is partially visible; scroll position survives a save.
- Move to bottom: card goes to the end; survives relaunch and reopening; returns to normal after editing; Undo works.
- Delete a snoozed note: no stale card or menu entry.
- `hideRecents` on/off; 0, 1, 3, 30, 31 notes.
- Right-click, Ctrl+click, Shift+F10, and the `…` button all open the same menu; Esc returns focus.
- Both native and Electron renderers (or the menu item hides in Electron until the IPC is added).

---

## 11. Decisions I'd make (flag if you disagree)

1. **Editing a snoozed note brings it back** to normal recency. (Alternative: snooze is permanent until manually undone.)
2. **30 notes** in the strip, not all. The all-notes panel is the full library.
3. **Reveal in Finder** yes; **Delete** no, for now.
4. **Per-device** snooze, not synced.
5. **DOM context menu** for v1; native `NSMenu` later.
6. **No drag-and-drop reorder** in v1. Pin and snooze are the manual controls.
7. **Pin** is in; it is the top tier and replaces the need for "Move to top".
8. **Peek** is in; a second *window* is deferred (see §13).
9. **Copy as image** is in, clipboard-only; don't write share images into the notes folder.
10. **Hide** stays out of the note menu.

## 12. Non-goals

- Reordering the all-notes panel.
- Syncing stack order across devices.
- Pinned notes / multiple stacks.
- A second sort mode (title, created).

---

## 13. Menu additions from review

### 13.1 Pin

Pin is the **top tier**, and it replaces the need for a "Move to top" action.

- Order: **pinned (newest first) → normal (newest first) → snoozed (newest first)**.
- Pin is manual and persistent. Opening or editing does not unpin.
- Pin and snooze are mutually exclusive: pinning a snoozed note un-snoozes it; moving a pinned note to the bottom unpins it.
- Pinned notes **bypass the 30-note window**; they are always in the strip.
- Card gets a small pin glyph; `aria-label="Pinned"`. The all-notes panel gets the same badge.
- Panel sorting by pin is a separate decision. Recommendation for v1: badge only, keep the panel chronological; a "Pinned" section can come later.
- Persistence: `recents.pinned` in settings, per-device, same trade-off as snooze.

### 13.2 Peek (the "new view")

A true second **window** is a large change: the app is built around one `CardWindow`/`AppController`, with app-wide note state, one hotkey, one tray, one panel, and one blur/hide policy. Per-window state, hotkey routing, and window lifecycle are a project, not a menu item.

Recommendation: ship **Peek** first.

- Peek renders the selected note read-only in the existing `#pview` takeover (`renderer/loader.js:512`, `renderer/index.html:109`) — the composer's current note stays in the DOM and returns when you close.
- Header: title + Close; body: rendered Markdown; an **Edit** button loads the note into the composer (flushes the current note first).
- Context menu item: **Peek**. This gives the useful half of "new view" (reference another note without losing what you were writing) at a fraction of the cost.
- A second editable window can be a later project. It should be scoped separately with its own UX: which window does ⌥. toggle, does each window have a strip/panel, how does blur-hide work with two cards, what happens to the socket.

If "new view" meant side-by-side **editing**, say so and this becomes a separate plan.

### 13.3 Copy as image (built-in export)

Bring `examples/export-image` in as a core feature, not a plugin.

What the old plugin does:
- 1600×1000 canvas with a 900px card: **350px of empty margin on each side** — that is the "too much padding".
- 64px inner padding, 70px shadow blur.
- Strips images/links/bold/backticks, caps at 40 laid-out lines (~16 drawn), no tags.
- Saves the PNG into `notes/images/` via `attachImage`, where the daily image sweep later deletes it (no note references it). Clipboard copy is the useful half.

New version:
- **Hugs the card**: ~720px content width + 24–32px margin (not 350), 2× retina, auto height with min/max, ~24-line cap with an ellipsis.
- **Theme-aware**: `--bg`, `--surface`, `--text`, `--muted`, `--accent`, plus the paper pattern. Add `--paper-style: dots | lines | grid | none` to theme CSS so the canvas can draw the same surface as the app.
- **Content**: title, body, tags (as chips), optional small wordmark; no app chrome, no topbar.
- **Actions**: `⌘⇧E` for the open note (the old shortcut); **Copy as image** in the note context menu for any note (read its Markdown, render, copy). Clipboard only.
- **Do not save into `notes/images`.** If "Save image…" is wanted, use a save panel (`NSSavePanel` / Electron `dialog.showSaveDialog`) and default to `~/Pictures`; never let the sweep treat share images as orphans.
- Works in MAS: built-in code, `copyPng` already exists in both hosts (`main.js:912`, `AppController.swift:526`), no plugin install, no new entitlement.

### 13.4 Hide (for screenshots)

I would **not** put this in the note context menu. It mixes a note action with a view state and is easy to get stuck in.

Two different needs:

1. **A beautiful image of a note** → use **Copy as image** (§13.3). This is the better path and removes the padding complaint.
2. **A clean screenshot of the app** (e.g. App Store screenshots) → a *view* action, not a note action. The existing **Hide recent notes bottom bar** setting already removes the strip; a "Clean shot" mode could later hide the topbar/footer too, with Esc to exit and the UI restored on next show. I'd add that only if you actually want app screenshots, and keep it out of the note menu.
3. **Hide a note from the strip for privacy while screen-sharing** → that is a separate `hidden` state (removed from the strip, still in the all-notes panel with a "Hidden" badge), not the same as snooze. Tell me if this is the intent and I'll design it; otherwise skip.

### 13.5 Revised menu

```
Open
Peek
Pin / Unpin
Move to bottom / Move back to recents
──────────
Copy as image
Reveal in Finder
```

Six items, grouped. No Hide, no Delete.

### 13.6 Revised phases

| Phase | Work |
|---|---|
| 0 | Unchanged saves; filename ids; one sort source |
| 1 | Scroller (30 notes, wheel/keyboard, scroll preservation, active card) |
| 2 | Menu + **pin** + snooze persistence + Undo |
| 3 | **Copy as image** (built-in exporter, tight padding, paper pattern) |
| 4 | **Peek** overlay (read-only, Edit button) |
| 5 | Polish: `…` button, keyboard, edge fades, reduced motion |
| 6 | Scale: recents index shared with the panel |
