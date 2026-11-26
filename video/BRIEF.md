# Reckon walkthrough film: brief

## Goal
- Kind: judge walkthrough, about 90-120 s, 16:9 at 30 fps, plus a ~30 s 9:16 cut. Captions only, synthesized sound mixed to -16 LUFS.
- Audience: Telegraph/Anjoman organisers (they asked to "finalise Reckon and the walkthrough video"), then judges and builders.
- The one thing to understand: Reckon checks tokenized treasuries on Solana against what issuers and regulators publish, every 15 minutes, buys the checks it cannot do itself through Telegraph every hour (receipts on screen), and says plainly what it cannot check.
- Not to be posted, uploaded or published by this run. Local files only.
- Look: Reckon's own UI palette (bg #0b1017, surface #111823, text #e4eaf2, blue accent #6c9cff, pass #46c2a3, flag #ff7357, hold #8b9bb3), its own faces (Public Sans, Plex Mono; fonts copied from Reckon/web/fonts).

## Story (98 s master, 41 bars of 2.4 s at 100 BPM)
1 hook, 2 institutional framing (who needs this), 3 Assets page + 15 min cadence, 4 the checks, 5 what it buys hourly (receipts), 6 USTB, 7 BUIDL, 8 USDY flagged, 9 USDY investigation (PENDING: live capture after the other agent deploys it), 10 Holdings tab (PENDING), 11 frontier comparison (live tab), 12 end card.

## Evidence capture
- All product screens: Playwright (Edge) against https://reckon-app.up.railway.app, desktop 1280x800 css, DPR 2, GET only, read-only. Scripts: shots.mjs, shots2.mjs. Output assets/cap/*.png, meta.json, crops.json.
- FINAL RE-CAPTURE 2026-11-26 09:46-10:00 UTC (Reckon commit 5a07fd0 deployed): API JSON fetched 09:47:56Z (data/), all page screenshots re-taken 09:51-09:57 UTC (assets, detail pages, row crops, Holdings, USDY doc). Values below marked [final] are from that capture and supersede the 04:32 values in the earlier rows.
- First capture time (superseded): 2026-11-26T04:32:54Z for API JSON; page screenshots 04:32-04:40 UTC. The server had just redeployed (about 04:28 UTC), so history holds ONE snapshot per asset: "Controls against the previous snapshot" shows Cannot check (first snapshot). No mint/diff event exists in history, so the film has NO "Reckon caught a mint" beat. USTB's "7 mints (128,211.113356)" in the activity row is a 12-transaction window 2026-11-12..2026-11-25 and is shown only as that.
- Values move: the film uses the capture values below. Re-read and update before final assembly if captures are redone.

