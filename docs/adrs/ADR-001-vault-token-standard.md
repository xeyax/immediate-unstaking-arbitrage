## ADR-001 — Vault Token Standard

**Status**: Proposed
**Date**: 2025-11-06
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

**Option A** — Full ERC-4626 compliance with withdrawal queues (chosen)
Implement standard ERC-4626 where withdrawals exceeding idle capacity enter a queue, fulfilled as positions mature. Requires additional state for request tracking and fulfillment logic. Trade-off: Ensures users can always exit eventually, prevents indefinite liquidity lock; adds implementation complexity and gas overhead for queue management.

**Option B** — ERC-4626 with liquidity constraints
Implement ERC-4626 where withdrawals revert if idle capital insufficient, with `maxWithdraw` accurately reflecting current capacity. Trade-off: Simpler implementation; users could be permanently unable to withdraw if vault continuously redeploys capital, violating user expectation of eventual exit.

**Option C** — Custom non-tokenized shares
Use internal `balanceOf` mapping with non-transferable shares. Trade-off: Simpler implementation; no composability with DeFi ecosystem, users cannot use shares as collateral or in other protocols.

**Do nothing** — Fails FR-01 requirement for fair share-based deposits and withdrawals. Non-compliant with DeFi standards reduces vault utility and integration potential.

### Consequences

- Vault becomes composable with ERC-4626-compatible protocols.
- Share tokens can be transferred, used as collateral, or integrated with yield aggregators.
- Withdrawal queue requires additional state to track pending requests with request IDs, user addresses, and share amounts.
- Queue fulfillment logic must process requests FIFO as liquidity becomes available from maturing positions.
- Users can always request withdrawals that will eventually be fulfilled, preventing indefinite liquidity lock.
- Vault can maintain high capital efficiency by deploying most assets into arbitrage while still honoring withdrawal requests.
- Two withdrawal paths: immediate (standard ERC-4626) when liquidity available, or queued when liquidity insufficient.
- Emergency pause affects deposits, new arbitrage positions, and queue fulfillment.

### On-Chain Implementation Notes

- Inherit OpenZeppelin ERC4626 base contract with ERC20 token semantics.
- Override `totalAssets()` to reflect all vault assets (NAV calculation method defined in ADR-002).
- Implement withdrawal queue for requests that exceed available liquidity.

**User-facing function signatures:**
- Standard ERC-4626: `deposit()`, `mint()`, `withdraw()`, `redeem()` - for deposits and immediate withdrawals
- Queue functions: `requestWithdrawal(uint256 shares) → uint256 requestId` - queues withdrawal when liquidity insufficient
- `cancelWithdrawalRequest(uint256 requestId)` - allows user to cancel pending request
- `getWithdrawalRequest(uint256 requestId)` - query request status

**Events:**
- Standard ERC-4626 events for deposits and withdrawals
- `WithdrawalRequested(uint256 indexed requestId, address indexed user, uint256 shares)`
- `WithdrawalFulfilled(uint256 indexed requestId, address indexed user, uint256 assets)`

Queue processing details (keeper operations, FIFO ordering, batch processing) are implementation concerns beyond this architectural decision.

### Dependencies

- No dependencies; foundational decision.

### ADRs Depending on This

- ADR-002 (NAV Calculation Method): Must specify how to value locked positions in `totalAssets()`.
- ADR-003 (Position Accounting Model): Position tracking feeds into NAV for share pricing.

### References

- [EIP-4626: Tokenized Vault Standard](https://eips.ethereum.org/EIPS/eip-4626)
- [OpenZeppelin ERC4626 Implementation](https://docs.openzeppelin.com/contracts/4.x/erc4626)
