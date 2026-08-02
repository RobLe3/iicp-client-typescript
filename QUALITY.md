# TypeScript SDK quality contract

Release evidence is generated locally from the exact clean commit by
`scripts/run-sdk-quality.mjs`. The runner checks Node 18, 20, 22 and 24,
TypeScript, the test suite, production dependency advisories, coverage,
packaging and a clean install. It emits only version, commit, runtime and gate
results; it does not retain test output, paths, credentials or package content.

The initial line-coverage ratchet is 75 percent. It is deliberately below the
current measured result so a regression fails while future increases remain
possible. The ordinary hosted workflow stays small because the project uses a
free GitHub account; the complete runtime matrix is a local release gate.
