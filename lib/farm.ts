/**
 * Read-only farm-route plans keyed to the validated Token Radar snapshot.
 *
 * Every plan is an inspection checklist, not a transaction or a yield promise.
 * Product-specific plans use only conditions stated in the cited official
 * documentation; generic plans describe what to verify, quote and skip rather
 * than inventing gas, fee, lock or timing numbers. Unknown values are treated
 * as unknown, never as zero.
 */

import type { SnapshotLedgerRow } from './snapshot.ts';

export type FarmPlanStatus = 'source-backed' | 'verify-terms' | 'research-only';

export interface FarmPlan {
  readonly status: FarmPlanStatus;
  readonly steps: readonly string[];
  readonly sources: readonly string[];
}

const DISCLAIMER =
  'This is not investment advice or a recommendation; it is a read-only checklist, and no yield, incentive or principal protection is assumed.';

const STEAKHOUSE_SOURCES = [
  'https://steakhouse.financial/docs/products/vault-products/current/prime-instant',
  'https://steakhouse.financial/docs/risk-management/monitoring/vault-setup-and-controls',
] as const;

const GAUNTLET_SOURCES = [
  'https://vaultbook.gauntlet.xyz/vaults/morpho-vaults/vault-fees',
  'https://vaultbook.gauntlet.xyz/vaults/morpho-vaults/morpho-vaults-overview',
] as const;

const VEDA_SOURCES = [
  'https://docs.veda.tech/integrations/deposits-and-withdrawals-overview',
  'https://docs.veda.tech/api/vaults',
] as const;

const USDD_SOURCES = [
  'https://docs.usdd.io/user-guide/usdd-savings',
  'https://docs.usdd.io/legals/terms-of-use',
] as const;

const ONRE_SOURCES = [
  'https://docs.onre.finance/for-capital-providers/redemptions',
  'https://docs.onre.finance/legal/kyc-and-aml-policy',
] as const;

const SYMBIOTIC_SOURCES = [
  'https://docs.symbiotic.fi/learn/mechanics/epochs-and-delays',
  'https://docs.symbiotic.fi/get-started/resources/risks',
] as const;

const KPK_SOURCES = [
  'https://docs.kpk.io/vaults/vaults/morpho/ethereum/usdc-prime-core',
  'https://docs.kpk.io/vaults/resources/legal/morpho-disclaimer',
] as const;

function freezePlan(
  status: FarmPlanStatus,
  steps: readonly string[],
  sources: readonly string[] = [],
): FarmPlan {
  return Object.freeze({
    status,
    steps: Object.freeze([...steps]),
    sources: Object.freeze([...sources]),
  });
}

