## ADR-007 — Fee Collection Timing

**Status**: Proposed
**Date**: 2025-11-06
**Deciders**: Smart Contract Engineering Team
**Related FRs**: FR-07, FR-08

### Context

The vault collects performance fees on realized arbitrage profits per FR-08. The timing and mechanism of fee collection affects share value accuracy, accounting complexity, and gas costs.

Profit accumulates continuously via the accrual rate mechanism (ADR-003). Fees must be calculated on this accrued profit and transferred to the fee recipient. The challenge is determining when to calculate and transfer fees: on position claim only, periodically, or on any vault interaction.

Collecting fees only on position claims creates lumpy transfers. Periodic harvesting adds operational complexity. Continuous collection on any external call distributes fee transfers smoothly without requiring dedicated harvest operations.

### Decision

**Collect fees on every external call through continuous accrual tracking.** Before any external operation (deposit, withdraw, executeArbitrage, claimPosition), update accrued profit and transfer pending fees to recipient. This distributes fee transfers smoothly across vault activity without lumpy batches or dedicated harvest operations.

**Fee Calculation Mechanism:**
1. Track timestamp of last fee collection and total fees collected
2. On any external call: calculate newly accrued profit since last collection
3. Apply performance fee percentage to newly accrued profit
4. Transfer fees immediately and update tracking state
5. Accrual rate mechanism (ADR-003) continues tracking remaining profit for depositors

This ensures share value always reflects net-of-fee economics while distributing fee transfers across normal vault operations.

### Options Considered

**Continuous Collection on External Calls (chosen)**
Transfer fees before any external operation (deposit, withdraw, executeArbitrage, etc.). Trade-offs: Smooth fee distribution, no lumpy transfers, simple to implement (hook in modifier), minimal gas overhead per call; fees transfer frequently (but small amounts each time).

**Collection on Position Claim Only**
Fees transferred only when claimPosition() executes. Trade-offs: Fewer fee transfers, concentrated on claim operations; creates lumpy fee transfers, doesn't leverage continuous accrual mechanism, delays fee collection unnecessarily.

**Periodic Harvest**
Separate harvest() function called manually to transfer accumulated fees. Trade-offs: Batched transfers reduce total gas for transfers; requires operational discipline, fees can accumulate for long periods, uncollected fees temporarily inflate share value, complex to track.

**No Fee Collection (Minting Shares)**
Mint fee shares to recipient instead of transferring tokens. Trade-offs: No token transfers needed, gas efficient; dilutes existing shareholders, complex accounting for fee recipient to realize value, doesn't match FR-08 requirement for fee distribution.

### Consequences

**Fee Collection Behavior**
- Before any external call, calculate and transfer pending fees based on accrued profit.
- Fee calculation uses newly accrued profit multiplied by performance fee percentage.
- Fees transfer in small amounts distributed across all vault activity.
- Fee recipient receives steady stream rather than lumpy batches.

**Accounting Impact**
- Share value always reflects net-of-fee economics (no temporary inflation from uncollected fees).
- Deposits and withdrawals price fairly at all times.
- Accrual rate mechanism (ADR-003) tracks profit for depositors after fees.

**Gas Considerations**
- Minimal overhead: one fee transfer per external call (regardless of operation complexity).
- Fee transfer gas cost spread across all operations, not concentrated on claims.
- Total gas similar to claim-only approach but distributed more evenly.

**State Tracking Required**
- Timestamp of last fee collection
- Total fees collected to date
- Performance fee percentage
- Fee recipient address
- No dedicated harvest function needed

### On-Chain Implementation Notes

**Fee Collection Mechanism**
- Implement fee collection hook executed before external operations
- Hook calculates time elapsed since last collection
- Calculate newly accrued profit using accrual rate mechanism
- Apply performance fee percentage to newly accrued profit
- Transfer fee amount to recipient address
- Update tracking state (last collection timestamp, total fees collected)

**Function Application**
- Apply fee collection to: deposit, withdrawal, arbitrage execution, position claiming
- Internal functions and view functions do not trigger fee collection
- Each external call triggers exactly one fee collection (no batching within transaction)

**Integration with Accrual Rate (ADR-003)**
- Fee collection reduces profit available to depositors
- Accrual rate mechanism tracks net profit after fees
- Share value calculation uses net accrued profit (after fees)
- Performance fee percentage configurable by authorized roles

### Dependencies

- ADR-003 (Position Accounting Model): Accrual rate mechanism provides continuous profit tracking for fee calculation.

### References

- FR-07: Profit Compounding
- FR-08: Performance Fee Collection
