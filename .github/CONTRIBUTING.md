# Contributing to icrefin/dsh-remote-control

Thanks for taking the time to contribute. This document covers the repository
**dsh-remote-control** owned by `icrefin`.

## Ways to contribute

- Report a bug using the *Bug report* issue form.
- Request a feature using the *Feature request* issue form.
- Improve documentation, examples, or translations.
- Send a pull request that fixes or implements something on the issue tracker.

If you plan a large change, open an issue first so we can agree on the design
before you write the implementation.

## Before you start

1. Search existing issues and pull requests to avoid duplicates.
2. Read the [Code of Conduct](CODE_OF_CONDUCT.md).
3. Check the README for supported versions and prerequisites.

## Development setup

This is a TypeScript package built with pnpm. It needs **Node >= 22.17.0** and
**pnpm 11**, the version pinned in `package.json` through `packageManager`
(`corepack enable` picks it up). The `@deepseek-ai/dsh-*` peer dependencies are
published on npm, so a clean checkout really does install.

```bash
git clone https://github.com/icrefin/dsh-remote-control.git
cd dsh-remote-control
git switch main

corepack enable
pnpm install
pnpm check          # tsc over both halves, then the test suite
```

| Command | What it does |
| --- | --- |
| `pnpm typecheck` | `tsc` over the host half and, separately, over the browser half |
| `pnpm test` | the behavioural suite in `test/` |
| `pnpm check` | `pnpm typecheck && pnpm build && pnpm test` — run this before opening a pull request |
| `pnpm build` | the bundle under `lib/` |
| `pnpm pack` | `pnpm build`, then `npm pack` into `dist/` |

`lib/` and `dist/` are build products and are not committed. `pnpm check` is the
suite CI runs, so run it before opening a pull request.

## Branch and commit conventions

- Branch from `main`; keep one topic per branch (`fix/...`, `feat/...`, `docs/...`).
- Keep commits small and focused.
- Write imperative, scoped commit messages, e.g. `fix(parser): reject empty input`.
- Rebase onto the latest `main` before requesting review; avoid merge commits inside the PR branch.

## Pull requests

Every pull request must:

- Explain **what** changed and **why**.
- Link the issue it closes (`Closes #123`).
- Pass CI.
- Update documentation whenever user-facing text or behavior changes — including both
  language halves of a bilingual README, and both the English and Chinese copy in the
  panel's locale dictionaries when the change is user-visible.
- Contain no secrets, tokens, private keys, internal hostnames, or personal data.
- State the license of any newly added dependency and confirm it is compatible with
  this project's `MIT` license.

Use the repository's pull request template. Do not delete checklist items without
explaining why.

## Reporting bugs

A useful bug report contains:

- The version, commit SHA, or release tag of the plugin you tested.
- The DeepSeek Harness build you ran it against, and how the plugin was installed.
- Operating system and runtime version.
- Exact reproduction steps, expected result, and actual result.
- Logs with secrets and personal data removed.

Report security vulnerabilities privately — see [SECURITY.md](SECURITY.md). Never open
a public issue for a vulnerability.

## Coding style

- Match the style of the surrounding code; do not reformat unrelated files.
- Add or update tests for behavior changes.
- Keep public APIs documented.
- Prefer clear names over comments that restate the code.
- Do not add a dependency for something the standard library already does.

## Review process

Maintainers review pull requests as time allows. Expect at least one round of
feedback. Address comments with follow-up commits or a rebase, then re-request review.
A pull request inactive for 60 days without response may be closed.

## License

By contributing, you agree that your contributions are licensed under the `MIT`
license of this repository (inbound = outbound). Do not paste code you cannot
license under these terms.

## Questions

Open a discussion, or email the maintainer at `icrefinai@gmail.com`.
