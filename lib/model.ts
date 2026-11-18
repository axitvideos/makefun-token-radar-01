// Token Launch Radar — model v2 ("peer-calibrated radar").
//
// One sealed snapshot in, one ranked board out. The board ranks EVERY rankable protocol that
// records no token (289 of the snapshot's 758), not a hand-picked list: the snapshot's watchlist
// (40 protocols at or above the $50M floor) is the floor, and the other 249 rows are the early
// protocols below the floor that a radar exists to find early. Protocols whose token already
// trades are never ranked: they are carried separately as the live comparison set, and — this is
// the heart of the model — they are what calibrates the ranking.
//
// Implied value, per protocol, from the snapshot's own figures only:
//
//   implied = TVL x peerMultiple(category) x growthMult x maturityMult x breadthMult
//
// - peerMultiple(category): the median market-cap / TVL ratio of the snapshot's own live-token
//   protocols in the same category, shrunk toward the median of its functional family
//   (credit / exchange / staking / bridges / allocators / rwa / chain) with weight 4, then
//   clamped to [0.03, 1.50]. Each live ratio is winsorised to [0.02, 1.50] first, so one
//   outlier peer cannot carry a category. A category with no live peers uses its family's
//   median; a family with none uses the global live median. No protocol name is ever
//   special-cased: the same function scores every row, and a future snapshot re-derives
//   every multiple from its own data.
//
// The board also applies the snapshot's own launch screen at every size, not just at the
// watchlist floor: no bridge, canonical bridge, liquid staking, liquid restaking or restaked-BTC
// category, no exchange product, no versioned pool, and no name carrying a whole word wrapped,
// staked or staking. What passes is a protocol that could plausibly issue a first token of its
// own — WBTC, Binance staked ETH and USDT0 are wrapped or staked products of tokens that
// already trade, so the radar never ranks them as launches.
// - growthMult = 1 + clamp(change_7d, -50, +100) / 100 x 0.6   (a hot week lifts, never explodes)
// - maturityMult = 0.75 + 0.45 x min(age_days, 1460) / 1460   (age = days since DefiLlama first
//   tracked it: the longer a protocol has run with no token, the more proven the launch)
// - breadthMult = 1 + 0.015 x min(chains - 1, 10)             (distribution across chains)
//
// Farm plans are generated per category family from the protocol's own record (chains, TVL,
// age): a core position sized by TVL tier, a second qualifying action, a weekly cadence, a hold
// window from its age, a points/claim check, a family-specific risk step and an exit/log step.
// Every step states what it costs and how long it takes.

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The model's version label: the dashboard names it. */
export const MODEL_VERSION = 'radar-2 peer-calibrated';

/** The model's constants, stated in the dashboard so a reader can re-derive every number. */
export interface ModelConstants {
  shrink_weight: number;
  multiple_floor: number;
  multiple_cap: number;
  growth_weight: number;
  growth_floor: number;
  growth_cap: number;
  maturity_floor: number;
  maturity_range: number;
  maturity_days: number;
  unknown_age_days: number;
  breadth_per_chain: number;
  breadth_max_extra_chains: number;
}

export const MODEL: ModelConstants = {
  shrink_weight: 4,
  multiple_floor: 0.03,
  multiple_cap: 1.5,
  growth_weight: 0.6,
  growth_floor: -50,
  growth_cap: 100,
  maturity_floor: 0.75,
  maturity_range: 0.45,
  maturity_days: 1460,
  unknown_age_days: 365,
  breadth_per_chain: 0.015,
  breadth_max_extra_chains: 10,
};

/** Functional families: categories that sell the same service share one peer set. */
export const FAMILIES: Record<string, string[]> = {
  credit: ['Lending', 'CDP'],
  exchange: ['Dexs', 'Derivatives'],
  staking: ['Liquid Staking', 'Liquid Restaking', 'Restaking', 'Staking Pool'],
  bridges: ['Bridge', 'Canonical Bridge', 'Cross Chain Bridge'],
  allocators: ['Risk Curators', 'Onchain Capital Allocator', 'Yield', 'Yield Aggregator', 'Liquidity Manager', 'Farm', 'Leveraged Farming', 'Basis Trading'],
  rwa: ['RWA'],
  chain: ['Chain'],
};

