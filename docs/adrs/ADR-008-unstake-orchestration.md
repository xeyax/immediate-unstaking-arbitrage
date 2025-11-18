## ADR-008 — Unstake Orchestration via Proxy Contracts

**Status**: Proposed
**Date**: 2025-11-18
**Deciders**: Smart Contract Engineering Team
**Related FRs**: FR-02, FR-04

### Context

The vault must execute multiple concurrent arbitrage trades, each requiring an unstaking operation through Ethena protocol's sUSDe contract. However, Ethena protocol enforces a critical constraint: **each address can have only one active unstaking operation at a time**. Once an address calls `cooldownShares()` or `cooldownAssets()`, it cannot initiate another unstake until the first operation completes (7-day cooldown period).

This constraint creates a significant operational bottleneck:
- If vault uses single address: maximum 1 arbitrage per 7 days
- Multiple profitable opportunities may occur within the same 7-day window
- Keeper cannot capture fleeting arbitrage spreads if vault address is locked

Without solving this constraint, the vault cannot maintain capital efficiency or capture time-sensitive arbitrage opportunities, fundamentally limiting the product's value proposition (FR-02: identify profitable arbitrage).

### Decision

**Use proxy contract pattern with vault-managed factory deployment.** Deploy a pool of lightweight proxy contracts, each acting as an independent Ethena protocol participant. When executing arbitrage, allocate a free proxy to initiate the unstaking operation. Track which proxy holds which position for later claiming.

The main vault contract contains factory logic to deploy proxies and coordinates proxy allocation and position tracking. Proxies serve as simple delegation wrappers for Ethena protocol calls. Admin calls `deployProxies(count)` on the vault to deploy additional proxies when needed based on operational requirements.

This approach enables concurrent unstaking operations while keeping deployment logic centralized in the vault contract.

### Options Considered

**Proxy Contract Pattern with Vault-Managed Factory (chosen)**
Vault contains factory logic to deploy proxies; admin calls `deployProxies(count)` as needed. Vault allocates free proxy for each arbitrage. Trade-offs: Enables unlimited concurrent unstakes, simple allocation logic, centralized deployment control, predictable gas costs; requires admin monitoring to trigger proxy deployment.

**Proxy Contract Pattern with Automatic Deployment**
Automatically deploy new proxy when all are busy. Trade-offs: Fully automated, no admin intervention; unpredictable gas costs (deployment mid-transaction), complex threshold logic, potential griefing via forced deployments.

**Batching Unstakes**
Group multiple arbitrage trades into single unstake operation. Trade-offs: Works within Ethena constraint; loses granular timing (must wait for batch), cannot capture individual opportunities, complex accounting for grouped positions.

**Queue Arbitrage Operations**
Queue trades when vault address busy; execute when unstake completes. Trade-offs: Simple implementation; misses time-sensitive opportunities (spreads may close), poor capital efficiency (idle capital while queued), violates FR-02 requirement to capture profitable arbitrage.

**Single Address (Do Nothing)**
Accept one unstake per 7 days limitation. Trade-offs: Simple; fundamentally broken product (cannot fulfill FR-02), unacceptable capital efficiency, non-viable for production.

### Consequences

**Architecture Overview**
```
┌──────────────────────────────────┐
│     ArbitrageVault (Main)        │
│  - Holds USDe/sUSDe              │
│  - Tracks positions               │
│  - Coordinates arbitrage          │
└───────────┬──────────────────────┘
            │
            │ allocates & releases
            ▼
┌──────────────────────────────────┐
│      UnstakeProxy[0..N]          │
│  - Minimal state                 │
│  - Calls Ethena on behalf        │
│  - Owned by vault                │
└──────────────────────────────────┘
```

**Proxy Contract Responsibilities**
- Store no funds (sUSDe transferred in, USDe transferred out)
- Call Ethena `cooldownShares(shares, owner)` to initiate unstake
- Call Ethena `unstake(receiver)` to claim USDe after 7 days
- Single-purpose contracts with no complex logic

