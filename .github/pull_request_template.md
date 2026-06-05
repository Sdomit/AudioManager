<!-- One issue per PR when feasible. Squash-merge with "Closes #N" below. -->

## Summary

<!-- What changed and why, in a few lines. -->

Closes #

## Validation

Run before requesting review (see docs/process-loopback-implementation-plan.md):

- [ ] `npx tsc --noEmit`
- [ ] `cargo check --manifest-path src-tauri/Cargo.toml`
- [ ] `cargo test --manifest-path src-tauri/Cargo.toml`
- [ ] `npm test`
- [ ] `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`
- [ ] `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings`
- [ ] `git diff --check`

## Smoke test

<!-- For audio paths, the manual steps you ran with `npm run tauri dev`
     (which device/app, expected meters, teardown). -->

## Notes

<!-- Follow-ups, deferred work, risks. -->
