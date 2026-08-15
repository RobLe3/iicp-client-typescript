# Contributing

Use this repository for **iicp-client-typescript** bugs, documentation fixes, tests and pull
requests:

- Issues: https://github.com/RobLe3/iicp-client-typescript/issues
- Protocol and cross-component proposals: https://github.com/RobLe3/IICP/issues/new?template=protocol-proposal.yml
- Community discussion: https://iicp.network/forum/
- Private vulnerability reports: https://github.com/RobLe3/iicp-client-typescript/security/advisories/new

Do not include credentials, private topology, production records, task
payloads or personal data in public issues. Participation does not confer
protocol authority; public proposal decisions remain recorded in the owning
issue or pull request under the current founder-led governance process.

Please include the client version, operating mode (`serve`, `relay`, Docker,
launchd/systemd, library use), relevant logs without secrets, and the command or
small reproducer you used. For protocol or behaviour changes, keep Rust, Python
and TypeScript parity in mind and mention which clients are affected.

Pull requests are welcome. Prefer small, test-backed changes; update the README
or CHANGELOG whenever operator-facing behaviour changes.

## Reproducing the checks

From a clean checkout with the Node version used by the quality workflow:

```bash
npm ci
npm run typecheck
npm test
npm run build
```

The public [IICP repository map](https://github.com/RobLe3/IICP/blob/main/ecosystem/public-repositories.json)
identifies normative and implementation ownership. A pull request does not
authorize a package release. Maintainers publish immutable, versioned artifacts
only after the repository's release checks pass.

## License

By contributing, you agree your contributions are licensed under Apache-2.0.
