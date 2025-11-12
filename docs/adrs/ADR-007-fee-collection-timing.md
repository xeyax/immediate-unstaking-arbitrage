## ADR-007 — Fee Collection Timing

**Status**: Proposed
**Date**: 2025-11-06
**Deciders**: Smart Contract Engineering Team
**Related FRs**: FR-07, FR-08

### Context

The vault collects performance fees on realized arbitrage profits per FR-08. The timing of when fees are transferred to the fee recipient affects share value accuracy, accounting complexity, and gas costs. Each arbitrage position realizes profit independently when claimed after its 7-day cooldown period.

If fees are collected immediately when positions close, accounting is simple and share values remain accurate. However, each claim transaction incurs an additional token transfer. If fees are accrued and collected periodically, gas is saved through batching, but uncollected fees temporarily inflate share value, creating unfair pricing for deposits and withdrawals between harvest events.

The vault may have dozens of concurrent positions maturing on different schedules. The keeper claims positions as they mature to maximize capital efficiency, creating a natural cadence of fee events rather than lumpy batches.

### Decision

Collect fees immediately when each position is claimed. Fee calculation and transfer occur atomically within claimPosition(), extracting the performance fee from realized profit before adding net profit to totalAssets. This ensures share value always reflects net-of-fee economics and eliminates accrual tracking complexity.

### Options Considered

**Immediate Collection on Position Close**
Fees transferred when claimPosition() executes. Trade-offs: Simple accounting, accurate share values at all times, no temporary dilution; adds token transfer gas cost per position (marginal relative to total claim operation).

**Periodic Harvest**
Fees accrue in feesPending counter; separate harvest() call transfers accumulated fees. Trade-offs: Batched gas efficiency for multiple positions; fees inflate share value between harvests causing deposit/withdrawal mispricing, requires harvest transaction and operator discipline, complex accrual tracking synchronized with position lifecycle.

**On User Withdrawal**
Fees deducted pro-rata when users burn shares. Trade-offs: No protocol-initiated fee transactions; extremely complex accounting distributing fee burden across withdrawals, unpredictable timing for fee recipient, risk of manipulation via withdrawal timing games, violates clarity of FR-08.

**Do nothing**
Current implementation uses immediate collection, changing would add complexity without material benefit. Accrual creates accounting burden and share value distortion that violates FR-05 fairness principles.

### Consequences

- Fee transfer occurs in same transaction as position claim, adding transfer gas cost.
- Share value reflects net-of-fee profit immediately, ensuring deposits and withdrawals price fairly.
- No feesPending state variable or harvest operation needed.
- Fee recipient receives fees as positions mature, creating steady cash flow if positions are opened regularly.
- No risk of uncollected fee balance inflating share value between collection events.
- Events emit actualProfit before fee deduction for transparency on gross returns.

### On-Chain Implementation Notes

- claimPosition() calculates: fee = (actualProfit × performanceFee) / BASIS_POINTS.
- Immediate transfer: usde.safeTransfer(owner(), fee) within claim transaction.
- Net profit added to totalAssets: totalAssets += (actualProfit - fee).
- No separate harvest function or feesPending tracking required.
- PositionClaimed event emits gross actualProfit; fee amount derivable from performanceFee parameter.

### Dependencies

- ADR-003: Position accounting provides per-position profit tracking needed for fee calculation.

### References

- FR-07: Profit Compounding
- FR-08: Performance Fee Collection
