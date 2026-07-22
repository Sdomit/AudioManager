# GitHub settings runbook

This runbook records the repository controls that cannot be enforced from a
pull request. Apply them in **Settings** only after reviewing the corresponding
hardening pull request.

## Current snapshot — 22 July 2026

- `main` already requires the CI checks `Frontend (tsc + vitest)` and `Rust
  (windows)` and requires resolved conversations.
- Force pushes and branch deletion are blocked.
- Administrators can still bypass branch protection; linear history, required
  pull requests, required reviews, signed commits, CODEOWNER review, and tag
  rulesets are not enabled.
- The repository is public, so GitHub Free supports branch and tag rulesets.

## Main branch

Create or update the `main` protection rule/ruleset with these settings:

1. Require a pull request before merging.
2. Require the current CI checks, require branches to be up to date, and retain
   required-conversation resolution.
3. Block force pushes and branch deletion.
4. Require a linear history once squash merging is the normal merge strategy.
5. Keep required approving reviews at **zero** until a second trusted reviewer
   is available. A pull-request author cannot approve their own pull request,
   so requiring one approval would block the sole maintainer.
6. Enable required CODEOWNER review only after adding a separate trusted code
   owner. `@Sdomit` is intentionally listed now so review requests are visible,
   but it is not a substitute for independent review.
7. Decide explicitly whether administrators may bypass the rule. Enforcing it
   for administrators gives stronger protection but removes the owner’s direct
   emergency path; document a break-glass process first.
8. Prefer signed release tags now. Do not require signed commits until every
   regular maintainer and automation path is verified compatible.

## Release tags and releases

1. Create a tag ruleset for `v*`; block tag deletion and updates, and allow tag
   creation only through the documented release process.
2. Enable immutable releases for future releases. Create releases as drafts,
   attach the installer, checksums, SBOM, and attestations, then publish only
   after review.
3. Treat `release-candidate.yml` artifacts as candidates, not published
   software. A draft pre-release is created only when the owner manually runs
   it with `create_draft=true`; the workflow never publishes a release. These
   candidates are intentionally unsigned while the signing process is being
   established.
4. Configure Windows code signing and verify a clean-machine install, upgrade,
   uninstall, and audio-routing test before enabling a stable channel.

## Security and automation

1. Enable private vulnerability reporting, then update `SECURITY.md` to name
   that channel as the primary route.
2. Enable secret scanning and push protection when available for this account.
3. Enable Dependabot alerts and update pull requests; the repository now
   includes `dependabot.yml` for npm, Cargo, and Actions updates.
4. Review OAuth apps, SSH keys, personal-access tokens, and GitHub Apps on a
   three-month schedule. Use expiring fine-grained tokens and keep signing keys
   outside Git.