const FAMILY_OF = new Map<string, string>();
for (const [family, cats] of Object.entries(FAMILIES)) for (const c of cats) FAMILY_OF.set(c, family);

/** The functional family a category belongs to ('other' when the map names none). */
export function familyOf(category: string | null): string {
  if (category === null) return 'other';
  return FAMILY_OF.get(category) ?? 'other';
}

/** One category's calibrated multiple, with the peer counts it rests on. */
export interface PeerMultiple {
  category: string;
  family: string;
  multiple: number;
  category_peers: number;
  family_peers: number;
  category_median: number | null;
  family_median: number | null;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));
const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/**
 * Derive every category's peer multiple from the snapshot's live-token protocols.
 * Deterministic: medians over slug-sorted inputs, no clock, no randomness.
 */
export function peerMultiples(snapshot: Snapshot, model: ModelConstants = MODEL): { table: PeerMultiple[]; global_median: number } {
  const live = snapshot.protocols
    .filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0)
    .sort((a, b) => (a.slug < b.slug ? -1 : 1));
  // Winsorised ratios: a peer trading far above its TVL is an outlier, not a calibration point.
  const ratioOf = (p: SnapshotProtocol): number => clamp(p.mcap_usd! / p.tvl_usd, 0.02, 1.5);
  const globalMedian = median(live.map(ratioOf)) ?? 0.2;

  const byCategory = new Map<string, number[]>();
  const byFamily = new Map<string, number[]>();
  for (const p of live) {
    const ratio = ratioOf(p);
    const cat = p.category ?? '(none)';
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat)!.push(ratio);
    const fam = familyOf(p.category);
    if (!byFamily.has(fam)) byFamily.set(fam, []);
    byFamily.get(fam)!.push(ratio);
  }

  const categories = new Set<string>();
  for (const p of snapshot.protocols) categories.add(p.category ?? '(none)');
  const table: PeerMultiple[] = [];
  for (const category of [...categories].sort()) {
    const family = category === '(none)' ? 'other' : familyOf(category);
    const catRatios = byCategory.get(category) ?? [];
    const famRatios = family === 'other' ? [] : (byFamily.get(family) ?? []);
    const catMedian = median(catRatios);
    const famRaw = median(famRatios);
    // A thin family's median is itself shrunk toward the global median with the same weight,
    // so a family resting on one or two live peers cannot set a category's price alone.
    const famMedian =
      famRaw === null ? globalMedian : (famRatios.length * famRaw + model.shrink_weight * globalMedian) / (famRatios.length + model.shrink_weight);
    const blended =
      catMedian === null
        ? famMedian
        : (catRatios.length * catMedian + model.shrink_weight * famMedian) / (catRatios.length + model.shrink_weight);
    table.push({
      category,
      family,
      multiple: round4(clamp(blended, model.multiple_floor, model.multiple_cap)),
      category_peers: catRatios.length,
      family_peers: famRatios.length,
      category_median: catMedian === null ? null : round4(catMedian),
      family_median: round4(famMedian),
    });
  }
  return { table, global_median: round4(globalMedian) };
}

/** A whole day count from listed_at to as_of, clamped at zero; null when either date is absent or bad. */
const DAY_MS = 86_400_000;
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** The model's factors for one protocol, and the implied value they multiply to. */
export interface Scored {
  implied: number;
  multiple: number;
  growthMult: number;
  maturityMult: number;
  breadthMult: number;
  age: number | null;
}

export function scoreProtocol(
  p: SnapshotProtocol,
  asOf: string,
  multiples: Map<string, PeerMultiple>,
  model: ModelConstants = MODEL,
): Scored {
  const age = ageDays(asOf, p.listed_at);
  const peer = multiples.get(p.category ?? '(none)');
  const multiple = peer ? peer.multiple : 0.2;
  const growthPct = clamp(p.change_7d ?? 0, model.growth_floor, model.growth_cap);
  const growthMult = 1 + (growthPct / 100) * model.growth_weight;
  const ageForModel = age ?? model.unknown_age_days;
  const maturityMult = model.maturity_floor + (Math.min(Math.max(ageForModel, 0), model.maturity_days) / model.maturity_days) * model.maturity_range;
  const extraChains = Math.min(Math.max(p.chains.length - 1, 0), model.breadth_max_extra_chains);
  const breadthMult = 1 + extraChains * model.breadth_per_chain;
  const implied = Math.max(1, Math.round(p.tvl_usd * multiple * growthMult * maturityMult * breadthMult));
  return { implied, multiple, growthMult: round4(growthMult), maturityMult: round4(maturityMult), breadthMult: round4(breadthMult), age };
}

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** Categories that are a wrapped, staked or bridged product of a token that already trades. */
const SCREENED_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Cross Chain Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);

