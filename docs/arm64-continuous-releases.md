# Continuous Windows ARM64 releases

The maintained port lives at https://github.com/luisfranciscor505/openwhispr-arm64
on the `arm64` default branch. Upstream is https://github.com/OpenWhispr/openwhispr.
The original local snapshots remain in `archive/local-port-snapshot`.

## Routine updates

`ARM64 upstream synchronization` checks stable releases every six hours and can
also run manually. It imports newer stable tags into one `sync/vX.Y.Z` PR.
Unreleased upstream main changes and prereleases are excluded. Conflicts produce
a draft PR with the conflicting files; no candidate is published until resolved.
The upstream workflows are retained under `.github/upstream-workflows`, outside
GitHub Actions' executable workflow directory.

`Verified Windows ARM64 release` builds the candidate on `windows-11-arm`, runs
quality checks, then waits for the `snapdragon-npu` runner. It tests the exact
installer in a dedicated account. The publication job checks source, run/attempt,
installer bytes and required NPU/CPU/UI results before signing and publishing.
Only a verified candidate PR is merged. The runner's administrator-owned job hook
refuses all jobs except this repository's release workflow dispatched from
`arm64`, before checkout. External contributors also require workflow approval;
never approve a contributor workflow for local execution.
The protected JavaScript hook uses the runner's bundled Node runtime; machine
and account PowerShell execution policies stay intact.
After changing the hook, run `scripts/secure-arm64-runner.ps1` elevated to deploy
it and restart the service. Start a fresh release run after verification setup
failures: rerunning only failed jobs deliberately fails the run-attempt binding.

For a port-only fix, increment `portRevision` in `arm64-release.json`, merge the
change to `arm64`, then dispatch the release workflow with candidate `arm64`.
Never overwrite release assets or reuse a published version. `vX.Y.Z-arm64.N`
orders port fixes within an upstream version. Only this dedicated signed feed
may provide those versions; the normal upstream updater is never consulted.

## Initial setup and rebuilding

1. Use native Node 24 and the ARM64 toolchain in `windows-arm64.md`.
2. Authenticate `gh` with repository and workflow permissions. Keep Actions
   enabled; allow Actions to create PRs in repository settings.
3. Run `node scripts/setup-arm64-release.js` as the maintainer. It creates the
   Ed25519 key outside the checkout, installs its public half into the release
   configuration, and stores the private half in the `arm64-release` environment.
4. Run `scripts/install-arm64-runner.ps1 -Configuration <prepared JSON>` elevated
   to create the non-administrator `OpenWhisprVerify` account and runner service.
   The downloaded official runner is checked against GitHub's SHA-256 digest.
   Only public Base/NPU model assets are copied; account data is excluded.
5. Commit the public configuration, push `arm64`, set it as the default branch,
   and enable the two ARM64 workflows. Dispatch the release workflow.
6. Install the first managed ARM64 installer manually. The previous local build
   intentionally has no update feed. Subsequent versions download automatically
   when enabled and install only after choosing restart. Ordinary exit does not
   install a pending update.

The model staging directory is `C:\ProgramData\OpenWhisprARM64\models`, supplied
to the runner through `OPENWHISPR_VERIFY_MODELS`. Tests copy it to temporary
storage, where preferences and profiles can change without touching user models.
Installer tests run only under the dedicated account, because NSIS also writes
per-user registration entries. They never capture microphone audio.

The workflow uses the same pinned build scripts as local builds. Public releases
never bundle `.env`; configure OAuth/API credentials locally. Local Calendar
settings remain in the existing user data directory.

## Signing keys and recovery

The private key is stored at
`%LOCALAPPDATA%\OpenWhisprRelease\update-signing-private.pem` with restricted ACLs.
Back it up securely outside the repository. It is also an environment secret
named `ARM64_UPDATE_PRIVATE_KEY`. The local runner has no access to this secret.
The environment permits deployment only from the `arm64` workflow branch.
Never print, commit, or upload the private key as an artifact.

Feed metadata is signed with Ed25519. It binds app/repository identity, target,
version, source commits and the installer URL, size and SHA-512. The client checks
the signature and target before downloading and rehashes the cached installer
before installation. Authenticode remains unsigned, so Windows may show an
unknown-publisher warning. Losing the signing key requires a manual bootstrap
with a new trust key; implicit key rotation is deliberately unsupported.

If verification fails or the PC is offline, the last published release remains
available. Inspect the workflow and restricted local runner logs. Public reports
contain fixed-fixture outcomes and provenance, not screenshots or account paths.
The first bootstrap release has no previous managed version to upgrade from.
Every later release must additionally prove an installed A-to-B update using
the packaged updater, authenticated candidate metadata and the real NSIS
installer. The test substitutes transport with the already downloaded candidate;
it checks renderer preferences and CPU/NPU model bytes after installation and
restart, then transcribes both fixed languages again using the updated NPU graphs.
Native/model pin changes are blocked in automatically imported candidates; make
and validate those changes separately on the maintained branch.

For a regression after publication, publish a higher port revision containing the
fix or previous compatible code. Do not automatically downgrade databases or
reuse older version numbers. Retain the previous installer for manual recovery.
Upstream database migrations remain upstream behavior and must be assessed when
recovering data; the updater introduces no additional schema migration.
