# Mac App Store plan

**Status:** Phase 1 in progress
**Goal:** ship a sandboxed **Tenote** on the Mac App Store (`com.tenote.native.mas`) without weakening the direct/notarized build (`com.tenote.native`).

Two editions, one codebase:

| | Direct (current) | Mac App Store |
|---|---|---|
| Bundle id | `com.tenote.native` | `com.tenote.native.mas` |
| Sandbox | no | **yes (required)** |
| Notes folder | fixed `~/Documents/Tenote Notes` | user-selected once + security-scoped bookmark |
| Plugins | built-in + user-installed | **built-in only** |
| `tenotectl` / skhd | yes | no (socket disabled) |
| Logs | `~/Library/Logs/Tenote` | container `Library/Logs/Tenote` |
| Signing | Developer ID + notarization | Apple Distribution + MAS provisioning profile |
| Updates | manual / future Sparkle | App Store |

The store build must never silently change where an existing user's notes live. If the bookmark is missing, the app asks once and defaults the panel to `~/Documents`; `~/Documents/Tenote Notes` is one click away.

---

## Why this is not a switch

1. **Sandbox access.** `.documentDirectory` resolves to the container, so the current hard-coded notes path would vanish. Markdown itself is fine; the *folder access* is the blocker.
2. **Plugins are executable code.** App Review 2.5.2 is a real rejection risk for "Install from file…" + JS with `fs`/`child_process`. The store build ships built-ins only.
3. **Container paths.** Settings/plugins/logs/socket all move under `~/Library/Containers/com.tenote.native.mas/Data`.
4. **Signing/packaging.** MAS needs an Apple Distribution cert, a Mac App Store provisioning profile, an embedded profile, a `.pkg`, and Transporter upload.

---

## Phase 0 — Apple portal (manual, ~1 hour)

- [ ] Accept the current Apple Developer Program License Agreement.
- [ ] Create App ID **`com.tenote.native.mas`** (Mac App Store).
- [ ] Create a **Mac App Store** provisioning profile for it; download.
- [ ] Create an **Apple Distribution** certificate (or "3rd Party Mac Developer Application") and a **Mac Installer Distribution** certificate (or "3rd Party Mac Developer Installer").
- [ ] Create the app record in App Store Connect: name **Tenote**, primary language, SKU, bundle id above, category Productivity, price free.
- [ ] Add a privacy policy URL and a support URL (GitHub Pages is enough).
- [ ] Reserve the name **Tenote** by creating the record (names are only locked at this point).

## Phase 1 — Sandbox + notes bookmark (the long pole)

- [x] `TenotePaths` accepts a notes-dir override; MAS log dir moves to the container.
- [x] `NotesLocation`: resolve a security-scoped bookmark on launch; `NSOpenPanel` first-run prompt; save bookmark; stale-bookmark re-save; stop access on quit.
- [x] `AppController` recreates `NoteStore` with the resolved folder before the plugin host/window start.
- [ ] "Change notes folder…" in Settings (MAS only) — re-prompt and migrate access without moving files.
- [ ] Onboarding copy explaining "your notes stay plain Markdown".
- [ ] Test: fresh install → choose `~/Documents/Tenote Notes` → existing notes appear; relaunch → no prompt; stale bookmark → re-prompt; cancel → container fallback + warning.

**Acceptance:** notes in the chosen folder are read/written normally; no access outside the chosen folder; direct build unchanged.

## Phase 2 — Container paths and CLI

- [x] MAS logs under `Library/Logs/Tenote` in the container.
- [x] MAS skips the socket server and single-instance socket probe (no `tenotectl`/skhd).
- [x] Settings/plugins already resolve via `.applicationSupportDirectory`, which the sandbox redirects to the container.
- [ ] Settings UI: hide "Copy Log Path"/"Open Logs" or point them into the container.
- [ ] Decide whether to ship the `tenotectl` binary inside the MAS bundle (currently no).
- [ ] Document the feature difference in the store description.

## Phase 3 — Plugins and policy (App Review 2.5.2)

- [x] MAS discovers **builtin only**; `TENOTE_PLUGINS`/user layers ignored.
- [x] No `examples/` in the MAS bundle; no seeding.
- [x] "Install from file…" hidden in MAS; host method refuses.
- [x] `child_process` shim throws `ENOTSUP` in MAS.
- [ ] Remove the shim entirely from the MAS prelude (string surgery or a separate prelude).
- [ ] Plugin info/settings remain; document "built-in plugins only".
- [ ] Review notes: plugins are bundled with the app, not downloaded.

**Acceptance:** a store reviewer can see every executable line in the bundle; nothing installs code at runtime.

## Phase 4 — MAS build, signing, upload

