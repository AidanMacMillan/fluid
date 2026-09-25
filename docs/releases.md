# Mac releases and updates

Fluid downloads stable releases from the public
[AidanMacMillan/fluid repository](https://github.com/AidanMacMillan/fluid/releases).
The packaged Mac app checks 15 seconds after launch and every six hours,
downloads a newer version, and offers **Restart and Install** or **Later**.
Later installs on the next quit. **Fluid → Check for Updates…** checks manually
or offers to restart for an already downloaded update. Development builds do
not check, and prereleases and downgrades are excluded.

## One-time Apple setup

Mac auto-updates require code signing. Distribution outside the App Store uses
a **Developer ID Application** certificate and notarization. Both are included
in the [Apple Developer Program](https://developer.apple.com/programs/enroll/)
(US$99/year, or local currency where available); no App Store listing is needed.
Check existing membership at [developer.apple.com/account](https://developer.apple.com/account/).

1. Enroll if needed, then create a **Developer ID Application** certificate
   using Xcode or Apple's Certificates portal. Do not choose Apple Development,
   Apple Distribution, or Developer ID Installer.
2. In Keychain Access, export the certificate **with its private key** to a
   password-protected `.p12` file. Keep the certificate/private key for later
   releases, so installed copies continue trusting updates.
3. Create an app-specific password for notarization at
   [account.apple.com](https://account.apple.com/), and find the Team ID in your
   Apple Developer membership details.
4. In the repository's **Settings → Secrets and variables → Actions**, add:

   | Secret                        | Value                                                |
   | ----------------------------- | ---------------------------------------------------- |
   | `MAC_CSC_LINK`                | Base64 contents of the exported `.p12` certificate   |
   | `MAC_CSC_KEY_PASSWORD`        | The export password for that `.p12`                  |
   | `APPLE_ID`                    | Your Apple account email                             |
   | `APPLE_APP_SPECIFIC_PASSWORD` | The app-specific password, not your account password |
   | `APPLE_TEAM_ID`               | Your Apple Developer Team ID                         |

   On macOS, `base64 -i /path/to/certificate.p12 | pbcopy` copies the encoded
   certificate for the secret field. Never commit certificates or passwords.
   GitHub supplies `GITHUB_TOKEN` automatically; clients need no GitHub token.

## Publish a release

1. Set `version` in `packages/desktop/package.json` to the new stable version.
   The initial version is `0.1.0`; subsequent versions must increase.
   Versions below `1.0.0` indicate early development. Keep the version free of
   prerelease suffixes and publish it as a regular GitHub release so the
   existing updater channel picks it up.
2. Commit the version and release setup, push your changes, then push its tag:

   ```sh
   git tag v0.1.0
   git push origin v0.1.0
   ```

3. The **Release Mac app** workflow builds Apple Silicon (`arm64`) and Intel
   (`x64`) DMGs and ZIPs, signs and notarizes them, and uploads a **draft**
   GitHub release. Native modules are rebuilt for each target architecture.
   Missing signing secrets stop the workflow before it builds anything.
4. Wait for the entire workflow to succeed. Verify that the draft contains both
   architectures' DMGs and ZIPs, their generated blockmaps, and `latest-mac.yml`
   referencing both ZIPs. Keep those assets and their names intact: ZIPs and
   metadata power the updater, while DMGs are the initial download.
5. Install a DMG in `/Applications`, verify it launches, add release notes, then
   **Publish release** in GitHub. Drafts are invisible to the updater.

To retry a failed release, rerun its workflow, or manually run the workflow
against the same version tag. Do not replace assets of an already published
version; publish a higher version instead. The repository must remain public
for the current unauthenticated update feed to work.

## Local builds and verification

Claude tabs require a separately installed Claude Code CLI. Fluid searches PATH
and common native/Homebrew locations, requires at least the CLI version recorded
in the SDK manifest, and shows installation/update instructions with a Retry
button when unavailable. The SDK's JavaScript remains in Fluid, but its optional
platform executables are excluded from installation and release packages.
Claude Code updates independently of Fluid.

`pnpm --filter @fluid/desktop build:mac` builds a DMG and updater ZIP for your
current architecture without publishing. Local notarization remains off;
the release workflow explicitly enables it and requires signing. An unsigned
local build can be shared for manual installation, but is not a supported
starting point for Mac auto-updates. Install the first signed release manually.

`pnpm --filter @fluid/desktop test:updater` exercises the updater with mocked
Electron/network services. It covers checks, downloads, retries, duplicate
checks, delayed installation, and disabled checks in development.

Before relying on updates in production, test two signed versions: install
the older release in `/Applications`, publish the higher version, use
**Check for Updates…**, and choose **Restart and Install**. Verify the new
version in **About Fluid** and that existing tasks and tabs survive. Repeat
with **Later** and a normal quit/relaunch. This end-to-end test requires the
Apple credentials and published releases; unit tests cannot verify Apple's
signature/notarization acceptance or Squirrel's installation.

References: [electron-builder auto-update](https://www.electron.build/auto-update),
[macOS signing](https://www.electron.build/code-signing-mac).