/** A whole word wrapped, staked or staking in a name marks the same kind of product. */
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;

/** Names that begin with an exchange's name are that exchange's product, not a launch candidate. */
const EXCHANGE_PREFIXES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];

/** Whether a protocol records no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/**
 * Whether a protocol is one the board may rank: it records no token, and it passes the launch
 * screen — the watchlist's own exclusions applied at every size, so a wrapped or bridged
 * product of a traded token is never ranked as a launch, however large it is.
 */
export function isRankable(p: SnapshotProtocol): boolean {
  if (!isPreToken(p)) return false;
  if (p.category !== null && SCREENED_CATEGORIES.has(p.category)) return false;
  if (VERSIONED.test(p.name) || WRAPPED_WORD.test(p.name)) return false;
  if (EXCHANGE_PREFIXES.some((x) => p.name.startsWith(x))) return false;
  return true;
}

/** One row of board.json. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  family: string;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  token_status: 'pre-token';
  watchlist: boolean;
  age_days: number | null;
  implied_value_usd: number;
  implied_per_tvl: number;
  model: {
    peer_multiple: number;
    peer_category_peers: number;
    peer_family_peers: number;
    growth_multiplier: number;
    maturity_multiplier: number;
    breadth_multiplier: number;
  };
  farm_steps: string[];
}

/** A live-token protocol: it already trades, so the dashboard shows the market's own value. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  mcap_per_tvl: number | null;
  change_7d: number | null;
  symbol: string | null;
}

/** Everything the dashboard needs. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model_version: string;
  model: ModelConstants;
  global_median: number;
  multiples: PeerMultiple[];
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  universe_size: number;
  rows: BoardRow[];
  live: LiveRow[];
}

/** The protocols the board ranks, strongest first, with ranks 1..n: every rankable pre-token protocol. */
export function buildBoard(snapshot: Snapshot, multiples: Map<string, PeerMultiple>, model: ModelConstants = MODEL): BoardRow[] {
  const watch = new Set(snapshot.watchlist);
  const scored = snapshot.protocols
    .filter(isRankable)
    .map((p) => ({ p, s: scoreProtocol(p, snapshot.as_of, multiples, model) }));
  scored.sort((a, b) => b.s.implied - a.s.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  return scored.map(({ p, s }, i) => {
    const peer = multiples.get(p.category ?? '(none)');
    return {
      rank: i + 1,
      slug: p.slug,
      name: p.name,
      category: p.category,
      family: familyOf(p.category),
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      change_7d: p.change_7d,
      listed_at: p.listed_at,
      token_status: 'pre-token' as const,
      watchlist: watch.has(p.slug),
      age_days: s.age,
      implied_value_usd: s.implied,
      implied_per_tvl: round4(s.implied / p.tvl_usd),
      model: {
        peer_multiple: s.multiple,
        peer_category_peers: peer ? peer.category_peers : 0,
        peer_family_peers: peer ? peer.family_peers : 0,
        growth_multiplier: s.growthMult,
        maturity_multiplier: s.maturityMult,
        breadth_multiplier: s.breadthMult,
      },
      farm_steps: farmSteps(p, s.age),
    };
  });
}

// ---------------------------------------------------------------------------
// Farm plans: one playbook per family, parameterised by the protocol's own
// record (primary chain, TVL tier, age). Every step carries a cost and a time.
// ---------------------------------------------------------------------------

/** Capital for one farm position, from the protocol's own TVL tier. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 500;
  if (p.tvl_usd >= 1_000_000_000) return 250;
  if (p.tvl_usd >= 250_000_000) return 150;
  if (p.tvl_usd >= 50_000_000) return 100;
  return 50;
}

/** Gas for one on-chain action: Ethereum mainnet is dear, every other named chain is cheap. */
function gasFor(p: SnapshotProtocol): number {
  return p.chains[0] === 'Ethereum' ? 10 : 2;
}

/** Hold window from age: younger protocols need a longer qualifying window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 45;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

interface Playbook {
  core: string;
  second: string;
  risk: string;
}

function playbookFor(p: SnapshotProtocol, capital: number, chain: string): Playbook {
  const n = p.name;
  switch (familyOf(p.category)) {
    case 'credit':
      return {
        core: `Supply $${capital} of USDC to ${n}'s main market on ${chain}, then borrow no more than 30% against it so the health factor stays above 2.0.`,
        second: `Repay and re-borrow once, and vote or stake in any ${n} incentive program that is live, so the wallet shows both sides of the market.`,
        risk: `Risk: liquidation if collateral falls — keep the health factor above 2.0, set a price alert, and never borrow against a volatile asset at the max ratio.`,
      };
    case 'exchange':
      return p.category === 'Derivatives'
        ? {
            core: `Deposit $${capital} of USDC as margin on ${n} and open one small hedged pair (long and short of equal size) so volume counts without directional risk.`,
            second: `Trade one small position a week on ${n} and keep total fees under $15; close every position before you withdraw the margin.`,
            risk: `Risk: funding payments and liquidation on leveraged positions — keep leverage at 2x or under and the margin ratio above 50% at all times.`,
          }
        : {
            core: `Provide $${capital} split evenly between USDC and ETH in ${n}'s deepest pool on ${chain} and keep the LP position open.`,
            second: `Make two swaps a week through ${n}'s own interface (about $${capital / 5} each) so the wallet shows both LP and trader activity.`,
            risk: `Risk: impermanent loss if the pool's prices diverge — use a stable or blue-chip pair and check the LP value against simply holding every week.`,
          };
    case 'staking':
      return {
        core: `Stake $${capital} of the chain's native asset through ${n} on ${chain} and keep the liquid receipt token in the same wallet.`,
        second: `Use the receipt token once in a money market ${n} names as a partner (supply it as collateral, borrow nothing) so the wallet shows the receipt in use.`,
        risk: `Risk: the receipt token trading under its peg and slashing — check the peg weekly and keep the position small enough to exit in one swap.`,
      };
    case 'bridges':
      return {
        core: `Bridge $${capital} of USDC from Ethereum to ${chain} through ${n}, then bridge a smaller amount back a week later so both directions are recorded.`,
        second: `Spend the bridged funds in one app on ${chain} (a swap or a deposit) instead of bridging straight back, so the trip ends in real usage.`,
        risk: `Risk: bridge contracts are the largest hack target in DeFi — split any larger amount across two days and verify the contract address from the protocol's own page.`,
      };
    case 'allocators':
      return {
        core: `Deposit $${capital} of USDC into the largest ${n} vault or curated market on ${chain} and keep the vault shares in the wallet.`,
        second: `Read the curator's latest reallocation note for ${n} and move the deposit only if the vault itself migrates; churn between vaults resets most counters.`,
        risk: `Risk: the curator can allocate into risky markets — read the vault's market list monthly and withdraw if a market you would not lend to directly appears.`,
      };
    case 'rwa':
      return {
        core: `Complete ${n}'s onboarding or KYC if it asks, then mint $${capital} of its yield asset on ${chain} and hold it in the wallet.`,
        second: `Hold the asset across one full distribution or interest period and claim the payout from ${n}'s own page when it lands.`,
        risk: `Risk: redemption queues and issuer risk — real-world assets can take days to redeem, so farm only money you do not need back this month.`,
      };
    case 'chain':
      return {
        core: `Bridge $${capital} of USDC onto ${n}'s chain and make it the wallet's home chain for a month: swaps, one deposit, one NFT or name mint.`,
        second: `Use two different apps on ${n} each week (a DEX and a lending market) so the wallet's activity is broad, not one repeated action.`,
        risk: `Risk: a young chain's bridge and apps are thin — keep balances small, and bridge back a test $10 before moving the full amount out.`,
      };
    default:
      return {
        core: `Deposit $${capital} of USDC into ${n}'s flagship product on ${chain} through its own app and keep the position open.`,
        second: `Make one more qualifying action in ${n} (a second deposit, a vote or a claim) so the wallet is not a single-transaction wallet.`,
        risk: `Risk: unaudited or young contracts — check ${n}'s audits and TVL trend before adding more, and cap this wallet at money you can leave locked.`,
      };
  }
}

/** A step as one string, always inside the gate's 20..600 characters. */
function step(text: string, cost: string, time: string): string {
  let s = `${text} Cost: ${cost}. Time: ${time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  return s;
}

/**
 * A protocol's farm plan: seven steps, each an action with a cost and a time, derived from the
 * protocol's family, primary chain, TVL tier and age — never from a hand-written list of names.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): string[] {
  const chain = p.chains.length > 0 ? p.chains[0]! : 'its main chain';
  const capital = capitalFor(p);
  const gas = gasFor(p);
  const hold = holdDaysFor(age);
  const play = playbookFor(p, capital, chain);
  return [
    step(
      `Set up a fresh wallet for ${p.name} that holds only the funds you plan to farm, fund it from an exchange (never from a wallet you want kept private), and keep its seed phrase offline.`,
      'under $3 to fund and test',
      '10 minutes',
    ),
    step(play.core, `$${capital} of capital plus about $${gas} of gas`, '15 minutes to set up'),
    step(play.second, `about $${gas} of gas per action`, '10 minutes a week'),
    step(
      `Repeat one qualifying action every week — a deposit, a swap, a vote or a claim inside ${p.name}'s own app — so the wallet builds a history instead of a single visit.`,
      `about $${gas * 2} of gas a month`,
      '10 minutes a week',
    ),
    step(
      `Hold the position for at least ${hold} days so the activity spans more than one snapshot or points epoch; withdrawing early is the most common reason a farm counts for nothing.`,
      `the $${capital} stays in the position`,
      `${hold} days`,
    ),
    step(
      `Check ${p.name}'s own points, rewards or governance page for a claim window, and claim only from the link that page publishes — never from a DM, a reply or a search ad.`,
      'no fee to check, and never pay anyone to claim',
      '10 minutes',
    ),
    step(
      `${play.risk} Log every transaction with its date in a farm log, and unwind the position the week a claim window closes.`,
      'nothing but the log; gas to exit is about the same as gas to enter',
      '5 minutes to log, 15 minutes to exit',
    ),
  ];
}

