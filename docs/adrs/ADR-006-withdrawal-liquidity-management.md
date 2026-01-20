## ADR-006 — Withdrawal Liquidity Management

**Status**: Implemented
**Date**: 2025-11-06 (Implemented: 2025-11-21)
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

**Withdrawal Behavior (Fully Async Model - Updated 2025-11-24)**
- **`requestWithdrawal(shares)`** - PRIMARY and ONLY withdrawal method (async via queue)
- `redeem(shares)` - **DISABLED** (reverts with "use requestWithdrawal()")
- `maxRedeem(user)` - Always returns 0 (honest signal: no immediate withdrawals)
- **All withdrawals are asynchronous** - simplifies code, maximizes FIFO fairness
- Queue fulfilled in FIFO order when:
  - **Idle liquidity available** - instant fulfillment within same transaction (**NEW**)
  - **Anyone** claims matured positions via `claimPosition()` (**PERMISSIONLESS** - no keeper required!)
  - New deposits arrive (auto-fulfills queue with fresh liquidity)
- **Fairness invariant:** `idle_liquidity == 0 OR pending_queue.length == 0` (never both > 0)
  - This ensures queued users always have priority over idle capital
  - Depositors receive shares at current NAV before their capital fulfills queue (no dilution)
- **Guaranteed maximum wait time:** 7 days (one full cooldown period)
  - After 7 days, anyone (including queued user) can call `claimPosition()` to fulfill
  - No centralization: users not dependent on keeper availability
- **Typical wait time:** Instant (if idle liquidity) or 1-2 blocks (if keeper or other users active)
- Escrow mechanism: shares held in contract, assets calculated at fulfillment time (dynamic NAV fairness)

**Gas Considerations**
- Position finalization costs paid on withdrawal requests when triggered.
- Keeper can still batch-finalize positions for gas efficiency.
- Trade-off: user pays gas for immediate liquidity vs. waiting for keeper batch.

### On-Chain Implementation Notes (Updated for FIFO - 2025-11-21)

**Withdrawal Flow (Fully Async with Auto-Fulfill - Updated 2025-11-24)**
- `redeem(shares)` **ALWAYS REVERTS** (disabled - async-only model)
- `requestWithdrawal(shares)` - **ONLY** withdrawal method (creates queue entry, auto-fulfilled if idle liquidity)
- `maxRedeem(user)` always returns 0 (no synchronous redeem(), must use requestWithdrawal())
- `maxWithdraw(user)` always returns 0 (no synchronous withdraw(), must use requestWithdrawal())
- **All withdrawals go through queue** - but instantly fulfilled in same transaction if idle liquidity available
- **Fairness invariant**: `idle_liquidity == 0 OR pending_queue.length == 0` (queue has priority)
- **Permissionless fulfillment** - anyone can call claimPosition() to advance queue
- Users in queue can trigger their own fulfillment (no keeper dependency)

**Key Difference from Original ADR:**
- Original: iterate all positions, claim any ready position
- FIFO Implementation: claim only firstActivePositionId if ready
- Simpler, respects ADR-003 FIFO claim order, but may queue more often

**Queue Integration with Position Finalization**
- When keeper finalizes matured position, released USDe distributed in order:
  1. Fulfill queued withdrawals (FIFO) until queue empty or USDe depleted
  2. Remaining USDe replenishes vault idle balance
- Partial fulfillment supported: large withdrawal requests fulfilled across multiple position maturations
- Users notified via WithdrawalFulfilled events as their requests processed

**Position Tracking**
- Maintain position array or enumerable set for iteration during finalization.
- Track position.startTime to determine maturation (startTime + 7 days <= block.timestamp).
- No limit enforcement on position count or total deployed capital.

**Wait Time Transparency**
- Maximum wait time: 7 days (one cooldown period) - guaranteed by ADR
- Typical wait time: Instant (if idle liquidity available)
- Users can query their withdrawal request via `getWithdrawalRequest(requestId)` to see fulfillment status
- Off-chain: UIs can calculate ETA by checking `firstActivePositionId` and its maturation time
- No on-chain ETA calculation needed - instant fulfillment in typical case makes it less relevant

### DoS Protection Mechanisms (Added 2026-01-20)

**Problem:** Unbounded withdrawal queue with O(N) left-shift removal could exceed block gas limit at ~2000 requests, causing DoS on `claimPosition()` and `cancelWithdrawal()`.

**Solution:** Three-layer protection:

1. **O(1) Queue Operations**
   - Head/tail pointer queue instead of array shifting
   - `withdrawalQueueHead` / `withdrawalQueueTail` track active range
   - Cancelled requests mark slot as empty (skipped during fulfillment)
   - Head advances when removing first element
   - Fulfillment bounded by `maxWithdrawalsPerTx` (default 20)

2. **Minimum Withdrawal Size**
   - `MIN_WITHDRAWAL_ASSETS = 1e18` (1 USDe, ~$1)
   - Increases economic cost of queue spam attacks
   - Checked in assets (not shares) for stable USD-denominated minimum

3. **Cancel Cooldown**
   - `MIN_TIME_BEFORE_CANCEL = 5 minutes`
   - Prevents request/cancel spam that fills queue with empty slots
   - User must wait 5 minutes before cancelling their request

**Queue Implementation Details:**
- `pendingWithdrawalCount()` returns approximate count (tail - head, includes empty slots)
- `getActivePendingCount()` returns exact count (iterates queue - O(N), use sparingly)
- Request IDs start at 1 (not 0) so 0 means empty slot
- Queue indices start at 1 so 0 means "not in queue"

### Dependencies

- ADR-001 (Vault Token Standard): Withdrawal queue mechanism handles cases where finalization insufficient.
- ADR-004 (Price Discovery Mechanism): No deployment limits means keeper can execute all profitable opportunities.

### ADRs Depending on This

- ADR-007 (Fee Collection Timing): Position finalization timing affects when fees collectible.

### References

- [Ethena sUSDe Cooldown Mechanism](https://docs.ethena.fi/solution-overview/usde-overview/staked-usde) - 7-day unstaking period
- [ERC-4626 Withdrawal Mechanics](https://eips.ethereum.org/EIPS/eip-4626) - withdraw() and redeem() specifications
