# macOS Distribution

## Gatekeeper bypass for unsigned builds

Unsigned macOS builds are suitable for local/manual testing only. They should not be published as Hydra releases because macOS auto-update requires a signed app.

If macOS blocks `Hydra.app` with a message that Apple could not verify it:

1. Try opening `Hydra.app` once so macOS shows the warning.
2. Open `System Settings`.
3. Go to `Privacy & Security`.
4. Scroll to the `Security` section.
5. Click `Open Anyway` for `Hydra.app`.
6. Confirm with your password, then click `Open`.

This only bypasses the warning on that Mac. It does not fix the warning for other users.

## Shipping signed and notarized builds

To support Hydra auto-update on macOS, release builds must be code signed. Notarization is still recommended so downloaded builds do not trigger Gatekeeper warnings.

Requirements:

1. An active Apple Developer Program membership.
2. A `Developer ID Application` certificate exported as a `.p12` file.
3. GitHub Actions secrets for code signing:
   - `CSC_LINK`
   - `CSC_KEY_PASSWORD`
4. One notarization credential set supported by Electron Builder:
   - Recommended:
     - `APPLE_API_KEY`
     - `APPLE_API_KEY_ID`
     - `APPLE_API_ISSUER`
   - Alternative:
     - `APPLE_ID`
     - `APPLE_APP_SPECIFIC_PASSWORD`
     - `APPLE_TEAM_ID`

Release flow:

1. Run the release helper:
   - `npm run release`
   - `npm run release:minor`
   - `npm run release:major`
2. GitHub Actions builds `Hydra.app`, `Hydra-<version>-arm64.dmg`, and `Hydra-<version>-arm64.zip`.
3. Electron Builder signs the build during the workflow. If notarization credentials are configured, it also notarizes the build.
4. The workflow uploads the DMG, ZIP, and update metadata to the GitHub Release page.

If the signing secrets are missing, the tag workflow now fails instead of publishing an unsigned release that cannot auto-update.
