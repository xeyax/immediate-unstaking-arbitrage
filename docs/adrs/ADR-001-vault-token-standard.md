## ADR-001 — Vault Token Standard (Simplified ERC-4626)

**Status**: Implemented (Simplified)
**Date**: 2025-11-06 (Updated: 2025-11-23)
**Deciders**: Smart Contract Engineering Team
**Related FRs**: FR-01, FR-05

### Context

The vault requires a share accounting mechanism for depositors to track ownership and claim proportional assets during withdrawals. The challenge stems from the 7-day unstaking period creating partially illiquid positions. When capital is deployed in sUSDe awaiting unstaking, immediate withdrawals can only access idle USDe, not locked positions.

Without a withdrawal queue mechanism, users could be permanently unable to withdraw if vault continuously redeploys returned capital into new arbitrage positions. For example: capital returns from unstaking → immediately used for new sUSDe purchase → locked again for 7 days. Users would wait indefinitely for liquidity that never materializes.

ERC-4626 provides a standardized tokenized vault interface with deposit/withdraw/mint/redeem functions, enabling composability with lending protocols, aggregators, and other DeFi infrastructure. However, standard ERC-4626 assumes immediate withdrawals, which conflicts with our partially illiquid positions requiring a queuing mechanism.

### Decision

Implement ERC-4626 with withdrawal queue system. When withdrawals exceed idle USDe capacity, they enter a queue and are fulfilled as unstaking positions mature and capital becomes available. Vault shares are standard ERC-20 tokens with full composability, while the queue ensures users can always request withdrawals that will eventually be fulfilled.

This guarantees users can exit their positions while maintaining capital efficiency for arbitrage operations.

### Options Considered

**Option A** — Simplified ERC-4626 with withdrawal queues (chosen)
Implement simplified ERC-4626 (only `deposit(assets)` and `redeem(shares)`) where redemptions exceeding idle capacity enter a queue, fulfilled as positions mature. The redundant `mint(shares)` and `withdraw(assets)` functions are omitted to reduce code duplication. Trade-off: Ensures users can always exit eventually, prevents indefinite liquidity lock, reduces complexity; not fully compliant with ERC-4626 (but deposit/redeem cover 95% of use cases).

**Option B** — ERC-4626 with liquidity constraints
Implement ERC-4626 where withdrawals revert if idle capital insufficient, with `maxWithdraw` accurately reflecting current capacity. Trade-off: Simpler implementation; users could be permanently unable to withdraw if vault continuously redeploys capital, violating user expectation of eventual exit.

**Option C** — Custom non-tokenized shares
Use internal `balanceOf` mapping with non-transferable shares. Trade-off: Simpler implementation; no composability with DeFi ecosystem, users cannot use shares as collateral or in other protocols.

**Do nothing** — Fails FR-01 requirement for fair share-based deposits and withdrawals. Non-compliant with DeFi standards reduces vault utility and integration potential.

### Consequences

- Vault becomes composable with ERC-4626-compatible protocols.
- Share tokens can be transferred, used as collateral, or integrated with yield aggregators.
- Withdrawal queue requires additional state to track pending requests with request IDs, user addresses, and share amounts.
- Queue fulfillment logic processes requests in FIFO order as liquidity becomes available.
- Users can cancel pending withdrawal requests at any time (cancellation returns shares to user).
- Partial fulfillment supported: when position matures, released USDe fulfills queued withdrawals in FIFO order until depleted, then remainder replenishes vault idle USDe.
- Users can always request withdrawals that will eventually be fulfilled, preventing indefinite liquidity lock.
- Vault can maintain high capital efficiency by deploying most assets into arbitrage while still honoring withdrawal requests.
- Two withdrawal paths: immediate (standard ERC-4626) when liquidity available, or queued when liquidity insufficient.

**Example: Partial Fulfillment Flow**
- User requests 100 USDe withdrawal, but only 30 USDe idle → 30 USDe fulfilled immediately, 70 USDe queued
- Position A matures releasing 50 USDe → 50 USDe goes to queued request (now 20 USDe remaining in queue)
- Position B matures releasing 100 USDe → 20 USDe completes queued request (WithdrawalFulfilled event), 80 USDe goes to vault idle balance
- User receives total 100 USDe across 3 transactions (30 + 50 + 20)

