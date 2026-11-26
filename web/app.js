const app = document.getElementById("app");
const tabs = [...document.querySelectorAll(".tabs a")];

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const when = (iso) => (iso ? `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC` : "n/a");
const WORD = { pass: "Established", flag: "Flagged", hold: "Cannot check" };
const GROUPS = [
  ["chain", "On chain"],
  ["issuer", "Issuer figures"],
  ["regulatory", "Regulators"],
  ["entity", "Entities"],
  ["telegraph", "Bought through Telegraph"],
];

let state = null;
const cache = {};
let selected = "ustb";

async function api(path) {
  const r = await fetch(path, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`${path} answered ${r.status}`);
  return r.json();
}

function modeStrip() {
  const s = state;
  const st = s.buy.status;
  const buy = !s.buy.enabled
    ? "Telegraph purchases are off. Rows marked not bought are not results."
    : st
      ? `Telegraph purchases are on (${s.buy.label}). Paid legs run at most every ${st.intervalMin} minutes, up to $${st.passCapUsd.toFixed(2)} a pass and $${st.dailyUsd.toFixed(2)} a day. Spent today $${st.spentTodayUsd.toFixed(2)}. Escrow ${st.escrowAvailableUsd === null ? "balance unreadable" : "$" + st.escrowAvailableUsd.toFixed(2)}. Last paid pass ${st.lastPaidAt ? when(st.lastPaidAt) : "none yet"}.${st.paused ? " " + st.paused : ""}`
      : `Telegraph purchases are on (${s.buy.label}), capped at $${s.buy.capUsd.toFixed(2)} per pass.`;
  if (s.mode === "recorded") {
    return `<div class="mode recorded" role="note">
      <div class="row"><span class="tag rec">Recorded</span><strong>Real public responses captured ${esc(when(s.recordedAt))}.</strong></div>
      <div class="muted">Nothing on this page was fetched just now, and ages are measured from the capture time. ${esc(buy)}</div></div>`;
  }
  return `<div class="mode" role="note">
    <div class="row"><span class="tag live">Live</span><strong>Public reads, last pass ${esc(when(s.lastRunAt))}.</strong></div>
    <div class="muted">Every ${esc(s.intervalMin)} minutes. ${esc(buy)}</div></div>`;
}

const strip = (checks) => `<div class="strip" role="img" aria-label="${checks.map((c) => `${c.title}: ${WORD[c.status]}`).join("; ")}">${checks.map((c) => `<i class="${c.status}" title="${esc(c.title)}: ${WORD[c.status]}"></i>`).join("")}</div>`;
const counts = (c) => `<div class="counts"><span><i class="dot pass"></i>${c.pass} established</span><span><i class="dot flag"></i>${c.flag} flagged</span><span><i class="dot hold"></i>${c.hold} cannot check</span></div>`;

function card(a, primary) {
  const r = a.report;
  const body = r
    ? `${strip(r.strip)}${counts(r.counts)}${r.flagged.map((f) => `<p class="finding">${esc(f.length > 260 ? f.slice(0, 257) + "..." : f)}</p>`).join("")}`
    : `<p class="muted">No pass has finished yet.</p>`;
  const left = `<div class="col"><div><h2>${esc(a.name)}</h2><p class="sub">${esc(a.fund)}</p></div><p class="mint">${esc(a.mint)}</p></div>`;
  const right = `<div class="col">${body}</div>`;
  return `<article class="card ${primary ? "primary" : ""}">
    ${left}${right}
    <div class="card-foot" style="${primary ? "grid-column:1/-1" : ""}"><span>${r ? `Read ${esc(when(r.generatedAt))}` : ""}</span><a class="btn" href="#detail/${a.id}">Open ${esc(a.symbol)} detail</a></div>
  </article>`;
}

function renderAssets() {
  const list = state.assets;
  app.innerHTML = `
    <div class="stack"><h1>What the chain says against what issuers publish</h1>
    <p class="muted" style="max-width:64ch">Three tokenized funds on Solana. Each is read on chain, then compared with the issuer's own figures, regulator records and entity registers. Every row names its source and says plainly when it cannot be checked.</p></div>
    ${modeStrip()}
    <div class="grid">${list.map((a, i) => card(a, i === 0)).join("")}</div>
    ${state.errors.length ? `<div class="err">${state.errors.map((e) => `${esc(e.assetId)}: ${esc(e.error)}`).join("<br>")}</div>` : ""}`;
}

