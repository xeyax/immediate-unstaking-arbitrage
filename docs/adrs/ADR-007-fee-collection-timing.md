## ADR-007 — Fee Collection Timing

**Status**: Accepted
**Date**: 2025-11-06 (Updated: 2025-11-24)
**Deciders**: Smart Contract Engineering Team
**Related FRs**: FR-07, FR-08

### Context

The vault collects performance fees on realized arbitrage profits per FR-08. The timing and mechanism of fee collection affects share value accuracy, accounting complexity, and gas costs.

Profit accumulates continuously via the accrual rate mechanism (ADR-003). Fees must be calculated on this accrued profit and transferred to the fee recipient. The challenge is determining when to calculate and transfer fees: on position claim only, periodically, or on any vault interaction.

Collecting fees on every external call adds gas overhead (~50k per operation) and complexity. Periodic harvesting adds operational complexity. A "net-of-fee NAV" approach provides continuous accrual tracking without gas overhead on deposits/withdrawals.

### Decision

**Use "Net-of-Fee NAV" approach: reflect fees in share value continuously, transfer on position claim only.**

Instead of collecting fees on every external call, apply the performance fee discount directly in the NAV calculation (`totalAssets()`). When positions are claimed and profit is realized, transfer the fee portion to the recipient. This provides continuous accrual tracking (share value always net-of-fee) without gas overhead on deposits/withdrawals.

**Fee Mechanism:**
1. **NAV Calculation (continuous):** `totalAssets()` applies fee percentage to unrealized profit
   - `netProfit = unrealizedProfit × (1 - feePercentage)`
   - Share value always reflects net-of-fee economics
   - No gas overhead - happens in view function

2. **Fee Transfer (on claim):** When `claimPosition()` executes
   - Calculate realized profit: `realizedProfit = receivedAssets - bookValue`
   - Transfer fee: `feeAmount = realizedProfit × feePercentage`
   - Vault receives: `receivedAssets - feeAmount` (matches net-of-fee NAV)
   - One token transfer per position claim

This ensures share value always reflects net-of-fee economics while minimizing gas costs and maintaining simplicity.

### Options Considered

**Net-of-Fee NAV (chosen)**
Apply fee discount in `totalAssets()` calculation, transfer actual fee on position claim. Trade-offs: Continuous accrual reflection in NAV, zero gas overhead on deposits/withdrawals, simple implementation (two function changes), matches ADR-003 accrual mechanism; fee transfers are lumpy (concentrated on claims), but NAV is always accurate.

**Continuous Collection on External Calls**
Transfer fees before any external operation (deposit, withdraw, executeArbitrage, etc.). Trade-offs: Smooth fee distribution via transfers, simple hook pattern; adds ~50k gas per external call, complex interaction with withdrawal queue auto-fulfill, increases attack surface.

**Collection on Position Claim Only (without NAV adjustment)**
Fees transferred when claimPosition() executes, but NAV includes full unrealized profit until claim. Trade-offs: Simple, low gas; NAV temporarily inflated by uncollected fees, unfair pricing for deposits/withdrawals between claims, violates net-of-fee principle.

**Periodic Harvest**
Separate harvest() function called manually to transfer accumulated fees. Trade-offs: Batched transfers; requires operational discipline, fees accumulate for long periods, uncollected fees inflate share value, complex to track, doesn't match continuous accrual design.

**No Fee Collection (Minting Shares)**
Mint fee shares to recipient instead of transferring tokens. Trade-offs: No token transfers needed, gas efficient; dilutes existing shareholders, complex accounting for fee recipient to realize value, doesn't match FR-08 requirement for fee distribution.

### Consequences

**Fee Collection Behavior**
- NAV calculation (`totalAssets()`) continuously applies fee discount to unrealized profit
- Fee transfers occur only on `claimPosition()` - one transfer per position claim
- Fee recipient receives lumpy transfers (concentrated on claims), but this is acceptable given gas savings
- Total fees tracked via `totalFeesCollected` state variable

**Accounting Impact**
- Share value **always** reflects net-of-fee economics (no temporary inflation from uncollected fees)
- Deposits and withdrawals price fairly at all times using net-of-fee NAV
- Accrual rate mechanism (ADR-003) continues tracking gross profit; fee applied at NAV calculation layer
- **Invariant maintained:** After claim, vault balance equals pre-claim NAV prediction

**Gas Considerations**
- **Zero overhead on deposits/withdrawals** - fee calculation happens in view function only
- **One token transfer per position claim** (~50k gas) - concentrated but infrequent
- Compared to continuous collection: saves ~150k gas per deposit/withdraw/arbitrage cycle
- Total gas per cycle: ~50k (vs ~200k for continuous collection)

