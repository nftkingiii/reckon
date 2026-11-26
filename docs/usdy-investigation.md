# USDY: why the chains and Ondo's page disagree

Investigated 2026-11-25 and 2026-11-26. Every number below was read from a public source named next to it. This is an investigation of a numerical discrepancy. It makes no claim about anyone's conduct, and where a finding rests on inference it says so.

## The discrepancy

Reckon reads USDY on 12 chains (Solana, six EVM chains, Sui, Aptos, Noble, Stellar, Tempo), each on two or more endpoints where the chain allows it, and multiplies by the on-chain oracle price.

| Figure | Value |
| --- | --- |
| Tokens summed across 12 chains (pass of 2026-11-26) | 2,058,136,174.42 |
| On-chain price (Ondo oracle wrapper, Ethereum) | 1.154516 |
| Value of those tokens | $2,376,150,648 |
| Ondo page, "Value of USDY Outstanding" (as of 2026-11-24 6:59:59pm EST) | $1.97B |
| Gap | +$406.15M, +20.6% |
| Same gap in tokens ($1.97B / 1.154516 = 1,706,342,744) | 351.8M tokens |
| The page's own "Current TVL" | $2.38B (0.2% from the chain sum) |
| The page's "Value of Underlying Assets" | $2.41B (positions table: $2,409,386,722) |
| Stated collateralization ratio | 156.90% |
| Ratio recomputed from the page's own figures ($2.41B / $1.97B) | 122.34% |

The page rounds to three significant figures, so "1.97B" is anywhere in $1.965B to $1.975B. That moves the token gap between 347.5M and 356.1M. Anything below is judged against that band.

Sources: https://ondo.finance/usdy (HTML, fetched 2026-11-25 and in each Reckon pass), https://docs.ondo.finance/addresses.md, the chain reads listed per hypothesis. Reckon's recorded run, `fixtures/recorded.json.gz`, holds the raw responses.

## Method

For each hypothesis: state it, find the addresses involved from Ondo's own documents or from chain data, read the balances on the chain, and say how many of the 351.8M tokens (or $406M) it closes. Evidence is graded:

- Documented: the address is named by Ondo in its docs table, its `stellar.toml`, or its page.
- Inferred: the address is linked to Ondo only by on-chain behaviour. Inferred links are shown beside the result and are never subtracted from it.

## Hypotheses, in the order tested

### 1. Bridged supply counted twice. Closes 0 tokens (upper bound 3.2M, under 1%)