## Truth sheet (the film may only show what is here)
| Claim / number | Evidence | Status |
|---|---|---|
| Reckon reads every 15 min on two Solana RPCs; paid legs at most every 60 min, up to $0.25/pass, $3.50/day; spent today $0.14, escrow $9.32 at 04:32 UTC | live page mode strip (assets.png, how-top.png), /api/state fetched 04:32 UTC | live, testnet (Sepolia test USDC) |
| Paid checks: SEC filing (Counterproof 731003), sanctions (710637, then 731002, 84392, 64175, 731149), independent supply (Plumb 7310060) | How it works page; /api/assets/*.json check rows | live; Plumb is OUR OWN miner so consistency only |
| USTB: 12 established, 0 flagged, 1 cannot check (first snapshot) | /api/assets/ustb read 2026-11-26T04:30:35Z | live |
| USTB Solana supply 110538.81498 (two RPCs agree); Solana, Ethereum and Plume reconcile exactly with the issuer's tokens | ustb row summaries | live |
| USTB NAV x tokens: implied NAV/share 11.2929; network values add to $670,061,005.75 vs reported $670,061,007 | row issuer-nav-aum | live |
| USTB: newest SEC filing 2026-07-14, no new filing; receipt 0x91f10f57... via 731003 at $0.01 | row filings | live, bought, testnet |
| USTB: 5 names screened, no match; 5 receipts at $0.01 via 710637 (0x52017333..., 0x03416f61..., 0x5efe81e0..., 0xff14380c..., 0xac86b87d...) | row sanctions | live, bought, testnet |
| USTB: Plumb 7310060 reports 110,538.81498 = Reckon's read (receipt 0x0c7d4d29...) | row tg-supply | live, bought, testnet, OWN miner |
| BUIDL: 7 established, 0 flagged, 2 cannot check; no official issuer data page, so supply has nothing to reconcile with | /api/assets/buidl 04:31:47Z, row issuer-data | live |
| USDY: 7 established, 2 flagged, 4 cannot check | /api/assets/usdy 04:32:21Z | live |
| USDY (rows as captured): 12 chains, 2,058,127,992 tokens x 1.1545 = $2,376,091,803 vs issuer's $1,970,000,000 outstanding (+20.6%); a cross-chain sum can count bridged tokens twice, so NOT proof of over-issuance | row issuer-supply | live; row may be reworked by another agent |
| USDY: page states collateralization 156.90%, own figures give 122.34% ($2,410,000,000 / $1,970,000,000); footnote unreadable; a finding to explain, not a proven error | row issuer-arithmetic | live |
| Frontier comparison: 5 USTB questions, Claude Opus 5.5 / Sonnet 5.5 / Haiku 5.5, tools off, one run each, run 2026-11-26: 0 exact of 15, 1 partly right (Opus guessed Token-2022, default frozen), the rest honest abstentions; Reckon answers all five live. Limits: one run per model, Claude models only, tools off, questions and truth written by us, truth from Reckon's own reads | live Frontier tab + research/reckon-frontier-results.md | live page; run 2026-11-26 |
| Frontier "Reckon (live)" column is the current reading, not the run-date value (supply was 81,654.762282 at run time) | the page's own note | shown as the page shows it |
| End card: reckon-app.up.railway.app, github.com/nftkingiii/reckon | repo remote, live URL | live |
| USDY investigation (adjusted circulating vs issuer outstanding, residual) | PENDING: another agent is adding it; capture from the live site once deployed | PLACEHOLDER (red) |
| Holdings tab (wallet balance, value, frozen status, risk flags) | PENDING: another agent is adding it; capture from the live site | PLACEHOLDER (red) |
- Must be labelled: testnet / Sepolia test USDC on every paid-receipt shot; Plumb = our own miner; USDY gap is not proof of over-issuance; frontier limits line.
- Never shown: any claim that Reckon audits, gives advice, or has institutional customers. The institutional beat is framed as who it is built for.

## Sound
Synthesized (sfx.mjs): ticks and clicks on UI contact, soft thump on bar starts at low level, no samples, no music track. Mixed to -16 LUFS.

## Gates
1 brief (taken from the coordinator's brief; no live user to confirm) · 2 shot list · 3 review rounds in docs/review_log.md · 4 verify deterministic · 5 render + mix + check · 6 deliverables in out/.

## Final-capture truth sheet additions [final], 2026-11-26 09:46-09:57 UTC
| Claim / number | Evidence | Status |
|---|---|---|
| Counts: USTB 12 established / 0 flagged / 1 cannot check; BUIDL 7 / 0 / 2; USDY 8 / 2 / 3 | /api/assets/* reports generated 09:46:03Z, 09:46:37Z, 09:47:02Z | live |
| USTB NAV x tokens: network values add to $672,651,373.82 vs reported $672,651,375; implied NAV 11.2932 | row issuer-nav-aum, 09:46Z | live |
| USDY reworked row: raw sum 2,058,136,174 tokens ($2,376,154,709) less 0 locked in bridges, 0 at Ondo-listed addresses, 0 wrapper double counts = residual +$406,154,709 (+20.6%) vs issuer's $1,970,000,000, "unexplained by documented adjustments" | usdy-flag1.png (page 09:53 UTC) | live |
| USDY: two Stellar accounts hold 447,289,749 tokens ($516,403,946); one alone is 100.4% of the raw gap; nothing public says who controls them (a lead, not a finding) | same row text | live; inference |
| USDY doc: "1. Bridged supply counted twice. Closes 0 tokens (upper bound 3.2M, under 1%)" | https://reckon-app.up.railway.app/docs/usdy-investigation.md, usdy-doc.png | live |
| USDY 156.90% vs 122.34%: footnote 5 says the ratio excludes US Treasuries used for structured financing (Opt-Out Lender Underlyings), so it is computed on a different base and cannot be reproduced from the headline figures | usdy-flag2.png | live |
| Holdings tab, built-in EXAMPLE addresses only (public chain data, owner unknown): example USTB holder 110,486.371703 USTB, $1,247,741 at 11.2932, not frozen, 99.9526% of Solana USTB supply; example USDY holder 833,809.918745 USDY, $962,648 at 1.1545, not frozen, 12.2379% of Solana USDY supply; asset findings (the USDY residual and footnote finding) listed under the position | holdings-both.png, read 09:57 UTC | live |
- No private address was entered anywhere.