function kv(values) {
  const e = Object.entries(values || {});
  if (!e.length) return "";
  return `<div><div class="sub-h">Values</div><dl class="kv">${e.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v === null ? "n/a" : v)}</dd></div>`).join("")}</dl></div>`;
}

function sources(list) {
  if (!list?.length) return "";
  return `<div><div class="sub-h">Sources and fetch times</div><ul class="src">${list
    .map((s) => `<li><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.name)}</a><br>fetched ${esc(when(s.fetchedAt))}${s.sha256 ? `, sha256 ${esc(s.sha256.slice(0, 16))}` : ""}${s.note ? `<br>${esc(s.note)}` : ""}</li>`)
    .join("")}</ul></div>`;
}

function telegraph(t) {
  if (!t) return "";
  const head = t.chain && t.chain.length > 1
    ? `<div><b>${esc(t.intent)}</b>. Miners tried in order, stopping at the first proper answer: ${t.chain.map((m) => `${esc(m.id)} ${esc(m.name)}`).join(", then ")}. Estimated $${t.estCostUsd.toFixed(2)}.</div>`
    : `<div><b>${esc(t.intent)}</b> via miner ${esc(t.minerId)}, ${esc(t.minerName)}. Estimated $${t.estCostUsd.toFixed(2)}.</div>`;
  if (t.state === "not-bought") return `<div class="tg"><div><span class="tag">${t.reason && t.reason.startsWith("BUY mode is off") ? "Not bought (demo)" : "Not bought this pass"}</span></div>${head}<div>${esc(t.reason)}</div></div>`;
  const calls = t.calls
    .map((c) => `<div>${esc(c.subject)}: ${esc(c.outcome)}${c.outcome === "answered" && t.chain && t.chain.length > 1 ? ` by miner ${esc(c.minerId)}` : ""}${(c.attempts || []).filter((x) => x.outcome !== "answered").map((x) => `<br>miner ${esc(x.minerId)} ${esc(x.outcome)}${x.note ? ": " + esc(x.note) : ""}`).join("")}${c.costUsd !== undefined ? `, $${c.costUsd}` : ""}${c.answeredAt ? `, answered ${esc(when(c.answeredAt))}` : ""}${c.receipt?.receiptHash ? `<br><span class="mono">receipt ${esc(c.receipt.receiptHash)}</span>` : ""}${c.note ? `<br>${esc(c.note)}` : ""}</div>`)
    .join("");
  const carried = t.carriedFrom ? `<div>Bought ${esc(when(t.carriedFrom))}. No paid pass ran this time, so this is the earlier purchase shown again.</div>` : "";
  return `<div class="tg bought"><div><span class="tag paid">${t.state === "bought" ? "Bought" : "Failed"} · live · testnet (Sepolia test USDC)</span></div>${head}${carried}${calls}</div>`;
}

function checkRow(c) {
  return `<details class="check" ${c.status === "flag" ? "open" : ""}>
    <summary><i class="dot ${c.status}"></i><span class="ttl"><b>${esc(c.title)}</b><span class="state ${c.status}">${WORD[c.status]}</span>${c.telegraph && c.telegraph.calls.length ? `<span class="tag paid">bought · testnet${c.telegraph.carriedFrom ? " · earlier pass" : ""}</span>` : ""}</span><span class="sum">${esc(c.summary)}</span></summary>
    <div class="body">${c.missing ? `<p><b>Missing:</b> ${esc(c.missing)}</p>` : ""}${kv(c.values)}${telegraph(c.telegraph)}${sources(c.sources)}</div>
  </details>`;
}

function list(items, empty) {
  if (!items.length) return `<ul><li>${esc(empty)}</li></ul>`;
  const shown = items.slice(0, 6);
  return `<ul>${shown.map((x) => `<li>${x}</li>`).join("")}</ul>${items.length > shown.length ? `<p class="more">and ${items.length - shown.length} more in the checks below</p>` : ""}`;
}

function history(h) {
  if (!h.length) return `<p class="muted">No snapshots yet.</p>`;
  return `<div class="hist">${h
    .map(
      (e) => `<div class="h"><span>${esc(when(e.at))}</span><span class="mono">${esc(e.hash.slice(0, 12))}</span><span>${
        e.changes.length ? e.changes.map((c) => `<div class="chg ${c.severity === "flag" ? "flag" : ""}">${esc(c.path)}: ${esc(c.before)} to ${esc(c.after)}${c.severity === "flag" ? " (flag)" : ""}</div>`).join("") : `<span class="muted">No change in watched fields. ${e.mode === "recorded" ? "Recorded run." : ""}</span>`
      }</span></div>`,
    )
    .join("")}</div>`;
}

async function renderDetail(id) {
  selected = id;
  const seg = `<div class="seg" role="group" aria-label="Asset">${state.assets.map((a) => `<button data-id="${a.id}" aria-pressed="${a.id === id}">${esc(a.symbol)}</button>`).join("")}</div>`;
  app.innerHTML = `<h1>Asset detail</h1>${seg}${modeStrip()}<p class="muted">Loading ${esc(id)}</p>`;
  bindSeg();
  let data;
  try {
    data = cache[id] = await api(`/api/assets/${id}`);
  } catch (e) {
    app.querySelector("p.muted:last-child").outerHTML = `<div class="err">No report for ${esc(id)} yet: ${esc(e.message)}</div>`;
    return;
  }
  const r = data.report;
  const groups = GROUPS.map(([k, label]) => {
    const rows = r.checks.filter((c) => c.group === k);
    return rows.length ? `<section class="group"><h3>${label}</h3>${rows.map(checkRow).join("")}</section>` : "";
  }).join("");
  const cannot = r.cannotCheck.map((x) => `<b>${esc(x.what.charAt(0).toUpperCase() + x.what.slice(1))}</b>. ${esc(x.why)}`);
  const est = r.established.map((x) => esc(x.length > 220 ? x.slice(0, 217) + "..." : x));
  const flg = r.flagged.map((x) => esc(x));
  app.innerHTML = `
    <h1>Asset detail</h1>${seg}${modeStrip()}
    <section class="head">
      <h2>${esc(r.name)}</h2>
      <p class="muted">${esc(data.spec.fund)}</p>
      <p class="mint">${esc(r.mint)}</p>
      ${strip(r.checks)}
      ${counts(r.counts)}
      <div class="meta"><span>Read <b>${esc(when(r.generatedAt))}</b></span><span>Snapshot <b class="mono">${esc(r.snapshotHash.slice(0, 12))}</b></span><span>Previous <b class="mono">${esc((r.previousHash || "none").slice(0, 12))}</b></span></div>
      <div class="meta"><a class="btn" href="/api/assets/${id}/report.json" download>Download report (JSON)</a><a class="btn" href="/api/assets/${id}/report.md" download>Download report (Markdown)</a></div>
    </section>
    <div class="three">
      <div class="panel"><h3><i class="dot pass"></i>Established</h3>${list(est, "Nothing established yet")}</div>
      <div class="panel"><h3><i class="dot flag"></i>Flagged</h3>${list(flg, "Nothing flagged")}</div>
      <div class="panel"><h3><i class="dot hold"></i>Cannot be checked, and why</h3>${list(cannot, "Nothing missing")}</div>
    </div>
    <section class="group"><h2>Checks</h2>${groups}</section>
    <section class="group"><h2>History of snapshots and diffs</h2>${history(data.history)}</section>`;
  bindSeg();
}

function bindSeg() {
  app.querySelectorAll(".seg button").forEach((b) => b.addEventListener("click", () => (location.hash = `#detail/${b.dataset.id}`)));
}

