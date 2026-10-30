# Development notes for agents working in this repository

`dsh-remote-signin` is a DSH plugin. Read [README.md](README.md) first: it carries the
measurements that justify the design, and the rules the code is not allowed to break.

## Layout

| Path | Purpose |
|---|---|
| `src/index.js` | The plugin: claim wrapper, the panel route, index injection. |
| `src/claim.js` | Pure origin logic, exported for tests. |
| `assets/inpage.js` | The in-page panel (client) — the only way the code comes back. |
| `cordis.patch.yml` | The loader entry a profile or `--patch` overlay picks up. |
| `test/`, `test-support/` | `node --test` suites and the DOM stub they share. |
| `scripts/report-ci-failure.mjs` | Files the issue that tracks a red `ci` run (see CI below). |

## CI

`ci` runs on push, on pull requests, hourly, and on demand. A red run is recorded by
`.github/workflows/ci-failure-issue.yml`, a separate `workflow_run` workflow so the job
under test never holds `issues: write`: it keeps one issue per default branch, refreshed
with the failing run, commit and jobs on every failure, and comments and closes it on
the next green run. Pull-request runs are not tracked — the pull request already carries
their result. The issue text lives in `scripts/report-ci-failure.mjs`; keep
`test/ci-failure-issue.test.mjs` (a stub API, no network) in step with it.

## Rules

1. **Fail soft, never fail the boot.** DSH is the product; this plugin is a convenience.
   A missing asset, an unusable claim, an upstream rename, a duplicate route — each one
   must leave DSH running with upstream behaviour plus one log line. Nothing here may
   throw out of `apply`.
2. **Never touch upstream's validation.** The completion path is upstream's
   `/oauth/callback` route: its one-time `state` check and its PKCE verifier. This plugin
   chooses the redirect *string* and renders the one place to hand the code back.
3. **No secrets in logs or markup.** Never log `code`, `state` or tokens. The panel takes
   only `code` and `state` out of a pasted address, re-encodes them, and sends them to
   this origin's own callback — never to a URL taken from the input.
4. **The panel is the only way back.** There is no second page to fall back on: if the
   panel does not appear, the sign-in cannot be finished. Keep its probe, its extraction
   rules and every status it reports covered by tests, and keep the image's smoke test
   asserting that the document really carries the injected script.
5. **Style from the harness tokens, never from a palette of your own.** The panel uses
   `--dsw-*` (declared on `:root` by `@deepseek-ai/dsh-client-ui-theme`) with fallbacks,
   and follows the app's theme rather than `prefers-color-scheme`. `test/inpage.test.mjs`
   pins this: no hard-coded colour may survive stripping the `var()` fallbacks.
6. **Keep the tests dependency-free.** `node --test` and `test-support/dom.mjs` only. No
   browser, no build step, no network.

## Before committing

```bash
node --test
```

Every behaviour change needs a test in `test/`, and the version in `package.json` plus
[CHANGELOG.md](CHANGELOG.md) move together when a release is tagged: the `dsh-unraid`
image pins a tag of this repository, so a pushed tag is a deployment.
