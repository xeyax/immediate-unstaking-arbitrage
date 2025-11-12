## ADR-006 — Withdrawal Liquidity Management

**Status**: Proposed
**Date**: 2025-11-06
**Deciders**: Smart Contract Engineering Team
**Related FRs**: FR-01, FR-04

### Context

The vault deploys capital into 7-day unstaking positions to capture arbitrage profit. During this period, deployed capital is illiquid. Users requesting withdrawals via the withdrawal queue (ADR-001) must wait for either idle capital availability or position maturation.

Without intervention, maximum withdrawal time equals 7 days (full cooldown period). The vault can reduce wait times by actively finalizing matured unstaking positions when withdrawal requests arrive. This creates a trade-off between gas efficiency (batch finalization by keeper) and user experience (immediate finalization on withdrawal request).

### Decision

**Accept maximum 7-day withdrawal period without artificial deployment limits.** The vault does not enforce maxUtilization or maxPositionSize constraints. When withdrawal requests arrive with insufficient idle capital, the vault attempts to finalize matured positions to free liquidity. This approach prioritizes capital efficiency (full deployment possible) over guaranteed instant withdrawals.

Users accept that withdrawal fulfillment time ranges from immediate (idle capital available) to 7 days maximum (waiting for position maturation). The vault actively finalizes matured positions on withdrawal requests to minimize wait times without sacrificing deployment efficiency.

### Options Considered

**No Deployment Limits with Active Finalization (chosen)**
Allow full capital deployment; vault finalizes matured positions when withdrawals requested. Trade-offs: Maximum capital efficiency, no artificial constraints on profitable opportunities, simple implementation; users may wait up to 7 days for withdrawals, gas costs for finalization paid on withdrawal requests.

**Reserved Liquidity (maxUtilization)**
Enforce percentage cap on deployed capital to maintain withdrawal reserves. Trade-offs: Guarantees some instant withdrawal capacity, predictable liquidity availability; reduces capital efficiency, idle capital earns no yield, requires parameter tuning, doesn't eliminate wait times (just reduces them).

**Position Size Limits (maxPositionSize)**
Cap individual trade sizes to limit concentration. Trade-offs: Limits per-position exposure; no actual risk benefit (keeper cannot cause losses, all unstaking operations identical), reduces capital deployment speed, arbitrary parameter choice.

**Keeper-Only Finalization**
Only authorized keepers can finalize positions, no automatic finalization on withdrawals. Trade-offs: Lower gas costs (batch finalization), simpler withdrawal flow; maximum 7-day wait even when matured positions exist, poor user experience, operational dependency on keeper availability.

### Consequences

**Deployment Behavior**
- No maxPositionSize or maxUtilization constraints on executeArbitrage().
- Keeper can deploy 100% of vault capital if profitable opportunities exist.
- Capital efficiency maximized; all idle capital can capture arbitrage spreads.

**Withdrawal Behavior**
- Withdrawal requests check idle capital first.
- If insufficient idle capital, vault attempts to finalize matured positions (cooldown >= 7 days).
- If no matured positions available, withdrawal queued until next position matures.
- Maximum wait time: 7 days (one full cooldown period).
- Users informed of expected wait time when requesting withdrawal.

**Gas Considerations**
- Position finalization costs paid on withdrawal requests when triggered.
- Keeper can still batch-finalize positions for gas efficiency.
- Trade-off: user pays gas for immediate liquidity vs. waiting for keeper batch.

### On-Chain Implementation Notes

**Withdrawal Flow Enhancement**
- withdraw() / redeem() functions check USDe.balanceOf(vault) for idle capital.
- If idle capital insufficient, call _finalizeMaturedPositions() internal function.
- _finalizeMaturedPositions() iterates positions where block.timestamp >= startTime + COOLDOWN_PERIOD.
- Finalize positions until sufficient liquidity available or no more matured positions.
- If still insufficient, add to withdrawal queue with estimated fulfillment time.

**Position Tracking**
- Maintain position array or enumerable set for iteration during finalization.
- Track position.startTime to determine maturation (startTime + 7 days <= block.timestamp).
- No limit enforcement on position count or total deployed capital.

**Estimated Wait Time**
- Calculate earliest position maturation time for queued withdrawals.
- Emit event with estimated fulfillment time when withdrawal queued.
- Users can query their position in queue and expected wait time.

### Dependencies

- ADR-001 (Vault Token Standard): Withdrawal queue mechanism handles cases where finalization insufficient.
- ADR-004 (Price Discovery Mechanism): No deployment limits means keeper can execute all profitable opportunities.

### ADRs Depending on This

- ADR-007 (Fee Collection Timing): Position finalization timing affects when fees collectible.

### References

- [Ethena sUSDe Cooldown Mechanism](https://docs.ethena.fi/solution-overview/usde-overview/staked-usde) - 7-day unstaking period
- [ERC-4626 Withdrawal Mechanics](https://eips.ethereum.org/EIPS/eip-4626) - withdraw() and redeem() specifications