**State Tracking Required**
- Total fees collected to date (`totalFeesCollected`)
- Performance fee percentage (`performanceFee`)
- Fee recipient address (`feeRecipient`)
- No timestamp tracking needed (fee applied at calculation time, not collection time)

### On-Chain Implementation Notes

**NAV Calculation (Net-of-Fee)**
```solidity
function totalAssets() public view returns (uint256) {
    uint256 idle = IERC20(asset()).balanceOf(address(this));
    (uint256 bookValue, uint256 unrealizedProfit) = _calculatePositionsValue();

    // Apply fee discount to unrealized profit
    uint256 netProfit = performanceFee > 0
        ? (unrealizedProfit * (10000 - performanceFee)) / 10000
        : unrealizedProfit;

    return idle + bookValue + netProfit;
}
```

**Fee Transfer (On Claim)**
```solidity
function _claimPosition(uint256 positionId) internal {
    // ... claim logic ...
    uint256 realizedProfit = receivedAssets - position.bookValue;

    if (realizedProfit > 0 && performanceFee > 0) {
        uint256 feeAmount = (realizedProfit * performanceFee) / 10000;
        IERC20(asset()).safeTransfer(feeRecipient, feeAmount);
        totalFeesCollected += feeAmount;
        emit FeeCollected(positionId, feeAmount, realizedProfit);
    }
    // ... rest of claim logic ...
}
```

**Integration with Accrual Rate (ADR-003)**
- Accrual rate mechanism (ADR-003) tracks gross unrealized profit
- Fee discount applied at NAV calculation layer (`totalAssets()`)
- Share value uses net-of-fee NAV for pricing deposits/withdrawals
- When position claimed, actual fee transferred and vault receives net amount
- Invariant: `vault_balance_after_claim == NAV_before_claim × total_shares`

**Integration with Withdrawal Queue (ADR-006)**
- `convertToAssets()` uses `totalAssets()` which is already net-of-fee
- Queued withdrawals automatically priced at net-of-fee value
- Fee collection on claim happens **after** auto-fulfill to maintain fairness invariant
- Order: claim → receive assets → transfer fee → auto-fulfill queue with remaining balance

### Edge Cases & Examples

**Example: Full Lifecycle with Fee**
```
Setup:
- User deposits 1000 USDe (receives 1000 shares @ NAV=1.0)
- Arbitrage: bookValue=1000, expectedAssets=1050 (50 profit expected)
- Performance fee = 10%

Timeline:
T0 (deposit):     NAV = 1000/1000 = 1.0
T1 (3.5 days):    unrealizedProfit = 25 USDe (50% accrued)
                  netProfit = 25 × 0.9 = 22.5 USDe
                  NAV = (1000 + 22.5)/1000 = 1.0225

T2 (7 days):      unrealizedProfit = 50 USDe (100% accrued)
                  netProfit = 50 × 0.9 = 45 USDe
                  NAV = (1000 + 45)/1000 = 1.045

T3 (claim):       receivedAssets = 1050 USDe
                  realizedProfit = 50 USDe
                  feeAmount = 50 × 0.1 = 5 USDe → feeRecipient
                  vaultBalance = 1050 - 5 = 1045 USDe
                  NAV = 1045/1000 = 1.045 ✅ matches pre-claim!
```

**Edge Case: Fee Change Mid-Accrual**
If `performanceFee` changes during position cooldown:
- NAV calculation uses current fee value → instant adjustment
- At claim, current fee value used for transfer
- Fair: all users see same fee at any point in time
- Alternative (not implemented): lock fee at position open time

**Edge Case: Position Loss**
```solidity
realizedProfit = receivedAssets > bookValue
    ? receivedAssets - bookValue
    : 0;  // No profit

if (realizedProfit > 0 && performanceFee > 0) {
    // Only collect fee if profit > 0
}
```
No fee collected on losses - correct behavior.

**Edge Case: Zero Fee**
If `performanceFee == 0`:
- NAV calculation: `netProfit = unrealizedProfit` (no discount)
- At claim: no transfer (saves gas)
- Simplifies to fee-less vault

**Edge Case: Withdrawal Queue with Fees**
```
Scenario: User requests withdrawal while position accruing
- NAV includes net-of-fee profit → withdrawal priced correctly
- When position claimed → fee transferred AFTER auto-fulfill
- Queued users receive net-of-fee value (fair)
```

### Dependencies

- ADR-003 (Position Accounting Model): Accrual rate mechanism provides continuous profit tracking for fee calculation.
- ADR-006 (Withdrawal Liquidity Management): Fee collection integrated with auto-fulfill mechanism.

### References

- FR-07: Profit Compounding
- FR-08: Performance Fee Collection
- ADR-003: Position Accounting Model - Accrual Rate Mechanism
- ADR-006: Withdrawal Liquidity Management - Auto-Fulfill Integration
