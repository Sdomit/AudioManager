# Release-readiness audit — 22 July 2026

## Scope

Audit of the current `main` tip before the release-hardening change. Secret
checks report file paths only and do not expose values.

## Findings

| Area | Status | Finding |
| --- | --- | --- |
| Visibility | Needs owner decision | The repository is public. |
| Licensing | Blocked | No `LICENSE` file exists; README advertised `License TBD`. |
| Ownership metadata | Fixed in this branch | Cargo used `authors = ["you"]` and a generic Tauri description. |
| Versioning | Aligned | `package.json`, `Cargo.toml`, and `tauri.conf.json` all report `0.1.1`. |
| Dependency locks | Fixed in this branch | `pnpm-lock.yaml` and `Cargo.lock` exist, but CI used `npm install`. |
| Policies | Fixed in this branch | NOTICE, security, contribution, support, CODEOWNERS, and issue-routing files were missing. |
| CI | Partly ready | CI has frontend/Rust checks; Rust format and Clippy remain informational pending a clean baseline. The release-candidate workflow intentionally makes them blocking, so it cannot pass until that existing baseline is corrected. |
| Releases | Candidate/draft workflow added | No workflow previously produced checksums, an SBOM, or provenance. Tag pushes now build a candidate; an owner-only manual action can create a draft pre-release but never publish it. |
| Branch protection | Partly enabled | CI and conversation resolution are required; admins can bypass and no PR-review policy is enabled. |
| Sensitive data | No high-confidence finding | Targeted scan found no private-key, GitHub-token, AWS-key, or certificate file/value pattern. |
| Local paths | No finding | Targeted scan found no user-home absolute-path pattern in tracked content. |

## Owner decisions still required

1. Select a specific license and decide whether the repository should remain
   public, become a showcase, or return to private development.
2. Choose a contribution-rights policy before accepting outside code.
3. Decide whether to keep the AudioManager name or adopt a distinctive brand.
4. Configure a Windows code-signing identity and decide when unsigned
   pre-release candidates are acceptable.
5. Apply the repository settings in [github-settings.md](github-settings.md),
   particularly the sole-maintainer review/bypass choices.

## Release gate

Do not publish a new official release until the decisions above are complete,
third-party driver redistribution has been reviewed, and a clean supported
Windows machine has passed install, upgrade, uninstall, and real audio-routing
tests.