async function renderFrontier() {
  app.innerHTML = `<h1>Frontier comparison</h1><p class="muted">Loading</p>`;
  const f = await api("/api/frontier");
  const r = f.results;
  const ran = r.status === "run";
  const cellFor = (qid, m) => {
    const a = r.answers?.[qid]?.[m.id];
    if (!a) return `<td data-l="${esc(m.name)}" class="na">Not run</td>`;
    return `<td data-l="${esc(m.name)}"><span class="tag out-${esc(a.outcome.replace(" ", "-"))}">${esc(a.outcome)}</span>${a.text ? `<div class="muted" style="font-size:13px;margin-top:8px">${esc(a.text)}</div>` : ""}</td>`;
  };
  const models = ran ? r.models : [];
  const head = `<th>Question</th><th>Reckon (live)</th>${ran ? models.map((m) => `<th>${esc(m.name)}</th>`).join("") : "<th>Model answers</th>"}`;
  const rows = f.rows
    .map(
      (q, i) => `<tr>
        <td data-l="Question"><span class="mono muted">${i + 1}</span> ${esc(q.text)}</td>
        <td data-l="Reckon (live)">${q.truth ? `${esc(q.truth)}<div class="muted" style="font-size:13px;margin-top:4px">${esc(String(q.basis).replace(/\.$/, ""))}. As of ${esc(q.asOf && q.asOf.length > 10 ? when(q.asOf) : q.asOf)}.</div>` : `<span class="muted">No reading available. ${esc(q.basis)}</span>`}</td>
        ${ran ? models.map((m) => cellFor(q.id, m)).join("") : `<td data-l="Model answers" class="na">Not run</td>`}</tr>`,
    )
    .join("");
  app.innerHTML = `
    <div class="stack"><h1>Frontier comparison</h1>
    <p class="muted" style="max-width:64ch">${ran ? "The same five questions about USTB, put to three models with no tools and no live data, set beside what Reckon reads live." : esc(f.about)}</p></div>
    <div class="mode ${ran ? "" : "recorded"}" role="note"><div class="row"><span class="tag">${ran ? "Run " + esc(r.runDate) : "Not run"}</span><strong>${ran ? "Model answers are from one run per model on this date." : "No model has been called."}</strong></div><div class="muted">${esc(ran ? "Reckon's column is its current live reading, not the value from the run date." : r.note)}</div></div>
    <div class="tablewrap"><table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>
    ${ran ? `<section class="prose"><h2>Result</h2><p>${esc(r.result)}</p>
      <h2>Method</h2><p>${esc(r.method)}</p>
      <h2>Scoring</h2><ul>${r.scoring.map(([k, v]) => `<li><b>${esc(k)}</b>: ${esc(v)}</li>`).join("")}</ul>
      <h2>Limits</h2><p>${esc(r.limits)}</p></section>` : `<section class="prose"><h2>How the comparison will be graded</h2>
      <ul><li>Dates and addresses: exact match.</li><li>Numbers: ${esc(f.grading.numbers)}.</li><li>Three outcomes are counted separately: ${f.grading.outcomes_counted_separately.map(esc).join(", ")}.</li><li>${esc(f.grading.note)}</li></ul></section>`}`;
}

