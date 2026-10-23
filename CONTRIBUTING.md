# Contributing

Thanks for taking a look. Pons is a small one-person project, so please keep changes focused.

## Run it locally

You need Node 22.12 or newer.

```bash
npm ci
cp .dev.vars.example .dev.vars   # test keys only, never commit .dev.vars
npm run dev                      # wrangler dev
```

Before opening a PR, run all three checks:

```bash
npm run typecheck
npm run lint
npm test
```

Tests never contact Garmin. They mock `fetch` (see `test/helpers.ts`).

## House rules

- **No personal data.** Never put real Garmin data, tokens, emails or your `.dev.vars` in issues, PRs, tests or logs. Fixtures are invented.
- **Read-only toward Garmin.** Tools only read. Anything that writes to a Garmin account needs an issue and a discussion first.
- **Pinned dependencies.** Versions are exact, and `package-lock.json` is committed. Review a dependency before adding it or bumping it.
- **Small PRs.** Describe what changed and how you tested it.
- **Security problems** go through a private advisory (see [SECURITY.md](SECURITY.md)), never a public issue.

## Workflow

Work on a branch and open a pull request against `main`. CI must pass before merging.