/** The live-token protocols, by market cap: the comparison set the model is calibrated on. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, 36)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      mcap_per_tvl: p.mcap_usd !== null && p.tvl_usd > 0 ? round4(p.mcap_usd / p.tvl_usd) : null,
      change_7d: p.change_7d,
      symbol: p.symbol,
    }));
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; radar: RadarData } {
  const { table, global_median } = peerMultiples(snapshot, model);
  const multiples = new Map(table.map((t) => [t.category, t]));
  const board = buildBoard(snapshot, multiples, model);
  const live = liveRows(snapshot);
  const watch = new Set(snapshot.watchlist);
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model_version: MODEL_VERSION,
    model,
    global_median,
    multiples: table.filter((t) => board.some((r) => (r.category ?? '(none)') === t.category)),
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: board.filter((r) => !watch.has(r.slug)).length,
    live_size: live.length,
    universe_size: snapshot.protocols.length,
    rows: board,
    live,
  };
  return { board, radar };
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return { as_of: o.as_of, source: o.source, floor_usd: o.floor_usd, protocols, watchlist: o.watchlist as string[] };
}

/** Why a board is not one the gate will take, or null. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slugs: ${missing.slice(0, 5).join(', ')}`;
  if (board.length < 100 || board.length > 4000) return `the board has ${board.length} rows`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) {
      const t = s.trim();
      if (t.length < 20 || t.length > 600) return `${r.slug} has a farm step of ${t.length} characters`;
    }
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0 || r.implied_value_usd > 100_000_000_000_000) {
      return `${r.slug} has implied value ${r.implied_value_usd}`;
    }
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
