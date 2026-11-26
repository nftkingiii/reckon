// The asset registry. Core checks are shared; the `reader` field picks the issuer module for an asset.
export interface EvmContract {
  chain: "ethereum" | "bsc" | "arbitrum" | "mantle" | "sei" | "plume";
  address: string;
  /** Whether this supply is expected to be listed by the issuer as a separate network row. */
  label: string;
}

export interface EntitySpec {
  role: string;
  name: string;
  /** Pinned only when an LEI was read from GLEIF by a person or a previous run. Never guessed. */
  lei?: string;
  /** Text the GLEIF legal name must contain, so a reassigned LEI is noticed. */
  expectName?: string;
}

export interface FilingBaseline {
  cik: string;
  /** Latest filing known when this registry entry was written. */
  latestForm: string;
  latestDate: string;
  knownFromNote: string;
  telegraphEntity: string;
}

export interface AssetSpec {
  id: "ustb" | "buidl" | "usdy";
  name: string;
  symbol: string;
  issuer: string;
  fund: string;
  solanaMint: string;
  mintListing: { state: "issuer-page" | "issuer-docs" | "unconfirmed"; url: string; note: string };
  evm: EvmContract[];
  reader: "superstate" | "ondo" | "none";
  filings?: FilingBaseline;
  entities: EntitySpec[];
  /** Names to screen through Telegraph SANCTIONS_SCREENING_MATCH_GENERAL (BUY mode). */
  sanctionsNames: string[];
  /** GLEIF name lookups for entities whose LEI is not pinned. */
  leiNameLookups: string[];
  cannotCheck: { what: string; why: string }[];
  /** Issuer-figure drift allowed between our read and the issuer's page, as a fraction of supply. */
  supplyTolerance: number;
  maxIssuerAgeDays: number;
  maxHoldingsAgeDays: number;
}