function renderHow() {
  const b = state.buy;
  const plan = b.plan.map((p) => `<tr><td data-l="Asset">${esc(p.assetId.toUpperCase())}</td><td data-l="Asks per pass">${p.asks}</td><td data-l="Estimated cost">$${p.estUsd.toFixed(2)}</td></tr>`).join("");
  const total = b.plan.reduce((a, p) => a + p.estUsd, 0);
  const miners = b.miners.map((m) => `<tr><td data-l="Intent">${esc(m.intent)}</td><td data-l="Miner">${esc(m.id)}, ${esc(m.name)}</td></tr>`).join("");
  app.innerHTML = `
    <h1>How it works</h1>
    ${modeStrip()}
    <div class="prose">
      <p>Reckon reads a tokenized fund from several independent places and checks that they agree. It does not audit anything and gives no advice. A row says what was read, from where, when, and whether it matched.</p>

      <h2>What the three states mean</h2>
      <ul>
        <li><b>Established</b>: the check ran and the sources agree within a stated tolerance.</li>
        <li><b>Flagged</b>: the check ran and found a difference, a change, or a stale figure.</li>
        <li><b>Cannot check</b>: the check could not run. The row names what is missing. This is never hidden inside a pass.</li>
      </ul>

      <h2>The checks</h2>
      <ul>
        <li><b>Mint state.</b> Supply, decimals, mint and freeze authority and Token-2022 extensions (permanent delegate, default account state, transfer hook) are read on two public Solana RPCs. If they disagree, nothing from that read is used. Solana cannot read an account at a chosen slot, so the two reads are pinned to the lowest finalized slot the nodes report and must be identical.</li>
        <li><b>Changes.</b> Every pass is stored with a hash. Authority or extension changes against the previous snapshot are flags; supply changes are recorded as information.</li>
        <li><b>Recent activity.</b> Recent signatures on the mint are fetched and the newest ones classified as mints, burns, freezes and authority changes.</li>
        <li><b>Issuer reconciliation.</b> For USTB, on-chain supply is compared with the issuer's tokens per network, shares times NAV with reported assets, and the as-of dates with staleness limits. For USDY, supply summed across chains is compared with the issuer's two published figures. For BUIDL there is no issuer data page to compare with, and the row says so.</li>
        <li><b>Regulators.</b> SEC filings for the fund's CIK. EDGAR refuses undeclared clients and Reckon does not disguise itself, so this check is bought through Telegraph's SEC miners.</li>
        <li><b>Entities.</b> GLEIF is read directly for pinned LEIs. Sanctions screening of the issuer, adviser, custodian and administrator is bought through Telegraph.</li>
        <li><b>Independent supply.</b> A Telegraph miner is asked for the same supply and the answer is set beside Reckon's own read.</li>
      </ul>

      <h2>Data modes</h2>
      <ul>
        <li><b>Live</b> reads public sources every ${esc(state.intervalMin ?? 15)} minutes.</li>
        <li><b>Recorded</b> replays real responses captured on a stated date. Nothing is fetched, and the page says so at the top.</li>
        <li>A source that fails turns its rows into Cannot check. It never falls back to older data without saying so.</li>
      </ul>

      <h2>Telegraph purchases</h2>
      <p>${b.enabled ? `Purchases are on for this server, capped at $${b.capUsd.toFixed(2)} per pass.` : "Purchases are off. The asks are implemented, each row shows which miner would be asked and the estimated cost, and none of those rows is a result."} A quote is read from each 402 challenge, a spend cap stops further asks, and Reckon holds no key: a signer module supplied by the operator signs.</p>
      <div class="tablewrap"><table><thead><tr><th>Intent</th><th>Miner</th></tr></thead><tbody>${miners}</tbody></table></div>
      <div class="tablewrap"><table><thead><tr><th>Asset</th><th>Asks per pass</th><th>Estimated cost at $${b.askUsd.toFixed(2)} per ask</th></tr></thead><tbody>${plan}<tr><td data-l="Asset"><b>All</b></td><td data-l="Asks per pass">${b.plan.reduce((a, p) => a + p.asks, 0)}</td><td data-l="Estimated cost">$${total.toFixed(2)}</td></tr></tbody></table></div>
      <p class="muted">The $${b.askUsd.toFixed(2)} figure is what one ask cost on the Telegraph testnet node. Real quotes come from the 402 challenge and have not been confirmed.</p>

      <h2>What Reckon cannot do</h2>
      <ul>
        <li>Agreement between the chain and an issuer's page is agreement with the issuer's own ledger. It is not independent proof that assets exist.</li>
        <li>The issuer pages are scraped. The USTB page data comes from an undocumented endpoint, so rows that depend on it fail closed if it changes.</li>
        <li>Summing a token's supply across chains can count a bridged token twice.</li>
        <li>Tests include synthetic faults (a changed authority, disagreeing RPCs, a stale date). They are labelled synthetic and never appear in reports.</li>
      </ul>
    </div>`;
}

async function route() {
  const [tab, arg] = (location.hash.replace(/^#/, "") || "assets").split("/");
  const current = ["assets", "detail", "frontier", "how"].includes(tab) ? tab : "assets";
  tabs.forEach((t) => t.setAttribute("aria-selected", String(t.dataset.tab === current)));
  try {
    state = await api("/api/state");
    if (current === "assets") renderAssets();
    else if (current === "detail") await renderDetail(["ustb", "buidl", "usdy"].includes(arg) ? arg : selected);
    else if (current === "frontier") await renderFrontier();
    else renderHow();
  } catch (e) {
    app.innerHTML = `<div class="err">Could not load: ${esc(e.message)}</div>`;
  }
}

addEventListener("hashchange", () => {
  route();
  scrollTo(0, 0);
});
route();
