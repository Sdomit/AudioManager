# Release-readiness audit — 22 July 2026

## Scope

Audit of the current `main` tip before the release-hardening change. Secret
checks report file paths only and do not expose values.

## Findings

| Area | Status | Finding |
| --- | --- | --- |
| Visibility | Needs owner decision | The repository is public. |
| Licensing | Ready | Source code is licensed under Apache-2.0; `NOTICE` records the separate brand and third-party attribution boundaries. |
| Ownership metadata | Fixed in this branch | Cargo used `authors = ["you"]` and a generic Tauri description. |
| Versioning | Aligned | `package.json`, `Cargo.toml`, and `tauri.conf.json` all report `0.1.1`. |
| Dependency locks | Fixed in this branch | `pnpm-lock.yaml` and `Cargo.lock` exist, but CI used `npm install`. |
| Policies | Fixed in this branch | NOTICE, security, contribution, support, CODEOWNERS, and issue-routing files now document the current owner-only contribution policy. |
| CI | Partly ready | CI has frontend/Rust checks; Rust format and Clippy remain informational pending a clean baseline. The release-candidate workflow intentionally makes them blocking, so it cannot pass until that existing baseline is corrected. |
| Releases | Candidate/draft workflow added | No workflow previously produced checksums, an SBOM, or provenance. Tag pushes now build a candidate; an owner-only manual action can create a draft pre-release but never publish it. |
| Branch protection | Owner action required | CI and conversation resolution are required, and the live rule currently requires one approving review; admins can bypass, but the sole-maintainer policy calls for zero required approvals until an independent reviewer is available. |
| Sensitive data | No high-confidence finding | Targeted scan found no private-key, GitHub-token, AWS-key, or certificate file/value pattern. |
| Local paths | No finding | Targeted scan found no user-home absolute-path pattern in tracked content. |

## Owner decisions still required

1. Decide whether the repository should remain public, become a showcase, or
   return to private development.
2. Keep external code contributions closed until a documented contributor-rights
   policy is published.
3. Keep the AudioManager name and current product branding unless a later brand
   decision replaces it.
4. Configure a Windows code-signing identity before a stable release; unsigned
   draft pre-release candidates are allowed only after maintainer review.
5. Apply the repository settings in [github-settings.md](github-settings.md),
   particularly the sole-maintainer review/bypass choices.

## Release gate

Do not publish a new official release until the decisions above are complete,
third-party driver redistribution has been reviewed, and a clean supported
Windows machine has passed install, upgrade, uninstall, and real audio-routing
tests.