export const ASSETS: AssetSpec[] = [
  {
    id: "ustb",
    name: "Superstate USTB",
    symbol: "USTB",
    issuer: "Superstate",
    fund: "Invesco Short Duration US Government Securities Fund, a series of Superstate Asset Trust",
    solanaMint: "CCz3SGVziFeLYk2xfEstkiqJfYkjaSWb2GCABYsVcjo2",
    mintListing: {
      state: "issuer-docs",
      url: "https://docs.superstate.com/investors/smart-contracts.md",
      note: "Superstate docs list this mint as the Solana USTB Token 2022; the fund page shows it truncated.",
    },
    evm: [
      { chain: "ethereum", address: "0x43415eB6ff9DB7E26A15b704e7A3eDCe97d31C4e", label: "Ethereum" },
      { chain: "plume", address: "0xE4fA682f94610cCd170680cc3B045d77D9E528a8", label: "Plume" },
    ],
    reader: "superstate",
    filings: {
      cik: "0002004367",
      latestForm: "D/A",
      latestDate: "2026-07-14",
      knownFromNote: "EDGAR company page for CIK 0002004367, read on 2026-11-23 during research (Form D 2024-01-02; D/A 2026-05-05, 2026-07-06, 2026-07-07, 2026-07-14). Reckon did not re-fetch EDGAR.",
      telegraphEntity: "CIK 0002004367 form D",
    },
    entities: [
      { role: "issuer", name: "Superstate Inc.", lei: "254900RYEZ47C0C0YO93", expectName: "SUPERSTATE" },
      { role: "trust", name: "Superstate Asset Trust", lei: "254900HBBFFSKNX6LZ37", expectName: "SUPERSTATE" },
      { role: "investment manager", name: "Invesco Advisers, Inc.", lei: "O37NHJVF7S22I1ONOU83", expectName: "INVESCO ADVISERS" },
    ],
    sanctionsNames: ["Superstate Inc.", "Superstate Asset Trust", "Invesco Advisers, Inc.", "The Bank of New York Mellon", "NAV Fund Services"],
    leiNameLookups: ["The Bank of New York Mellon", "NAV Fund Services"],
    cannotCheck: [
      { what: "Book-entry shares (about 30% of the fund)", why: "They live in Superstate's transfer-agent records, not on any chain. Only the issuer's own table reports them." },
      { what: "That the Treasury bills are held at the custodian", why: "The holdings table is the issuer's and is marked unaudited. No public custodian statement or attestation was found." },
      { what: "The audit", why: "The page names PricewaterhouseCoopers as auditor. No audit report is published where we can read it." },
      { what: "NAV per share against an independent price", why: "The page renders NAV per share client-side and shows a dash. Reckon derives it from value divided by shares. The Pyth USTB oracle account was not read." },
      { what: "Redemption rights and liquidity in practice", why: "Only the issuer's documents describe them. Nothing on chain shows whether a redemption would be honoured." },
      { what: "Form D contents", why: "Filing dates are tracked through Telegraph's SEC miners. The exemption claims and amounts sold inside each filing are not machine-checked." },
    ],
    supplyTolerance: 0.0005,
    maxIssuerAgeDays: 3,
    maxHoldingsAgeDays: 5,
  },
  {
    id: "buidl",
    name: "BlackRock BUIDL",
    symbol: "BUIDL",
    issuer: "Securitize (token platform) for the BlackRock USD Institutional Digital Liquidity Fund",
    fund: "BlackRock USD Institutional Digital Liquidity Fund Ltd.",
    solanaMint: "GyWgeqpy5GueU2YbkE8xqUeVEokCMMCEeUrfbtMw6phr",
    mintListing: {
      state: "unconfirmed",
      url: "https://metadata.securitize.io/buidl.json",
      note: "No official issuer page listing this mint was reached. The mint's on-chain metadata points to Securitize's metadata host, which is a weaker signal than an issuer listing.",
    },
    evm: [],
    reader: "none",
    filings: {
      cik: "0002013810",
      latestForm: "D/A",
      latestDate: "2026-07-27",
      knownFromNote: "EDGAR company page for CIK 0002013810, read on 2026-11-23 during research (Form D 2024-03-18; D/A 2025-07-18, 2026-07-27). Reckon did not re-fetch EDGAR.",
      telegraphEntity: "CIK 0002013810 form D",
    },
    entities: [
      { role: "fund", name: "BlackRock USD Institutional Digital Liquidity Fund Ltd.", lei: "529900P1LBVZISCTYK24", expectName: "BLACKROCK USD INSTITUTIONAL DIGITAL LIQUIDITY FUND" },
      { role: "token platform", name: "Securitize, Inc.", lei: "25490009WOPTX81T8041", expectName: "SECURITIZE" },
    ],
    sanctionsNames: ["BlackRock USD Institutional Digital Liquidity Fund Ltd.", "Securitize, Inc."],
    leiNameLookups: [],
    cannotCheck: [
      { what: "NAV, AUM and holdings", why: "No official issuer data page was reached for BUIDL, so there is nothing published to reconcile the supply against." },
      { what: "That the issuer lists this mint", why: "The mint is confirmed only by its own on-chain metadata and third-party coverage, not by a BlackRock or Securitize page." },
      { what: "Who is on the allowlist", why: "The transfer hook and freeze authority show that transfers are gated. The allowlist itself is not public." },
      { what: "What the transfer hook program does", why: "Reckon reports the program address. It does not read or verify the program's logic." },
      { what: "Share of total BUIDL supply held on Solana", why: "The other chains were not read, and with no issuer total there is nothing to compare a share against." },
    ],
    supplyTolerance: 0.0005,
    maxIssuerAgeDays: 3,
    maxHoldingsAgeDays: 5,
  },
  {
    id: "usdy",
    name: "Ondo USDY",
    symbol: "USDY",
    issuer: "Ondo Finance (USDY, a continuous Regulation S offering)",
    fund: "Ondo US Dollar Yield Token",
    solanaMint: "A1KLoBrKBde8Ty9qtNQUtq3C2ortoC3u7twggz7sEto6",
    mintListing: {
      state: "issuer-docs",
      url: "https://docs.ondo.finance/addresses.md",
      note: "Ondo's address table and its USDY page both list this mint as USDY on Solana.",
    },
    evm: [
      { chain: "ethereum", address: "0x96F6eF951840721AdBF46Ac996b59E0235CB985C", label: "Ethereum" },
      { chain: "bsc", address: "0x608593d17A2decBbc4399e4185bE4922F97eD32E", label: "BNB Chain" },
      { chain: "mantle", address: "0x5bE26527e817998A7206475496fDE1E68957c5A6", label: "Mantle" },
      { chain: "arbitrum", address: "0x35e050d3C0eC2d29D269a8EcEa763a183bDF9A9D", label: "Arbitrum" },
      { chain: "sei", address: "0x54cD901491AeF397084453F4372B93c33260e2A6", label: "Sei" },
      { chain: "plume", address: "0xD2B65e851Be3d80D3c2ce795eB2E78f16cB088b2", label: "Plume" },
    ],
    reader: "ondo",
    entities: [],
    sanctionsNames: ["Ondo USDY LLC", "Ondo Finance Inc."],
    leiNameLookups: ["Ondo USDY LLC", "Ondo Finance Inc."],
    cannotCheck: [
      { what: "Daily and monthly reserve attestations", why: "They are PDFs in public Dropbox folders. The folder listing is a JavaScript page, so Reckon cannot list or read the files." },
      { what: "Who controls the large Stellar accounts", why: "About 447 million USDY (96% of the Stellar supply) sit in two Stellar accounts that Ondo's listed redemptions account funded and that have never sent any. One of them alone is the size of the unexplained gap against the issuer's value outstanding. Nothing public says who controls them, so Reckon shows them beside the result and does not subtract them. See docs/usdy-investigation.md." },
      { what: "Supply on Sui, Aptos, Stellar and Tempo against a second source", why: "Each is read from one endpoint (Noble from two), so a wrong answer there cannot be refused on disagreement the way the two-RPC reads can." },
      { what: "A regulatory filing trail", why: "USDY is a Regulation S offering, so there is no Form D to monitor. No EDGAR filing was found for the USDY issuer." },
      { what: "The collateralization ratio's inputs", why: "Footnote 5 on Ondo's page says the ratio excludes Treasuries used for structured financing. The excluded amounts are not published, so the 156.90% cannot be recomputed from the page." },
      { what: "That the underlying Treasuries and the tokenized SHV exist", why: "The positions table is the issuer's. Only the attestation PDFs could back it, and those are out of reach." },
    ],
    supplyTolerance: 0.0005,
    maxIssuerAgeDays: 5,
    maxHoldingsAgeDays: 5,
  },
];

export const byId = (id: string): AssetSpec | undefined => ASSETS.find((a) => a.id === id);