**Vault Responsibilities**
- Contains factory logic to deploy proxy contracts via CREATE opcode
- Track which proxies are busy (active unstake) vs. available
- Allocate free proxy during `executeArbitrage()`
- Record proxy address in Position struct for later claiming
- Release proxy back to available pool after claiming

**Admin Operations**
- Calls `deployProxies(uint256 count)` to trigger vault factory deployment
- Vault deploys N new proxies in single transaction and registers them automatically
- Admin specifies quantity only; vault handles deployment, ownership, and registration
- No external proxy deployment or manual address tracking needed

**Allocation Strategy**
1. During `executeArbitrage()`: check for available proxy
2. If available: mark as busy, initiate unstake through proxy
3. If none available: revert with "No proxies available"
4. Admin can call `deployProxies(N)` to add more capacity

**Unstaking Flow**
1. Vault transfers sUSDe to allocated proxy
2. Vault calls `proxy.initiateUnstake(shares)`
3. Proxy calls Ethena `cooldownShares(shares, proxy)` → returns USDe amount
4. Store returned USDe amount in Position struct for NAV calculation
5. Mark proxy as busy for 7 days

**Claiming Flow**
1. Position matures (7 days elapsed)
2. Vault calls `claimPosition(positionId)`
3. Retrieve proxy address from Position struct
4. Vault calls `proxy.claimUnstake(vault)`
5. Proxy calls Ethena `unstake(vault)` → USDe sent directly to vault
6. Mark proxy as available (no longer busy)
7. Update position accounting in vault

**Error Handling**
- If all proxies busy: revert "No proxies available"
- Admin calls `deployProxies(N)` to add capacity
- Keeper monitors proxy availability off-chain
- No automatic fallback or queueing (keeps logic simple)

**Trade-offs**
- Requires admin monitoring to trigger proxy deployment via vault function
- Benefit: Centralized deployment control, all proxies owned by vault
- Benefit: Predictable gas costs, simple logic
- Benefit: Enables unlimited concurrent arbitrage opportunities
- Limitation: Operations halt if all proxies busy until admin deploys more

### On-Chain Implementation Notes

**Proxy Contract Interface**
```
initiateUnstake(shares) → expectedAssets
  - Proxy calls cooldownShares(shares, proxy) on Ethena
  - Returns expected USDe amount for position tracking

claimUnstake(receiver) → void
  - Proxy calls unstake(receiver) on Ethena
  - USDe sent directly to receiver (vault)
```

**Key Ethena Functions Used**
- `cooldownShares(uint256 shares, address owner) returns (uint256 assets)` - initiates unstake, returns expected USDe
- `unstake(address receiver)` - claims USDe after 7-day cooldown

**Vault State Tracking**
- Array of deployed proxy addresses
- Mapping of proxy → busy status
- Position struct includes proxy address field
- No removal function needed (proxies deployed permanently)

**Vault Factory Interface**
- `deployProxies(uint256 count)` - factory function deploys N new proxies using CREATE
- Proxies automatically owned by vault and registered in tracking arrays
- View functions to check proxy availability
- Events for proxy deployment and allocation

### Dependencies

- No ADR dependencies; addresses fundamental Ethena protocol constraint.
- Affects implementation of ADR-003 (Position Accounting), ADR-004 (Arbitrage Execution), ADR-006 (Withdrawal Liquidity).

### ADRs Depending on This

- **ADR-003**: Position struct must include `proxyContract` field.
- **ADR-004**: Arbitrage execution must allocate proxy before unstaking.
- **ADR-006**: Claiming matured positions must use correct proxy.

### References

- [Ethena sUSDe Documentation](https://docs.ethena.fi/)
- [EIP-1967: Proxy Pattern](https://eips.ethereum.org/EIPS/eip-1967)
- FR-02: Arbitrage Opportunity Identification
- FR-04: Unstaking Position Tracking