- Ondo's bridge page says it uses LayerZero's OFT standard "to allow users to burn and mint native USDY ... on all supported chains" (https://docs.ondo.finance/tools/ondo-bridge.md). Burn and mint leaves no escrow to subtract. Chains named: Arbitrum, BSC, Ethereum, Mantle, Sei, Solana, Stellar, Tempo. Stellar connects only to Ethereum.
- Ondo's address table lists no lockbox, escrow, adapter or bridge-vault address for USDY (Reckon checks the table for those words on every pass; none today).
- On chain, bridging shows as burns and mints to the zero address. Example, Ethereum Safe 0xa5b614026dcb1ef6e0e39aa53351b4f4bd225302 has burns to 0x0 on 2026-01-28 and 2025-08-22 (Ethplorer address history, fetched 2026-11-26).
- Rate limits are 450,000 to 500,000 USDY per day per EVM pathway, 250,000 to 300,000 for Solana, 450,000 to 500,000 for Stellar to Ethereum (same page). At that rate a 350M-token transfer would take about two years, so bridging cannot account for tokens appearing on a chain in a lump.
- The largest place a Stellar escrow could hide is Stellar's contract balances: Horizon reports 3,224,710 USDY held by all 66 contracts together (https://horizon.stellar.org/assets?asset_code=USDY&asset_issuer=GAJMPX5NBOG6TQFPQGRABJEEB2YE7RFRLUKJDZAZGAD5GFX4J7TADAZ6, `contracts_amount`). That is under 1% of the gap even if all of it were a lockbox.

### 2. Wrapped and rebasing variants counted twice. Closes 0 tokens (upper bound 1.9M, 0.5%)

- Reckon adds each chain's USDY `totalSupply` only. It never adds rUSDY or mUSD supply.
- rUSDY (Ethereum 0xaf37c1167910ebC994e266949387d2c7C326b879) holds 1,814,865.05 USDY (`balanceOf`, three Ethereum RPCs agree). Its own total supply is 2,095,248.91 rebased units, which equals 1,814,865.05 USDY at 1.1545.
- mUSD (Mantle 0xab575258d37EaA5C8956EfABe71F4eE8F6397cF3) holds 76,935.43 USDY and has 88,821.41 units outstanding.
- The wrapped USDY is inside the USDY supply once, so nothing double counts in Reckon's sum. If Ondo's "outstanding" excluded wrapped tokens, that would be at most 1,891,800 tokens ($2.2M), 0.5% of the gap.

### 3. Minted but not outstanding: issuer-held addresses. Closes 0 tokens

Reckon now reads the USDY balance of every address Ondo's docs name as an operating address (matching "Redemptions Account" or "InstantManager"):

| Address | Where named | USDY held |
| --- | --- | --- |
| Ethereum USDY_InstantManager 0xa42613C243b67BF6194Ac327795b926B4b491f15 | docs addresses.md | 0 |
| BSC USDY_InstantManager 0x9bA360087075A4Cef548eeD71Eed197bf4cFA4E2 | docs addresses.md | 0 |
| Tempo USDY_InstantManager 0x7E2A9d8B3B97EDa5922cdb320fC96e0ff4C8B4C5 | docs addresses.md | 0 |
| Sui redemptions 0xabebc1a41aa460eb560469e6b3c22d610b44b877979989e5e9227cca5b271fd2 | docs addresses.md | 0 |
| Aptos redemptions 0xcfea864b32833f157f042618bd845145256b1bf4c0da34a7013b76e42daa53cc | docs addresses.md | 0 |
| Noble redemptions noble1c940mn5xm4vykfpts75ul6zx3ngy8ezf8qyvgu | docs addresses.md | 0 |
| Arbitrum redemptions 0xFDE36D55112f5AAaFa5087832AA557CaB7Be1888 | docs addresses.md | 0 |
| Stellar redemptions GC5T3RH2VK3G44FIHMOZY5UGN56L52UYFGHKFUX6X2HNIGEZ2PFXMI23 | docs addresses.md and https://ondo.finance/.well-known/stellar.toml | 0 |

The Ethereum "USDYc" ("Cooking USDY") token, which docs describe as a bookkeeping stand-in before USDY is issued, has total supply 0 (0xe86845788d6e3e5c2393ade1a051ae617d974c09). Its conversions to USDY (for example Ethereum tx 0x2ef493b1bae7aeb94e534f9d472bba6be16958a17fe612e89fee0fac4373fb33 burned 221.6M USDYc and minted 115.2M and 106.4M USDY) are complete. Nothing is left in that state.

### 4. A different definition, price or date. Closes 0 tokens

- Price: the oracle returns 1.154516; the page shows 1.1545. A 0.001% difference.
- Date: the page is as of 2026-11-24 23:59:59 UTC; Reckon read about 26 to 29 hours later. Counting Transfer events from the zero address and to it between the snapshot block and the read: Ethereum minted 140,306 and burned 2,050,936 (net -1.91M tokens); BNB Chain net -339; Arbitrum and Mantle none. Sei could not be checked because the RPC prunes that history (Sei holds 225.7M). Net issuance since the page date is at most slightly negative on the chains that could be checked, so a timing gap works against the gap rather than for it.
- Definition: the page's footnote 3 says "The value of any redemption request is not subtracted from this number until it has been fulfilled." That makes "outstanding" larger than circulating, which widens the gap. Footnote 4 defines underlying assets as "total assets less liabilities".
- TVL: the page's own TVL ($2.38B) matches the chain sum to 0.2%. TVL minus the page's "outstanding" is $410M (plus or minus $10M from rounding): the discrepancy is already inside the page, between its own two headline numbers.

### 5. What the 156.90% means. Explained as a definition; not reproducible

Footnote 5 on the page: "This ratio excludes US Treasury securities used for structured financing and which constitute Opt-Out Lender Underlyings under the Amended and Restated Tokenized Credit and Security Agreement of Ondo USDY LLC."

- The ratio is therefore not $2.41B / $1.97B. Reckon's earlier "recomputed 122.34%" row was comparing against the wrong base, and it now quotes the footnote.
- If only the numerator were reduced by the excluded Treasuries, the ratio would fall below 122%, so it cannot reach 156.90%. To get 156.90% the denominator must shrink by more than the numerator. With the numerator unchanged at $2,409,386,722, the denominator would be $1,535.6M, which is $434M below the headline outstanding. With a larger excluded numerator the excluded amount in the denominator must be larger still.
- The excluded amounts are not published, so the ratio cannot be rebuilt from the page. Reckon lists this under "cannot be checked".
- Against the chain: $2,409.4M underlying over the $2,376.2M value of every token read is 101.4%. If the underlying figure is right, the portfolio covers all tokens on chain, not only the $1.97B.

### 6. What is left: where the 351.8M tokens could sit

Concentration on Stellar, found while checking Stellar's 467.5M tokens (the second largest chain after Ethereum):

- Horizon lists 3,379 accounts with a USDY trustline holding 464,238,269 USDY in all. The top five hold 99.99% of it. Two hold 447.3M:
  - GC635K2GGDMIINZBO6WWLQN6QUVDEBODEYCQ74OLEZUOA37K5E2BXSHC: 353,217,182 USDY.
  - GAY5KWJICHJ5U2QCBRWCPSEF3ARHTNLV4WUOVSCMKSJCET4DBBFANMB2: 94,072,566.67 USDY.
- Payment history (Horizon `/accounts/{id}/payments`, read 2026-11-25): the USDY issuer account GAJMPX5N... paid 461,595,440 USDY in five batches (2026-01-20 to 2026-05-29) to GC5T3RH2..., the account Ondo's docs and `stellar.toml` list. GC5T3 forwarded them on within minutes to accounts that have since held them: 353,217,181 USDY plus a 1 USDY test payment to GC635K on 2026-05-29, and 55,500,873 plus 38,571,692 to GAY5KW on 2026-02-06 and 2026-02-13. GC635K was created by GC5T3. Neither GC635K nor GAY5KW has ever sent any USDY.
- The sizes show these did not arrive through the bridge (which is rate-limited to about 450,000 a day); they are issuer mints to Ondo's listed account.
- GC635K's balance, 353,217,182 USDY, is 100.4% of the 351.8M-token gap (inside the 347.5M to 356.1M rounding band). Priced at 1.154516 it is $407.8M, against a $406.2M gap.

Why this is not subtracted: nothing public says who controls GC635K or GAY5KW. They are single-key accounts with no home domain or label. Both followed the same pattern (a 1 USDY test payment, then the bulk), so if one is issuer inventory the other probably is too, and then subtracting both would overshoot: 2,058.1M less 447.3M is $1,859.7M, which is $110M (5.6%) below the issuer's outstanding. One of the two matching the gap exactly while the pair does not leaves the attribution undecided. Reckon shows both beside the result, labelled as candidates, and reads their balances on every pass so a movement is visible.

Related observations, no link established:

- Ethereum holds 1,100.4M of the 2,058.1M. Eight of its largest holders are 3-of-5 Safes deployed by one address (0x4e1dcf7ad4e460cfd30791ccc4f9c8a4f820ec67) with different owners each, together 893.5M USDY (81% of the Ethereum supply). That pattern is consistent with a custody provider's per-client vaults. Nothing marks them as Ondo's. One of them, 0xa5b614026dcb1ef6e0e39aa53351b4f4bd225302, holds 353,237,484 USDY, within 20,302 tokens (0.006%) of GC635K's balance. We found no mechanism that would copy a balance between the two, and neither has sent tokens out in a way that explains it. It is recorded here as an unexplained coincidence.
- The page lists a $408.9M tokenized SHV position among the underlying assets. Four unrelated figures sit near $406M to $410M: TVL minus outstanding on the page, the chain gap, GC635K at today's price, and that position. No document links them.

## What each explanation closes

| Explanation | Tokens closed | Share of the 351.8M gap | Evidence |
| --- | --- | --- | --- |
| Locked in bridge or escrow | 0 | 0% (at most 0.9%) | Ondo docs: burn and mint; no escrow in the address table |
| Wrapper double counts (rUSDY, mUSD) | 0 | 0% (at most 0.5%) | Reckon never adds wrapper supply; wrapped USDY is 1.89M |
| Held at Ondo-listed addresses | 0 | 0% | Eight addresses, each read, all zero |
| Price or date mismatch | 0 | 0% (works the other way, -0.5%) | Oracle 1.154516 vs 1.1545; net issuance since snapshot negative |
| Documented adjustments in total | 0 | 0% | |
| Candidate: Stellar account GC635K | 353.2M | 100.4% | Issuer mint via Ondo's listed account, never moved; attribution not documented |
| Unexplained by documented evidence | 351.8M | 100% | |

## What Reckon now does

The "Supply across chains against the issuer's value outstanding" row shows, on every pass: the raw sum, less locked in bridges (0), less Ondo-listed holdings (read per address), less wrapper double counts (0), the adjusted circulating supply and its value, the issuer's figure, and the residual in dollars and per cent. The two Stellar accounts appear in the same row as candidates, not applied. Any address that cannot be read is named as not read and is never counted as zero. The row stays Flagged while the residual is above 3%. The arithmetic row quotes footnote 5 instead of calling the ratio an error.

## Limits

- The Ondo page and docs are read as published; Ondo's attestation PDFs sit behind a JavaScript Dropbox listing and were not read.
- Sui, Aptos, Stellar and Tempo are each read from one endpoint. Sei's history before the page date could not be read.
- Ethplorer's holder list (a third-party index) was used to find large Ethereum holders; the balances quoted were then read from Ethereum RPCs.
- "Issuer mint to a listed account, then forwarded" is what the payments show. It does not show who owns the receiving accounts.
- Ondo can resolve this in one sentence by saying which accounts those are. Until then the gap is unexplained by documented evidence, and this document does not claim over-issuance, misreporting, or that either figure is wrong.
