# Contributing

Thanks for helping improve DSH Agent.

## Development setup

1. Install Node.js 20 or newer.
2. Run `npm install`.
3. Copy `.env.example` to `.env.local` and set `OBSIDIAN_VAULT` if you want builds to deploy into a local Obsidian vault.
4. Run `npm run typecheck` and `npm run test:integration` before opening a pull request.

Please keep fixtures synthetic. Do not commit vault content, session logs, API keys, local paths, screenshots containing private notes, or files produced under `artifacts/`.

## Bug reports

Open a GitHub issue with reproduction steps, the Obsidian and plugin versions, and sanitized logs. Remove note contents, credentials, local paths, and other personal information before posting.
