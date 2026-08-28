# Signing & notarization status

**Status: SIGNED + NOTARIZED as of 1.3.0 (2026-08-28).** The dmg/zip are signed
with `Developer ID Application: Noemi Titarenco (CT5KSA99W8)` (hardened runtime)
and notarized with notarytool (`notarization successful` in the build log).
The dmg itself carries no embedded code signature, which is fine for Gatekeeper.
Final check on a clean machine: open the dmg and confirm no Gatekeeper warning.

(Enrolled as an **individual** on 2026-08-10; enrollment approved same day.)

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
- `.github/workflows/release.yml`: a GitHub Actions workflow builds, signs, notarizes,
  and publishes a release on every `v*.*.*` tag push (or via manual workflow dispatch).

## Required GitHub secrets

For the release workflow to sign and notarize, add these repository secrets at
**Settings → Secrets and variables → Actions**:

| Secret | What it is |
| --- | --- |
| `APPLE_DEVELOPER_ID_CERTIFICATE` | Base64-encoded `.p12` of the **Developer ID Application** certificate |
| `APPLE_DEVELOPER_ID_CERTIFICATE_PASSWORD` | The password used when exporting the `.p12` |
| `APPLE_ID` | The Apple ID email used for the developer account |
| `APPLE_APP_SPECIFIC_PASSWORD` | An app-specific password from [appleid.apple.com](https://appleid.apple.com) |
| `APPLE_TEAM_ID` | Team ID from [developer.apple.com](https://developer.apple.com) → Membership |

To base64-encode the certificate on macOS:

```sh
base64 -i ~/Downloads/DeveloperIDApplication.p12 -o certificate.base64.txt
```

Then paste the contents of `certificate.base64.txt` into the `APPLE_DEVELOPER_ID_CERTIFICATE` secret.

## Releasing a new version

1. Bump the version in `package.json` (and run `npm install` to update `package-lock.json`).
2. Commit and push the version bump to `main`.
3. Create and push a tag:
   ```sh
   git tag v1.3.0
   git push origin v1.3.0
   ```
4. The `Release Tenote` workflow runs automatically on a macOS runner, builds the
   `dmg` and `zip`, signs + notarizes them, and creates a GitHub release with the
   artifacts attached.

You can also trigger a release manually from **Actions → Release Tenote → Run workflow**.

## Local builds (alternative)

If you prefer to build on your own Mac instead of GitHub Actions:

1. **Certificate:** [developer.apple.com](https://developer.apple.com) → Certificates → "+" → **Developer ID
   Application**. Download, double-click to install into the login keychain. Verify:
   `security find-identity -v -p codesigning`.
2. **App-specific password:** [appleid.apple.com](https://appleid.apple.com) → Sign-In and Security → App-Specific
   Passwords (used by notarytool).
3. **Team ID:** [developer.apple.com](https://developer.apple.com) → Membership.
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
