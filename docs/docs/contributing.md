---
title: Contributing
---

# Contributing

See [CONTRIBUTING.md](https://github.com/Thebooch/FreeBird/blob/main/CONTRIBUTING.md)
in the repository for the full walkthrough. In short:

```bash
git clone https://github.com/Thebooch/FreeBird
cd FreeBird
pnpm install
pnpm test
pnpm build
pnpm changeset # when you're ready to release
```

FreeBird uses:

- **pnpm workspaces** — packages live under `packages/*`, examples under
  `examples/*`.
- **tsup** for bundling.
- **vitest** for tests.
- **changesets** for versioning and releases.

Issues and PRs are welcome for new adapters, framework integrations, and
docs improvements. New architectural changes should start as an RFC issue
so we can talk through the tradeoffs first.
