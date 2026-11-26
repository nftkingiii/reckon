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
- Capture time (data/fetched_at.txt): 2026-11-26T04:32:54Z for API JSON; page screenshots 04:32-04:40 UTC. The server had just redeployed (about 04:28 UTC), so history holds ONE snapshot per asset: "Controls against the previous snapshot" shows Cannot check (first snapshot). No mint/diff event exists in history, so the film has NO "Reckon caught a mint" beat. USTB's "7 mints (128,211.113356)" in the activity row is a 12-transaction window 2026-11-12..2026-11-25 and is shown only as that.
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
