# Signing & notarization status

**Status: BLOCKED — waiting for Apple Developer Program enrollment approval.**

Enrolled as an **individual** on 2026-08-10. Apple typically reviews individual
enrollments within 24–48 hours (sometimes a few days; watch the enrollment email,
including spam, in case identity verification is requested).

## Why

The 1.0.0 dmg is unsigned (`identity: null`). On recent macOS versions, downloaded
unsigned apps get quarantined and Gatekeeper shows **"Tenote is damaged and can't be
opened. You should move it to the Trash"**. The right-click → Open workaround no
longer reliably works. Signed + notarized builds eliminate this entirely.

Note: with an individual account, the certificate subject is the holder's legal name
(`Developer ID Application: <Name> (<TeamID>)`), visible in the Gatekeeper first-open
dialog. Accepted as a cosmetic tradeoff for now; converting to an organization account
later is possible if branding matters.

## What's already done

- `package.json`: removed `"identity": null`, added `"hardenedRuntime": true` and
  `"notarize": true` to the `mac` build config. electron-builder will auto-select the
  "Developer ID Application" identity from the login keychain and use notarytool.
- `README.md`: documents the `xattr -dr com.apple.quarantine` workaround and the
  "Open Anyway" route for the current unsigned release. Keep this until a notarized
  release is out.

## What to do once the welcome email arrives

1. **Certificate:** developer.apple.com → Certificates → "+" → **Developer ID
   Application**. Download, double-click to install into the login keychain. Verify:
   `security find-identity -v -p codesigning`.
2. **App-specific password:** appleid.apple.com → Sign-In and Security → App-Specific
   Passwords (used by notarytool).
3. **Team ID:** developer.apple.com → Membership.
4. **Export env vars** (shell profile or an uncommitted local `.env`):
   ```sh
   export APPLE_ID="you@example.com"
   export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
   export APPLE_TEAM_ID="ABCDE12345"
   ```
5. **Build:** `npm run dist`. Notarization adds a few minutes (upload to Apple, wait,
   staple the ticket to the dmg).

## Possible follow-ups

- If the signed app crashes while the unsigned one doesn't, revisit hardened-runtime
  entitlements (electron-builder defaults should cover Electron's JIT needs).
- For CI later, prefer an App Store Connect API key (`APPLE_API_KEY`,
  `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`) over the app-specific password.
- After the first notarized release: verify on a clean machine that the dmg opens
  with no Gatekeeper warning, then drop the quarantine workaround from the README.