const SPECIFIC_PLANS: Readonly<Record<string, FarmPlan>> = Object.freeze({
  'steakhouse-financial': freezePlan(
    'source-backed',
    [
      'Confirm the exact Steakhouse Prime Instant or High Yield Instant vault and chain; treat the USDC Ethereum vault only as the documented example, not as a universal asset list.',
      'Read the Prime Instant product page and the vault setup and controls page, then match the vault name and chain on the official app to those docs before any wallet action.',
      'Check the live instant-exit quote and available liquidity; instant redemption is subject to liquidity rather than a guaranteed immediate exit.',
      'Compare the performance fee shown in the app with the fee described in the docs; observations differ, so do not assume a fixed universal rate.',
      'Count approval, entry and exit transactions and quote gas for each on the chosen chain; an unquoted gas or fee amount is not zero.',
      'Review exposure to underlying Morpho markets, oracles and the curator; a source-backed route does not remove those risks.',
      'Skip the route if you need a guaranteed exit or if the live fee and liquidity terms are not clear; keep the review read-only until they are.',
      DISCLAIMER,
    ],
    STEAKHOUSE_SOURCES,
  ),
  gauntlet: freezePlan(
    'source-backed',
    [
      'Separate the Base USDC Prime v2 Morpho vault from the cross-chain gtUSDa product, and confirm the exact vault name and chain before using any frontend.',
      'Read the Morpho vaults overview and vault fees pages, then compare the displayed vault, asset and fee with those official docs.',
      'Check available exit liquidity and whether the route is instant or queued; cross-chain gtUSDa order delay and routing differ from Prime behavior.',
      'Do not assume a universal fee; quote the specific vault fee and gas for approval, entry and exit, because an unknown amount is not zero.',
      'Count the full round trip and record each chain switch or bridge step; async routing can extend the time to exit.',
      'Review curator and Morpho market exposure; neither a known curator nor a source-backed route removes liquidity or smart-contract risk.',
      'Skip the route if async settlement or curator exposure is unacceptable, or if the exact vault and fee cannot be confirmed.',
      DISCLAIMER,
    ],
    GAUNTLET_SOURCES,
  ),
  veda: freezePlan(
    'verify-terms',
    [
      'Treat Veda as venue infrastructure, not one consumer vault; identify an actual official partner frontend and an eligible Veda vault before proceeding.',
      'Read the deposits and withdrawals overview and the vault API entry, then match the vault address and chain to the official venue.',
      'Check the vault-specific share lock, liquidity buffer, queue or solver withdrawal process; those terms are not uniform across Veda venues.',
      'Verify the exact fee in the venue and quote gas for each action; no usable blanket fee exists, and an unknown fee is not zero.',
      'Count the full round trip from approval to exit and note any queue or solver timing; do not assume immediate withdrawal.',
      'Review vault strategy, curator and smart-contract risk; Veda infrastructure does not guarantee liquidity or principal.',
      'Skip the route if there is no authenticated official frontend or the vault terms are unclear; keep eligibility checks read-only.',
      DISCLAIMER,
    ],
    VEDA_SOURCES,
  ),
  usdd: freezePlan(
    'source-backed',
    [
      'Use the USDD Savings product on Ethereum or BNB Chain and label it separately from the TRON CDP Vault product; they are different routes.',
      'Confirm the chain, contract address and eligibility in the official Savings guide and terms before any wallet action.',
      'Review stablecoin depeg, allocator, contract and counterparty risk; do not treat USDD Savings as a guaranteed-yield or principal-protected product.',
      'Do not assume a specific fee; quote the live fee and gas for approval, supply and withdrawal, because an unknown cost is not zero.',
      'Count the round trip and confirm the exit path and timing from the official terms; if either is unclear, stay read-only.',
      'Skip the route if eligibility, the contract address or redemption terms cannot be verified.',
      DISCLAIMER,
    ],
    USDD_SOURCES,
  ),
  onre: freezePlan(
    'verify-terms',
    [
      'Treat ONyc as Solana reinsurance exposure rather than generic stablecoin lending, and confirm the exact product and chain in official docs.',
      'Read the redemption guide and KYC and AML policy; independently verified primary exit requires KYC and accredited eligibility plus queue and liquidity.',
      'Treat the advertised 2.5%-NAV monthly capacity as a target, not a guarantee or a fixed yield.',
      'Mint eligibility conflicts across the official docs, so label it unresolved and do not assume permissionless access or an open primary route.',
      'Keep eligibility and exit checks read-only; quote all disclosed fees and gas and count each action in the round trip, since unknown costs are not zero.',
      'Review reinsurance, counterparty, liquidity and regulatory risk; secondary liquidity is not a substitute for the documented exit.',
      'Skip the route if eligibility or the primary exit is not clear, and do not act on a marketing page alone.',
      DISCLAIMER,
    ],
    ONRE_SOURCES,
  ),
  symbiotic: freezePlan(
    'verify-terms',
    [
      'Inspect the exact Symbiotic collateral vault, whether it is public or allowlisted, its curator and its slashing terms before any wallet action.',
      'Read the epochs and delays page: after an independently verified withdrawal request, the exit becomes claimable only after the next epoch ends.',
      'For vault epoch E, plan for a delay in [E,2E) and keep in mind that funds remain slashable until the epoch boundary.',
      'Do not claim or assume that Symbiotic points convert to a token or carry a cash value.',
      'Quote deposit and withdrawal fees and gas, count the full round trip and treat any unknown cost as not zero.',
      'Review slashing, curator, smart-contract and liquidity risk; an epoch delay is not a liquidity guarantee.',
      'Skip the route if the epoch delay or slashing exposure is unsuitable, or if the exact vault is not verifiable.',
      DISCLAIMER,
    ],
    SYMBIOTIC_SOURCES,
  ),
  kpk: freezePlan(
    'source-backed',
    [
      'Confirm the exact KPK USDC vault and chain; the Ethereum USDC Prime Core vault is the documented example, not a universal product list.',
      'Read the vault page and the Morpho legal disclaimer, then match the vault name, chain and asset on the official frontend to those docs.',
      'Distinguish normal exit liquidity from large-exit liquidity and verify the fee per vault; do not apply one fee estimate across KPK vaults.',
      'Quote gas for approval, entry and exit and count the full round trip; an unquoted cost is not zero.',
      'Review Morpho bad-debt, liquidity, oracle and curator risk; KPK provides no principal or liquidity guarantee.',
      'Skip the route if large-exit liquidity or the vault fee is unclear, or if the documented vault cannot be matched on screen.',
      DISCLAIMER,
    ],
    KPK_SOURCES,
  ),
});

