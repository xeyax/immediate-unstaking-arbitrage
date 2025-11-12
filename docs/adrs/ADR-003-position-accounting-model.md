## ADR-003 — Position Accounting Model

**Status**: Proposed
**Date**: 2025-11-06
**Deciders**: Smart Contract Engineering Team
**Related FRs**: FR-04, FR-05

### Context

The vault must track multiple concurrent unstaking positions to calculate NAV accurately and enable claiming matured positions. Per ADR-002, NAV calculation requires time-weighted accrual for fair profit recognition. Each position has a 7-day cooldown before becoming claimable.

The challenge is efficiently calculating NAV without iterating all positions (which would have unbounded gas costs), while preserving individual position information needed for claim operations and profit tracking.

### Decision

Track individual positions for claim management while using **accrual rate approach** for O(1) NAV calculation. Maintain a single aggregate rate representing the current speed of profit accumulation across all active positions. Update this rate when positions open or close, and before any vault operation (deposit, withdrawal, NAV query) to ensure matured positions are finalized and the rate reflects current state. This avoids iterating positions during NAV calculation.

### Options Considered

**Accrual Rate Approach (chosen)**
Maintain aggregate accrual rate representing profit accumulation speed. When position opens: add its contribution to the rate. When position is claimed: subtract its contribution from the rate. NAV calculation becomes O(1) time-based computation. Trade-offs: Gas-efficient NAV queries independent of position count; requires update before any vault operation to finalize matured positions; full position granularity preserved for claims.

**Iteration-Based Approach**
Store each position; iterate all positions to sum time-weighted accrued profits during NAV calculation. Trade-offs: Simple logic, no synchronization complexity; gas cost scales linearly with position count, problematic for frequent NAV queries in deposit/withdrawal flows.

**Aggregate Only**
Track only total book value and total expected profit; no individual positions. Trade-offs: Very low gas cost; fails FR-04 requirement to track individual positions for claiming, prevents per-position profit analysis.

### Consequences

**Core Principle**
- Track aggregate accrual rate representing how fast profit accumulates across all active positions.
- When position opens: increase the rate by this position's contribution.
- When position matures and is claimed: decrease the rate by this position's contribution, recognize profit as realized.
- NAV = idle capital + realized profit + (accrual rate × time elapsed).

**Key Requirements**
- Before any vault operation (deposit, withdrawal, share price query), finalize matured positions and update accrual rate to reflect current state.
- This ensures NAV is accurate even if keeper hasn't yet claimed matured positions.
- Position struct stores individual position data for claim management and profit tracking.
- NAV calculation is O(1) regardless of position count.

**Trade-offs**
- Additional complexity: must synchronize rate updates with position lifecycle.
- Benefit: Gas-efficient NAV queries, especially important for deposit/withdrawal flows that call totalAssets() multiple times.
- Invariant: Accrual rate must accurately reflect sum of all active position contributions.

### On-Chain Implementation Notes

**Accrual Rate Mechanics**
- Maintain aggregate accrual rate and last update timestamp.
- Maintain accumulated realized profit from all claimed positions.
- Before any operation: finalize matured positions, update accumulated profit based on time elapsed, reset timestamp.

**Opening Position**
- Calculate expected profit for this position.
- Increase accrual rate by (expected profit / cooldown period).
- Store position with individual tracking data.

**Claiming Position**
- Decrease accrual rate by (position's expected profit / cooldown period).
- Add position's profit to accumulated realized profit.
- Mark position as claimed.

**NAV Calculation (O(1))**
- NAV = idle USDe + accumulated realized profit + (accrual rate × time elapsed since last update).
- No iteration over positions required.

### Dependencies

- ADR-001: ERC-4626 totalAssets() must incorporate position values.
- ADR-002: NAV uses convertToAssets() requiring sUSDe amounts as primary unit.

### References

- [Ethena sUSDe Documentation](https://docs.ethena.fi/)
- FR-04: Unstaking Position Tracking
- FR-05: Share Value Calculation
