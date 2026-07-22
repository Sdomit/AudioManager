# Contributing

Contributions welcome. Read this first — the licensing section is binding.

## Licensing of Contributions

AudioManager is licensed under [PolyForm Noncommercial 1.0.0](LICENSE): free for
noncommercial use, commercial use requires a separate license from the copyright
holder.

For that dual model to work, the copyright holder must be able to license the
whole codebase — including your contribution — under commercial terms. So:

> **By submitting a pull request, you grant Sarmad Domit a perpetual, worldwide,
> irrevocable, royalty-free license to use, modify, sublicense, and relicense
> your contribution under any terms, including commercial and proprietary terms.
> You confirm that you wrote the contribution yourself, or otherwise have the
> right to submit it under these terms.**

You keep the copyright to your work. This grants a license, not ownership.

If your employer holds rights to work you do, get their sign-off before
contributing.

### Sign your commits (DCO)

Every commit must carry a `Signed-off-by` line certifying the
[Developer Certificate of Origin](https://developercertificate.org/):

```
git commit -s -m "your message"
```

## Before Opening a PR

Run the same gate CI runs:

```bash
npx tsc --noEmit          # type-check
npm test                  # frontend tests
cd src-tauri && cargo test # rust tests
```

## Guidelines

- One logical change per PR. Split unrelated work.
- Match the surrounding code — naming, comment density, idiom.
- New non-trivial logic needs a test.
- Audio-path changes: state what you measured. Latency and CPU claims need
  numbers, not assertions.
- Do not add a dependency for something a few lines can do.

## Reporting Bugs

Use the [issue templates](https://github.com/Sdomit/AudioManager/issues/new/choose).
Security bugs go through [SECURITY.md](SECURITY.md) instead — never a public issue.