type GenericStatus = Exclude<FarmPlanStatus, 'source-backed'>;

interface CategoryProfile {
  readonly status: GenericStatus;
  readonly route: string;
  readonly cost: string;
  readonly timing: string;
  readonly risk: string;
  readonly skip: string;
}

const CATEGORY_PROFILES: Readonly<Record<string, CategoryProfile>> =
  Object.freeze({
    'Risk Curators': {
      status: 'verify-terms',
      route:
        'Identify the exact curator-operated vault, chain and curator entity; check whether the vault is public or allowlisted and read its stated strategy and collateral.',
      cost:
        'Quote the vault fee, any performance fee and the gas for each wallet action; unknown fees are not zero and must not be estimated as free.',
      timing:
        'Confirm entry and exit mechanics, any lock, buffer or queue, and count the full round trip including approval and withdrawal.',
      risk:
        'Curator, Morpho or lending-market, oracle and liquidation risks remain even when a known curator is named; no principal protection is implied.',
      skip:
        'Skip this route if you cannot confirm the exact vault, whether access is allowlisted, or how and when an exit settles.',
    },
    'Onchain Capital Allocator': {
      status: 'verify-terms',
      route:
        'Identify the exact allocator vault, chain, strategy and share token; verify whether access is permissioned and whether capital is delegated to sub-vaults.',
      cost:
        'Quote allocator, management or performance fees and gas for each action; fee stacking is possible and an unknown fee is not zero.',
      timing:
        'Find the documented subscription, redemption or queue cycle and count approval, entry and exit steps; do not assume daily liquidity.',
      risk:
        'Allocator discretion, underlying strategy, counterparty and liquidity risk remain; past performance is not a promise.',
      skip:
        'Skip this route if the official frontend, share terms or redemption and exit path cannot be verified.',
    },
    'Liquidity Manager': {
      status: 'verify-terms',
      route:
        'Confirm the exact liquidity-manager vault and chain, the pool it manages and whether depositors receive a share token.',
      cost:
        'Quote management and performance fees plus gas for each action; fee labels can differ from docs, so use the live app quote and treat unknown fees as not zero.',
      timing:
        'Check any withdrawal notice, lock or rebalancing delay, count the full round trip and confirm the exit route.',
      risk:
        'Impermanent loss, pool, oracle and smart-contract risk can exceed fee income.',
      skip:
        'Skip this route if the managed pool, fee schedule or exit process is not explicit.',
    },
    'Collateral Markets': {
      status: 'verify-terms',
      route:
        'Identify the exact collateral market, eligible collateral and vault, and whether access is public or allowlisted.',
      cost:
        'Quote supply or borrow fees, oracle-related costs and gas per transaction; unknown costs are not zero.',
      timing:
        'Check how collateral can be withdrawn, any epoch or queue, and count the full round trip to exit.',
      risk:
        'Liquidation, slashing, oracle and curator risk can impair collateral.',
      skip:
        'Skip this route if collateral eligibility, liquidation terms or exit timing is unclear.',
    },
    Lending: {
      status: 'verify-terms',
      route:
        'Confirm the exact lending market, asset, chain and whether the route is supply or borrow; read the official market parameters and collateral rules.',
      cost:
        'Quote supply or borrow rates, reserve or protocol fees and gas for approval, supply and withdrawal; rates move and an unknown fee is not zero.',
      timing:
        'Check available liquidity and the exit path; a displayed rate does not guarantee immediate withdrawal.',
      risk:
        'Smart-contract, oracle, liquidation and bad-debt risk remain; no principal or liquidity guarantee is implied.',
      skip:
        'Skip this route if utilization, collateral rules or withdrawal liquidity cannot be checked.',
    },
    'Uncollateralized Lending': {
      status: 'verify-terms',
      route:
        'Confirm the official pool, borrower and underwriter terms and whether access is restricted; read the credit and loss-allocation rules.',
      cost:
        'Quote pool fees and gas, and treat unknown credit losses as unknown; an undisclosed fee is not zero.',
      timing:
        'Check lockup, maturity and default or workout timing, count the full round trip and confirm the exit path.',
      risk:
        'Borrower default, underwriting and legal-enforcement risk can cause loss beyond fee income.',
      skip:
        'Skip this route if borrower disclosure, the loss waterfall or exit terms are missing.',
    },
    CDP: {
      status: 'verify-terms',
      route:
        'Distinguish the exact CDP product and chain; confirm collateral, debt asset and whether the route is Savings or a CDP vault.',
      cost:
        'Quote the stability or savings fee and gas per action; do not assume a zero fee, because an unknown fee is not zero.',
      timing:
        'Check liquidation, redemption and exit mechanics, and count approval, mint or supply and unwind transactions.',
      risk:
        'Collateral liquidation, stablecoin depeg, oracle and contract risk remain.',
      skip:
        'Skip this route if collateral rules, the fee or the unwind exit path is unclear.',
    },
    'CDP Manager': {
      status: 'verify-terms',
      route:
        'Confirm the managed CDP, collateral and chain, and what the manager controls versus what the depositor controls.',
      cost:
        'Quote management, stability and gas costs; unknown fees are not zero.',
      timing:
        'Check any lock, liquidation window and managed exit process, then count the full round trip.',
      risk:
        'Manager discretion, liquidation and smart-contract risk remain; no principal protection is implied.',
      skip:
        'Skip this route if manager permissions or the exit process is not documented.',
    },
    'Stablecoin Wrapper': {
      status: 'research-only',
      route:
        'Identify the exact wrapper, underlying stablecoin, chain and redemption contract; do not assume the wrapper is a yield product.',
      cost:
        'Quote mint and redeem fees plus gas for both legs; a wrapper fee is not zero just because it is not displayed.',
      timing:
        'Check whether redemption is instant or queued and count the mint plus redeem actions to exit.',
      risk:
        'Depeg, reserve, custody and smart-contract risk remain; the wrapper category is not a yield guarantee.',
      skip:
        'Skip this route if the underlying reserve or redemption route cannot be verified.',
    },
    'Dual-Token Stablecoin': {
      status: 'research-only',
      route:
        'Confirm which token is the stable leg, its peg mechanism, chain and official mint or redeem route.',
      cost:
        'Quote fees and gas for both legs; an unlisted fee is not zero.',
      timing:
        'Check redemption and peg-restoration mechanics, count the full round trip and confirm the exit route.',
      risk:
        'Depeg, mechanism and liquidity risk remain; advertised stability is not principal protection.',
      skip:
        'Skip this route if the peg mechanism or redemption exit route is unclear.',
    },
    Yield: {
      status: 'verify-terms',
      route:
        'Identify the exact yield vault or strategy, its chain, curator and underlying assets; read the official strategy description.',
      cost:
        'Quote deposit and withdrawal fees, performance fees and gas per action; no universal fee applies and an unknown cost is not zero.',
      timing:
        'Check any lockup, queue or buffer and count approval, entry and exit transactions.',
      risk:
        'Strategy, market, curator and smart-contract risk remain; advertised yield is variable and is not guaranteed.',
      skip:
        'Skip this route if the strategy, fee or exit path is not documented.',
    },
    'Yield Aggregator': {
      status: 'verify-terms',
      route:
        'Confirm which underlying vaults the aggregator routes into, the chain and the exact share token.',
      cost:
        'Quote aggregator and underlying vault fees plus gas; fee stacking is possible and unknown costs are not zero.',
      timing:
        'Check withdrawal routing and any source-vault queue, count the full round trip and confirm the exit route.',
      risk:
        'Aggregator, underlying vault, curator and smart-contract risk remain; diversification does not remove loss.',
      skip:
        'Skip this route if underlying allocations or the withdrawal exit route cannot be inspected.',
    },
    RWA: {
      status: 'verify-terms',
      route:
        'Identify the exact real-world asset product, legal issuer, chain and eligibility rules; distinguish token access from the off-chain claim.',
      cost:
        'Quote subscription and redemption fees, legal or platform costs and gas; unknown off-chain costs are not zero.',
      timing:
        'Check subscription windows, lockups, transfer restrictions and redemption queues; count each action to exit.',
      risk:
        'Issuer, legal, custody, liquidity and valuation risk remain; tokenization does not guarantee redemption.',
      skip:
        'Skip this route if eligibility, the legal claim or the redemption exit route is unclear.',
    },
    'Basis Trading': {
      status: 'verify-terms',
      route:
        'Confirm the exact basis strategy, venues, collateral asset and chain, and who executes the hedge.',
      cost:
        'Quote trading, funding, withdrawal fees and gas costs; funding can turn negative and unknown costs are not zero.',
      timing:
        'Check venue withdrawal times and strategy unwind terms, count both legs and confirm the full exit.',
      risk:
        'Basis, funding, counterparty, execution and liquidation risk remain; a stable-looking return is not fixed.',
      skip:
        'Skip this route if the hedge, custody or unwind exit process cannot be verified.',
    },
    CeDeFi: {
      status: 'verify-terms',
      route:
        'Separate the centralized custody leg from the on-chain leg; confirm the legal entity, chain and exact product.',
      cost:
        'Quote platform, custody, trading and gas fees; unknown off-chain fees are not zero.',
      timing:
        'Check withdrawal review, lockups and chain settlement, count each step and confirm the exit route.',
      risk:
        'Counterparty, custody, regulatory and smart-contract risk remain; on-chain transparency may be partial.',
      skip:
        'Skip this route if the custodian, legal terms or withdrawal exit process is unclear.',
    },
    Insurance: {
      status: 'research-only',
      route:
        'Confirm the exact coverage product, insured event, chain and claims process rather than assuming a yield vault.',
      cost:
        'Quote premium, claims fees and gas costs; an unquoted cost is not zero.',
      timing:
        'Check policy term, claim window and payout timing, then count the round trip to exit.',
      risk:
        'Coverage exclusions, claims and counterparty risk remain; insurance is not a yield or principal guarantee.',
      skip:
        'Skip this route if the insured event or claims exit process is not explicit.',
    },
    Indexes: {
      status: 'research-only',
      route:
        'Identify the exact index token, constituents, rebalancing method and chain; confirm the official issuance route.',
      cost:
        'Quote issuance and redemption fees plus gas; unknown rebalancing costs are not zero.',
      timing:
        'Check rebalance and redemption timing, count mint and redeem actions and confirm the exit route.',
      risk:
        'Constituent, rebalancing, liquidity and tracking risk remain; index exposure can lose value.',
      skip:
        'Skip this route if constituents or redemption exit terms are unavailable.',
    },
    'Interest Rate Derivatives': {
      status: 'research-only',
      route:
        'Confirm the exact rate product, reference rate, maturity and chain; read the payoff and settlement terms.',
      cost:
        'Quote trading fees, margin and gas; unknown funding or settlement costs are not zero.',
      timing:
        'Check maturity, settlement and early-exit rules, then count the full round trip.',
      risk:
        'Rate, counterparty, margin and liquidation risk remain; the payoff can be negative.',
      skip:
        'Skip this route if settlement, margin or exit terms are unclear.',
    },
    'OTC Marketplace': {
      status: 'research-only',
      route:
        'Confirm the venue, asset, chain and whether access is invitation-only; identify the actual settlement route.',
      cost:
        'Quote spread and fees plus gas; an unquoted spread is not zero.',
      timing:
        'Check trade settlement and withdrawal timing, count each action and confirm the exit route.',
      risk:
        'Counterparty, price, settlement and custody risk remain.',
      skip:
        'Skip this route if the counterparty or settlement exit terms are not disclosed.',
    },
    Farm: {
      status: 'verify-terms',
      route:
        'Identify the exact farm, reward token, chain and whether rewards are incentives rather than principal yield.',
      cost:
        'Quote entry and exit fees plus gas; unknown costs are not zero and rewards are not guaranteed.',
      timing:
        'Check reward vesting, any lock or unbonding period and count the round trip to exit.',
      risk:
        'Reward-token price, emissions, contract and liquidity risk remain; incentives can go to zero.',
      skip:
        'Skip this route if reward terms or the exit path is unclear.',
    },
    'Leveraged Farming': {
      status: 'verify-terms',
      route:
        'Confirm the exact leveraged farm, collateral, debt asset, chain and maximum leverage; read the liquidation rules.',
      cost:
        'Quote borrow, swap, fee and gas costs; leveraged round trips multiply transactions and unknown costs are not zero.',
      timing:
        'Check liquidation thresholds and the unwind path, count open, add and close actions and confirm the exit.',
      risk:
        'Leverage magnifies impermanent loss, liquidation and funding risk; loss can exceed fees.',
      skip:
        'Skip this route if liquidation terms or unwind exit liquidity is unclear.',
    },
    'Staking Pool': {
      status: 'verify-terms',
      route:
        'Confirm the exact staking pool, validator or operator, chain and whether the receipt token is transferable.',
      cost:
        'Quote staking and unstaking fees plus gas; an unknown commission is not zero.',
      timing:
        'Check the unbonding or cooldown period, count the full round trip and confirm the exit route.',
      risk:
        'Slashing, validator, liquidity and smart-contract risk remain; staking is not principal-protected.',
      skip:
        'Skip this route if validator terms or the unbonding exit period is unclear.',
    },
    Restaking: {
      status: 'verify-terms',
      route:
        'Identify the exact restaking vault or operator set, collateral, chain and whether access is allowlisted.',
      cost:
        'Quote deposit and withdrawal fees plus gas; unknown slashing exposure is not zero.',
      timing:
        'Check epoch boundaries, withdrawal delay and claimable timing, count the round trip and confirm the exit.',
      risk:
        'Slashing, operator, contract and liquidity risk remain; restaked collateral can be lost.',
      skip:
        'Skip this route if slashing terms, allowlist or the withdrawal exit delay is unclear.',
    },
    'Anchor BTC': {
      status: 'verify-terms',
      route:
        'Confirm the exact BTC representation, custody or bridge model, chain and mint or redeem route.',
      cost:
        'Quote mint and redeem fees plus gas on both sides; unknown bridge costs are not zero.',
      timing:
        'Check finality and custody or bridge exit time, count the round trip and confirm the exit.',
      risk:
        'Custody, bridge, depeg and smart-contract risk remain; BTC exposure is not stablecoin exposure.',
      skip:
        'Skip this route if custody or the redemption exit route is unclear.',
    },
    'Decentralized BTC': {
      status: 'verify-terms',
      route:
        'Identify the exact decentralized BTC asset, issuance or peg mechanism, chain and official mint and redeem route.',
      cost:
        'Quote protocol, bridge and gas fees across every leg; unknown costs are not zero.',
      timing:
        'Check finality, peg or bridge exit timing and count each action in the round trip.',
      risk:
        'Peg, bridge, oracle, liquidity and contract risk remain; the BTC label does not remove them.',
      skip:
        'Skip this route if the peg mechanism or redemption exit route cannot be verified.',
    },
    Derivatives: {
      status: 'research-only',
      route:
        'Identify the exact derivative market, collateral, oracle and settlement venue; do not assume a vault route exists.',
      cost:
        'Quote trading, funding, liquidation and gas costs; unknown funding is not zero.',
      timing:
        'Check oracle settlement, funding intervals and exit liquidity, then count each action.',
      risk:
        'Market, oracle, counterparty, liquidation and smart-contract risk remain; leverage can lose more than fees.',
      skip:
        'Skip this route if settlement, liquidation or exit rules are unclear.',
    },
    'Prediction Market': {
      status: 'research-only',
      route:
        'Confirm the market question, resolution source, collateral and chain; read the resolution and dispute rules.',
      cost:
        'Quote trading fees and gas; unknown resolution costs are not zero.',
      timing:
        'Check market close, resolution and claim timing, count each action and confirm the exit.',
      risk:
        'Resolution, liquidity, oracle and counterparty risk remain; positions can expire worthless.',
      skip:
        'Skip this route if resolution rules or the claim exit process is unclear.',
    },
    Dexs: {
      status: 'verify-terms',
      route:
        'Identify the exact pool, asset pair, fee tier and chain; confirm whether the route is LP provision rather than a yield vault.',
      cost:
        'Quote pool fees, price impact and gas for add and remove liquidity; unknown costs are not zero.',
      timing:
        'Check pool volume and exit liquidity, count approval, add and remove actions and confirm the exit.',
      risk:
        'Impermanent loss, volume, smart-contract and token risk remain; fees can be outweighed by loss.',
      skip:
        'Skip this route if pool composition, fee tier or exit liquidity is unclear.',
    },
    Chain: {
      status: 'research-only',
      route:
        'Confirm whether the chain itself offers a user-facing staking, bridging or incentive program; do not treat a chain listing as a yield product.',
      cost:
        'Quote bridge or staking fees and gas on both chains; unknown costs are not zero.',
      timing:
        'Check bridge finality and unstaking delay, count each round-trip action and confirm the exit route.',
      risk:
        'Bridge, validator, smart-contract and token risk remain; a chain listing is not an investment route.',
      skip:
        'Skip this route if no official user-facing program or exit route can be verified.',
    },
    Payments: {
      status: 'research-only',
      route:
        'Confirm whether the project offers a user-facing payment, channel or liquidity program; do not infer a farm from the category.',
      cost:
        'Quote channel, routing and on-chain gas costs; unknown fees are not zero.',
      timing:
        'Check settlement and channel close timing, count each action and confirm the exit route.',
      risk:
        'Counterparty, routing, liquidity and regulatory risk remain; payment volume is not yield.',
      skip:
        'Skip this route if no official participation or exit route is documented.',
    },
    'Governance Incentives': {
      status: 'research-only',
      route:
        'Confirm the exact governance program, eligibility snapshot and chain; a governance listing is not itself a farm.',
      cost:
        'Quote gas and any program fee; an unknown opportunity cost is not zero.',
      timing:
        'Check proposal, snapshot and claim windows, count each action and confirm the exit route.',
      risk:
        'Governance, token-price and smart-contract risk remain; incentives are not guaranteed.',
      skip:
        'Skip this route if eligibility or claim exit terms are unclear.',
    },
    'Crypto Card Issuer': {
      status: 'research-only',
      route:
        'Confirm the card program, collateral or staking requirement, chain and issuer terms; do not assume a yield product.',
      cost:
        'Quote issuance, FX, custody and gas fees; unknown fees are not zero.',
      timing:
        'Check card funding, withdrawal and account closure timing, and confirm the exit route.',
      risk:
        'Issuer, custody, regulatory and token-collateral risk remain.',
      skip:
        'Skip this route if issuer terms or collateral exit release is unclear.',
    },
  });

