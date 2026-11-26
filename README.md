# Token Radar

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/SNNN-011/token-radar-01/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/SNNN-011/token-radar-01/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

An offline research dashboard for DeFi protocols with no token recorded in the frozen DefiLlama snapshot. Rank by peer-implied market cap; inspect comparable protocols, the wide empirical range and the evidence behind each participation route. The watchlist remains visible even when a candidate needs extra verification.

**Interpretation:** the valuation is a cross-sectional comparison of tokenized peers. It is not a launch backtest, FDV, historical price prediction, airdrop probability or investment recommendation. The dashboard distinguishes a source-backed route from checks that still require verification.

## Run it

Use Node.js 22.18 or later; no package installation is needed. Put `snapshot.json` from the official kit in `input/`, then run:

```sh
node main.ts --input input/snapshot.json --output output
```

Open `output/dashboard/index.html` in a browser. The build writes the board, dashboard data, screenshots and dossier to the output directory. The grader supplies the same frozen input at `/input/snapshot.json` and expects outputs under `/output`.

```sh
node --test tests/*.test.ts
node tools/check-local.ts input/snapshot.json output output-second
```

For release verification, set `TOKEN_RADAR_SNAPSHOT` to the official snapshot path and `TOKEN_RADAR_REQUIRE_SNAPSHOT=1` before running the tests. Generate the second output independently into an empty directory. The local checker validates output structure and byte stability; it is not the sealed grader.

The official dossier builder is included unmodified under `vendor/`; see `LICENSE`. Keep private keys, session stores, and transcript bundles outside this repository.

---

<sub>Built for [make.fun](https://make.fun/?ref=pszvrn2f&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
