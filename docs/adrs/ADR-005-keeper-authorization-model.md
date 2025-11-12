## ADR-005 — Keeper Authorization Model

**Status**: Proposed
**Date**: 2025-11-06
**Deciders**: Smart Contract Engineering Team
**Related FRs**: FR-03, FR-06

### Context

Per ADR-004, keepers monitor market prices off-chain and submit arbitrage transactions to the vault. Per FR-03, the vault must allow authorized keepers to execute validated trades while enforcing position limits and exposure caps.

A single-keeper model creates operational risk. If the keeper's private key is compromised, malicious trades could be submitted within the constraints of on-chain validation. If the keeper is unavailable due to infrastructure failure or key loss, arbitrage operations halt entirely. The 7-day unstaking period amplifies this risk, as positions cannot be claimed without keeper access, locking capital and preventing depositor withdrawals.

Authorization models range from fully permissioned to fully permissionless. Permissioned models prioritize operational control and trust assumptions, enabling efficient execution but introducing centralization. Permissionless models maximize decentralization but create MEV competition, race conditions, and higher gas costs as multiple actors compete for the same opportunities.

### Decision

Implement a whitelisted keeper set where multiple addresses can execute arbitrage trades and claim positions. The owner maintains an on-chain mapping of authorized keepers, adding or removing addresses as needed. All authorized keepers have identical permissions to call keeper functions. This provides operational redundancy while maintaining explicit authorization without introducing role complexity.

**Important: Keepers cannot cause losses to the vault.** On-chain validation ensures all trades are profitable through slippage protection (minAmountOut) and capital/position limit checks. Keepers provided by project developers for operational simplicity rather than pursuing permissionless design.

### Options Considered

**Single Authorized Keeper**
One address authorized to execute trades and claim positions via botOperator role. Trade-offs: Simplest implementation, minimal gas overhead, clear accountability; single point of failure for both key compromise and availability, no redundancy if keeper infrastructure fails, owner must immediately respond to keeper issues.

**Whitelisted Keeper Set (chosen)**
Multiple addresses authorized via mapping, all with identical permissions. Owner can add/remove keepers. Keepers provided by project developers. Trade-offs: Operational redundancy across keeper infrastructure, failover capability if one keeper unavailable, enables gradual keeper rotation without operational interruption, simpler than permissionless design; requires coordination to prevent duplicate submissions, more addresses to secure, owner must manage whitelist.

**Role-Based Access Control**
Use OpenZeppelin AccessControl with separate EXECUTOR_ROLE and CLAIMER_ROLE for granular permissions. Trade-offs: Maximum flexibility for permission segmentation, can separate price discovery from position management, supports complex multi-operator workflows; higher implementation complexity, increased gas costs for role checks, potentially unnecessary for current two-function scope.

**Open Execution with Economic Validation (Permissionless)**
Remove authorization entirely; any address can submit arbitrage trades if they pass on-chain profitability validation. Trade-offs: Maximally decentralized, no operational dependencies on specific keepers, MEV searchers provide execution resilience; creates race conditions with wasted gas, enables spam attacks testing position limits, complex validation required to prevent exploitation, difficult to coordinate across multiple positions, unnecessary complexity for initial version.

**Do nothing**
Fails to address operational resilience requirements and centralizes control around one key.

### Consequences

**Authorization Structure**
- Vault maintains isKeeper mapping tracking authorized addresses.
- Owner can call addKeeper(address) and removeKeeper(address) functions.
- executeArbitrage() and claimPosition() require msg.sender in keeper set.
- Keepers provided and operated by project developers.

**Operational Benefits**
- Multiple keepers enable failover if primary keeper infrastructure unavailable.
- Keeper rotation possible by adding new keeper before removing old one, avoiding operational gaps.
- Keepers must coordinate off-chain to avoid submitting duplicate transactions for same opportunity.

**Risk Mitigation**
- **Keepers cannot cause vault losses**: On-chain validation (slippage protection via minAmountOut, position limits, capital availability) ensures all trades are profitable.
- Compromised keeper can only execute valid profitable trades within risk limits, not drain funds.
- Permissioned approach chosen for operational simplicity over permissionless complexity.

### On-Chain Implementation Notes

- Implement mapping(address => bool) isKeeper for tracking authorized keepers.
- Add addKeeper(address keeper) and removeKeeper(address keeper) functions restricted to owner.
- Emit KeeperAdded(address indexed keeper) and KeeperRemoved(address indexed keeper) events.
- Authorization modifier checks require(isKeeper[msg.sender], "Unauthorized").
- executeArbitrage() and claimPosition() logic unchanged; only authorization check applies.
- Consider EnumerableSet from OpenZeppelin if keeper enumeration needed for monitoring.

### Dependencies

- ADR-004 (Price Discovery Mechanism): Keeper-submitted prices require keeper authorization.

### ADRs Depending on This

- ADR-006 (Risk Limit Architecture): Risk limits apply per keeper action regardless of which authorized keeper submits.

### References

- [OpenZeppelin Access Control](https://docs.openzeppelin.com/contracts/4.x/access-control)
- [Ethereum Key Management Best Practices](https://consensys.github.io/smart-contract-best-practices/development-recommendations/general/key-management/)
