## ADR-002 — NAV Calculation Method

**Status**: Proposed
**Date**: 2025-11-06
**Deciders**: Smart Contract Engineering Team
**Related FRs**: FR-05, FR-01

### Context

The vault must calculate Net Asset Value for share pricing during deposits and withdrawals. NAV determines how many shares a depositor receives and how much USDe they can withdraw per share. Accurate NAV prevents existing shareholders from being diluted when new deposits occur or exploited when withdrawals happen.

The vault holds two asset types: idle USDe and sUSDe in 7-day cooldown. When vault executes arbitrage, it purchases sUSDe on DEX and immediately initiates cooldown unstaking in the same transaction. The sUSDe never sits idle - it goes directly from purchase into cooldown. During cooldown, sUSDe continuously accrues value from staking rewards, meaning each sUSDe represents more USDe over time via convertToAssets().

If NAV only counts book value (USDe cost paid for sUSDe), depositors entering when capital is heavily deployed receive inflated share allocations because NAV understates true assets. Conversely, withdrawers exiting during high deployment receive less USDe than their economic share because unrealized gains from staking rewards are excluded from NAV.

### Decision

Calculate NAV using time-weighted accrual of expected profits. The specific formula:

**NAV = idle USDe balance + Σ(bookValue[i] + accruedProfit[i])**

For each position i in cooldown:
```
accruedProfit[i] = expectedProfit[i] × (block.timestamp - startTime[i]) / COOLDOWN_PERIOD

where:
expectedProfit[i] = sUSDe.convertToAssets(sUsdeAmount[i]) - bookValue[i]
bookValue[i] = USDe paid to purchase sUSDe
COOLDOWN_PERIOD = 7 days (604800 seconds)
```

This gradually recognizes profit proportionally to time elapsed in the 7-day cooldown, ensuring depositors only pay for their time-proportional share of unrealized gains rather than the full future profit.

### Options Considered

**Time-Weighted Accrual Method (chosen)** — NAV includes idle USDe + book value + time-proportional accrued profit for each position.
Trade-offs: Fair to all depositors by recognizing profit proportionally to time elapsed; requires storing startTime and calculating expectedProfit per position; one external call to convertToAssets() per NAV calculation; depositors pay only for time-proportional share of unrealized gains.

**Full Fair Value Method** — NAV includes idle USDe + convertToAssets(sUSDe balance) for all positions.
Trade-offs: Reflects full economic value; new depositors immediately pay for 100% of future profit they won't receive for 7 days, creating unfair dilution of existing shareholders who have already waited.

**Book Value Method** — NAV includes idle USDe + original entry cost of sUSDe positions.
Trade-offs: Simpler implementation, no external calls; creates timing arbitrage where depositors entering near position maturity get inflated shares, violates fairness requirement in FR-05.

**Recognize Profit Only on Claim** — NAV includes idle USDe + book value until position is claimed.
Trade-offs: Conservative; positions ready to claim but not yet claimed are undervalued, creating temporary mispricing and MEV opportunity right before/after claims.

### Consequences

**Bootstrap / Initial Deposit**
- First deposit establishes 1:1 price per share (PPS = 1)
- First depositor receives shares equal to USDe amount deposited
- Standard ERC-4626 behavior: if totalSupply == 0, shares = assets

**Ongoing Operations**
- NAV calculation iterates active positions in FIFO range [firstActivePositionId, nextPositionId).
- Share price gradually increases as positions age toward maturity, reflecting time-proportional profit recognition.
- Depositors pay fair value: book value plus only the portion of profit accrued during elapsed cooldown time.
- Withdrawers receive fair value: their proportional share of book value plus accrued profits based on position ages.
- No incentive to time deposits/withdrawals to exploit position maturity timing.
- Position tracking stores: sUsdeAmount, bookValue, expectedAssets (from Ethena cooldownShares), startTime for each position.
- Gas cost bounded by MAX_ACTIVE_POSITIONS (50 positions ≈ 100k gas), acceptable for deposit/withdraw operations.

### On-Chain Implementation Notes

- Override `totalAssets()` to implement: `USDe.balanceOf(vault) + Σ(bookValue[i] + accruedProfit[i])` for all active positions
- Each position stores: `sUsdeAmount`, `bookValue`, `expectedAssets`, `startTime`, `claimed`, `proxyContract`
- `expectedAssets` comes from Ethena's `cooldownShares()` return value at position open time (per-position, not aggregate)
- Calculate per-position: `accruedProfit[i] = (expectedAssets[i] - bookValue[i]) × min(now - startTime[i], COOLDOWN_PERIOD) / COOLDOWN_PERIOD`
- Time-weighted accrual: profit accrues linearly over COOLDOWN_PERIOD (7 days), then stops
- FIFO claim order: positions must be claimed oldest-first via `claimPosition()` (no positionId parameter)
- Active positions maintained in continuous range with no gaps (FIFO invariant)

### Dependencies

- ADR-001 (Vault Token Standard): ERC-4626 totalAssets() function returns this NAV calculation.

### ADRs Depending on This

- ADR-003 (Position Accounting Model): Must track sUSDe amounts per position for convertToAssets() queries.

### References

- [Ethena sUSDe Contract](https://docs.ethena.fi/solution-overview/usde-overview/staked-usde)
- [ERC-4626 totalAssets Specification](https://eips.ethereum.org/EIPS/eip-4626#totalassets)
