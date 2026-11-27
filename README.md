# Reckon

Reckon checks tokenized treasury funds on Solana against what their issuers and regulators publish. It reads each fund on chain, compares it with the issuer's own figures, regulator records and entity registers, and says plainly when a check cannot be made.

Live: https://reckon-app.up.railway.app

Walkthrough video: https://youtu.be/HcW8KlYMs-0

## What it watches

| Asset | Solana mint | What can be checked |
| --- | --- | --- |
| Superstate USTB | `CCz3SGVziFeLYk2xfEstkiqJfYkjaSWb2GCABYsVcjo2` | The full set: mint state, activity, issuer reconciliation, SEC trail, entities |
| BlackRock BUIDL | `GyWgeqpy5GueU2YbkE8xqUeVEokCMMCEeUrfbtMw6phr` | Mint state, activity, token metadata, LEIs. No official issuer data page was found, so there is no issuer figure to reconcile |
| Ondo USDY | `A1KLoBrKBde8Ty9qtNQUtq3C2ortoC3u7twggz7sEto6` | Mint state, activity, supply across 12 chains against the issuer page, the page's own arithmetic |

Each row on the page is Established, Flagged or Cannot check, with its values, sources, fetch times and, where bought, the Telegraph receipt. Every asset has a "cannot be checked, and why" list. A report can be downloaded per asset as JSON or Markdown.

## The checks

1. Mint state: supply, decimals, mint and freeze authority and Token-2022 extensions, read on two public Solana RPCs and refused if they disagree. Changes against the previous snapshot are flagged.
2. Recent mints, burns and authority changes from the mint's transactions.
3. Issuer reconciliation: on-chain supply against the issuer's tokens per network, shares times NAV against reported assets, as-of dates and holdings consistency (USTB); supply summed across chains against the issuer's figures (USDY).
4. SEC filings for the fund's CIK, bought through Telegraph (EDGAR refuses undeclared clients and Reckon does not disguise itself).
5. Entities: GLEIF is read directly for pinned LEIs; sanctions screening is bought through Telegraph.
6. An independent supply read bought through Telegraph and set beside Reckon's own.

## Holdings

The Holdings tab takes up to five public Solana or EVM addresses (read-only, no wallet connection, no signing) and reports, per position in USTB, BUIDL or USDY: balance, value at the latest NAV or price, share of supply, frozen or blocklisted state, recent transfers, and the asset-level findings that affect the position. The address list is kept only in the browser (localStorage) or the URL; the server stores nothing and rate limits the endpoint (`GET /api/holdings?address=...`, 6 requests a minute per client, a 45 second cache, three reads at a time). Four public example addresses are provided and labelled as examples.

## The USDY investigation

Reckon's USDY row reconciles the 12-chain supply against Ondo's page, subtracting documented adjustments (bridge escrow, Ondo-listed addresses, wrapper double counts) and showing the residual. The method, addresses and what is and is not explained are in [docs/usdy-investigation.md](docs/usdy-investigation.md), also served at `/docs/usdy-investigation.md`.

## How it uses Telegraph

Telegraph purchases are optional and off unless `RECKON_BUY=1`. When on, Reckon pays per ask from a Telegraph escrow balance on the testnet node (Sepolia test USDC), using the signed 402 escrow flow. The page labels bought rows as live, testnet.

- Supply: miner 7310060 (`TOKEN_TOTAL_SUPPLY_VERIFY_GENERAL`)
- SEC filings: miner 731003 (`REGULATORY_FILING_MONITOR_GENERAL`)
- Sanctions (`SANCTIONS_SCREENING_MATCH_GENERAL`): third-party miners tried in the order set in `SANCTIONS_CHAIN` (`src/telegraph.ts`), stopping at the first proper answer. A failed or unreadable answer is never treated as clear.

Free public reads run every `RECKON_INTERVAL_MIN` minutes. Paid legs run on their own schedule: at most every `RECKON_BUY_INTERVAL_MIN` minutes, up to `RECKON_BUY_CAP_USD` per pass and `RECKON_BUY_DAILY_USD` per UTC day, and only while the signer's escrow balance is at least `RECKON_BUY_MIN_BALANCE_USD`. Between paid passes the page shows the last purchase again, labelled with when it was bought.

The Frontier comparison tab sets Reckon's live reading beside the answers of three Claude models that were asked the same five USTB questions with no tools. See the tab for the method and limits.

## Run it

Requires Node 22.18 or newer.

```
npm ci
npm test
RECKON_MODE=recorded node src/server.ts     # replays real responses captured on 2026-11-23, no network
RECKON_MODE=live PORT=8791 node src/server.ts
node src/cli.ts once --recorded             # one pass, printed to the terminal
node scripts/record.ts                      # capture a new read-only fixture
```

| Variable | Meaning | Default |
| --- | --- | --- |
| `RECKON_MODE` | `live` or `recorded` | `recorded` |
| `PORT`, `HOST` | server address | `8791`, `127.0.0.1` |
| `RECKON_DATA` | where snapshots and history are kept | `data` |
| `RECKON_INTERVAL_MIN` | free read interval | `15` |
| `RECKON_BUY` | `1` turns Telegraph purchases on | off |
| `RECKON_SIGNER_KEY` | escrow signer key (hex). Keep it in the environment only | none |
| `RECKON_SIGNER_MODULE` | alternative: a local module exporting `{ address, personalSign }` | none |
| `RECKON_BUY_CAP_USD` | spend cap per paid pass | `0.25` |
| `RECKON_BUY_INTERVAL_MIN` | minutes between paid passes | `60` |
| `RECKON_BUY_DAILY_USD` | daily spend ceiling | `3.50` |
| `RECKON_BUY_MIN_BALANCE_USD` | escrow floor below which buying stops | `1` |

## Limits

- Agreement between the chain and an issuer's page is agreement with the issuer's own ledger. It is not an audit and does not prove the underlying assets exist.
- Issuer pages are read as published. The USTB page data comes from an undocumented endpoint, so the rows that depend on it fail closed if it changes.
- Solana cannot read an account at a chosen slot. The two RPC reads are pinned to the lowest finalized slot the nodes report and must be identical.
- Ondo documents its bridge as burn-and-mint, so the cross-chain sum should not double count bridged tokens, but the sum still exceeds the issuer's figure by about 20%. Two Stellar accounts holding 447M USDY match the size of the gap; nothing public says who controls them, so they are shown beside the result and not subtracted. Sui, Aptos, Stellar and Tempo are read from a single endpoint.
- BUIDL has no issuer figure to reconcile, and USDY's attestation PDFs cannot be read.
- Reckon reports readings and cross-checks. It is not investment advice.