### On-Chain Implementation Notes

- Inherit OpenZeppelin ERC4626 base contract with ERC20 token semantics.
- Override `totalAssets()` to reflect all vault assets (NAV calculation method defined in ADR-002).
- Implement withdrawal queue for requests that exceed available liquidity.

**Inflation Attack Protection:**

Override `_decimalsOffset()` returning 8 to protect against the ERC-4626 inflation/donation attack:

```solidity
function _decimalsOffset() internal view virtual override returns (uint8) {
    return 8;
}
```

Without this protection, an attacker could:
1. Deposit 1 wei to get 1 share (first depositor)
2. Donate large amount directly to vault (e.g., 100 USDe)
3. Victim deposits 50 USDe but receives 0 shares (integer division rounds down)
4. Attacker withdraws their 1 share worth 150 USDe (stealing victim's deposit)

With `_decimalsOffset() = 8`, OpenZeppelin adds 10^8 "virtual" shares and assets to the conversion formulas. This means an attacker would need to donate ~$200M to steal $1, making the attack economically infeasible.

| Offset | Donation needed to steal $1 |
|--------|----------------------------|
| 6 | ~$2M |
| 7 | ~$20M |
| 8 | ~$200M |

**Note:** This changes the shares:assets ratio. Depositing 1000 USDe yields ~1000×10^8 shares instead of 1000 shares. The value remains correct — `convertToAssets(shares)` always returns the proper USDe value.

**User-facing function signatures (Async-Only Withdrawal Model):**
- ✅ `deposit(assets, receiver)` → shares - **PRIMARY** deposit method (synchronous, immediate)
  - Auto-fulfills pending withdrawal queue with new liquidity
- ✅ `requestWithdrawal(shares, receiver, owner)` → requestId - **PRIMARY and ONLY** withdrawal method (async queue)
  - Escrow mechanism: shares held in contract, assets at fulfillment NAV (fairness)
- ❌ `redeem(shares)` - **DISABLED** (always reverts: "use requestWithdrawal()")
- ❌ `mint(shares)` - **DISABLED** (always reverts: "use deposit()")
- ❌ `withdraw(assets)` - **DISABLED** (always reverts: "use redeem() → which reverts → use requestWithdrawal()")
- 📊 `maxRedeem(user)` → always 0 (honest signal: no immediate withdrawals available)
- 🔍 `cancelWithdrawal(requestId)` - cancel pending request, FIFO-safe removal
- 🔍 `getWithdrawalRequest(requestId)` - query request status

**Rationale for Async-Only Model:**
- Perfect FIFO fairness (no queue jumping, everyone treated equally)
- Simpler code (no complex conditional logic)
- Escrow + dynamic NAV (users benefit from profit during wait)
- Keeper-driven fulfillment (typically 1-2 blocks delay)

**Events:**
- Standard ERC-4626 events for deposits and withdrawals
- `WithdrawalRequested(uint256 indexed requestId, address indexed user, uint256 shares)`
- `WithdrawalFulfilled(uint256 indexed requestId, address indexed user, uint256 assets)`
- `WithdrawalCancelled(uint256 indexed requestId, address indexed user, uint256 shares)`

**Queue Fulfillment:**
- When unstaking position completes, released USDe fulfills queued withdrawals in FIFO order
- Partial fulfillment supported: requests fulfilled across multiple position maturations
- Remaining USDe replenishes vault idle balance

**Cancellation:**
- Users can cancel pending withdrawal requests at any time
- Cancellation returns unfulfilled shares to user

### Dependencies

- No dependencies; foundational decision.

### ADRs Depending on This

- ADR-002 (NAV Calculation Method): Must specify how to value locked positions in `totalAssets()`.
- ADR-003 (Position Accounting Model): Position tracking feeds into NAV for share pricing.

### References

- [EIP-4626: Tokenized Vault Standard](https://eips.ethereum.org/EIPS/eip-4626)
- [OpenZeppelin ERC4626 Implementation](https://docs.openzeppelin.com/contracts/4.x/erc4626)