- [x] `packaging/Tenote-MAS.entitlements` (`app-sandbox`, `files.user-selected.read-write`, `device.audio-input`, `network.client`).
- [x] `packaging/Info-MAS.plist` (`com.tenote.native.mas`, display name Tenote, `ITSAppUsesNonExemptEncryption=false`).
- [x] `packaging/PrivacyInfo.xcprivacy` (no tracking; file-timestamp reason `3B52.1`/`C617.1`).
- [x] `packaging/build-mas.sh`: `-Xswiftc -DMAS`, builtin-only resources, privacy manifest, profile embed, Apple Distribution signing, `productbuild` `.pkg`.
- [ ] Verify JavaScriptCore JIT under the sandbox (add `com.apple.security.cs.allow-jit` only if needed).
- [ ] Verify global ⌥. hotkey, login item (`SMAppService`), image paste, drag/drop, remote images.
- [ ] Upload with Transporter or `xcrun altool --upload-app`; TestFlight pass. **Each upload needs a higher `CFBundleVersion`** — bump it before re-uploading the same marketing version.
- [x] `ci.yml`: unsigned MAS build + bundle-content assertions.

**Commands (once certs/profile exist):**

```bash
MAS_PROVISIONING_PROFILE=/path/to/Tenote_MAS.provisionprofile \
SIGN_IDENTITY="Apple Distribution: Noemi Titarenco (CT5KSA99W8)" \
INSTALLER_IDENTITY="3rd Party Mac Developer Installer: Noemi Titarenco (CT5KSA99W8)" \
packaging/build-mas.sh
# → dist/Tenote-<version>-mas.pkg
xcrun altool --upload-app -f dist/Tenote-<version>-mas.pkg -t macos \
  --apple-id "$APPLE_ID" --password "$APPLE_APP_SPECIFIC_PASSWORD"
```

## Phase 5 — Store metadata

| Field | Copy |
|---|---|
| Name (30) | `Tenote — Quick Markdown Notes` |
| Subtitle (30) | `One hotkey. Plain text.` |
| Keywords (100) | `menu bar,quick note,scratchpad,markdown,plain text,jot,sticky,floating,hotkey,note card,minimal` |
| Category | Productivity |
| Price | Free |
| Promo text | `Press ⌥. anywhere. Type. It's already a Markdown file.` |

Description lead: *"Press ⌥. anywhere and a small card floats up. Type. It saves itself as a plain Markdown file you own. No accounts, no cloud, no tracking."* Mention themes, tags, images, and "built-in plugins" (not installable) for the store build.

- [ ] Privacy policy: no data collected, notes stay on the Mac / user-chosen folder; written to a URL.
- [ ] Support URL: GitHub repo/issues.
- [ ] Screenshots: 1280×800, 1440×900, 2560×1600, 2880×1800 — card over a desktop, ⌥. callout, notes folder in Finder, themes.
- [ ] Age rating 4+, no IAP, no ads.
- [ ] Review notes: **menu-bar app**; press ⌥. or click the menu-bar icon; first-run window; notes folder picker; sandboxed; no network except optional remote images.
- [ ] Export compliance: `ITSAppUsesNonExemptEncryption=false` (HTTPS only).

## Phase 6 — Review

- [ ] Submit; respond to 2.5.2 questions with "plugins are bundled, no code is downloaded or installed".
- [ ] If rejected for the notes-folder model, fall back to container storage + an explicit "Choose folder" setting.
- [ ] After approval: keep the direct build; document differences.

---

## Risk register

| Risk | Likelihood | Mitigation |
|---|---|---|
| 2.5.2 rejection over plugins | Medium | built-in only, no install UI, no `child_process`, review notes |
| Reviewer can't find the UI (menu-bar app) | Medium | first-run window + explicit review notes + screenshots |
| Bookmark access lost after OS update | Low | stale-bookmark re-prompt |
| JSC JIT blocked by sandbox/hardened runtime | Low | test; add `com.apple.security.cs.allow-jit` if needed |
| Notes folder chosen wrongly (users pick a subfolder) | Medium | onboarding copy + "Change folder" setting |
| Direct and MAS apps both installed | Medium | different bundle ids; README warning; same hotkey conflict |
| Remote images require network entitlement | Low | keep `network.client`; or strip `https:` from the MAS CSP |

## Definition of done

- MAS build passes `codesign --verify`, `spctl` (after install), and launches sandboxed.
- Fresh user picks `~/Documents/Tenote Notes` once; notes appear; relaunch is prompt-free.
- No user-installed plugins, no `examples/`, no `tenotectl`.
- App Store Connect record complete; TestFlight build passes; submitted.

## Files touched

```
Sources/TenoteCore/Paths.swift          notes override + MAS log dir
Sources/TenoteCore/JSRuntime.swift       INFO.allowExec
Sources/TenoteCore/JSPrelude.swift       execFile guard
Sources/Tenote/NotesLocation.swift       bookmark + NSOpenPanel
Sources/Tenote/AppController.swift       MAS launch path, builtin-only host, no socket
renderer/loader.js                       hide install UI when state.mas
packaging/Info-MAS.plist
packaging/Tenote-MAS.entitlements
packaging/PrivacyInfo.xcprivacy
packaging/build-mas.sh
.github/workflows/ci.yml                 unsigned MAS build
Tests/TenoteCoreTests/PathsTests.swift
```