const UNKNOWN_CATEGORY_PROFILE: CategoryProfile = Object.freeze({
  status: 'research-only',
  route:
    'The snapshot category is unknown or unlisted; identify the exact official product, chain and contract yourself before assuming a farm route exists.',
  cost:
    'Quote all fees and gas for every action; unknown costs are not zero.',
  timing:
    'Check any lock, queue or withdrawal timing, count the full round trip and confirm the exit route.',
  risk:
    'Contract, liquidity, counterparty and token risk remain; no return is promised.',
  skip:
    'Skip this route if the official route, eligibility or exit path cannot be verified.',
});

function clip(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}~`;
}

function displayName(row: SnapshotLedgerRow): string {
  const name = row.token.name;
  return typeof name === 'string' && name.trim().length > 0
    ? clip(name, 90)
    : clip(row.slug, 90);
}

function chainText(row: SnapshotLedgerRow): string {
  const chains = Array.isArray(row.token.chains) ? row.token.chains : [];
  if (chains.length === 0) return 'the chains shown in the snapshot';
  const shown = chains.slice(0, 3).join(', ');
  return clip(
    chains.length > 3 ? `${shown} and other listed chains` : shown,
    100,
  );
}

function makeGenericPlan(row: SnapshotLedgerRow): FarmPlan {
  const category =
    typeof row.token.category === 'string' && row.token.category.length > 0
      ? row.token.category
      : 'unlisted';
  const profile = Object.prototype.hasOwnProperty.call(
    CATEGORY_PROFILES,
    category,
  )
    ? CATEGORY_PROFILES[category]
    : UNKNOWN_CATEGORY_PROFILE;

  return freezePlan(profile.status, [
    `Confirm what official user-facing route ${displayName(row)} offers for this ${category} listing on ${chainText(row)} before any wallet action; do not rely on a search result or third-party link.`,
    profile.route,
    profile.cost,
    profile.timing,
    profile.risk,
    profile.skip,
    DISCLAIMER,
  ]);
}

function makeNonCandidatePlan(row: SnapshotLedgerRow): FarmPlan {
  return freezePlan('research-only', [
    `This row is classified ${row.status}, not an active candidate; do not treat it as a farm route or an endorsement.`,
    `Verify the official product, chain and terms for ${displayName(row)} independently before any wallet action.`,
    'Quote all fees and gas, confirm exit timing and count the full round trip; unknown costs are not zero.',
    'Assess contract, liquidity, curator and token risks; no return or principal protection is assumed.',
    'Skip any route whose official terms, eligibility or exit path cannot be verified.',
    DISCLAIMER,
  ]);
}

/**
 * Build a deterministic, read-only action plan for a snapshot row.
 *
 * Recognized protocol routes use only cited official documentation. Every
 * other candidate gets category-specific long-tail guidance; unknown
 * categories and non-candidate rows fail closed as `research-only`.
 */
export function buildFarmPlan(row: SnapshotLedgerRow): FarmPlan {
  if (row.status !== 'candidate') {
    return makeNonCandidatePlan(row);
  }
  if (Object.prototype.hasOwnProperty.call(SPECIFIC_PLANS, row.slug)) {
    return SPECIFIC_PLANS[row.slug] as FarmPlan;
  }
  return makeGenericPlan(row);
}
