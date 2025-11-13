## ADR-005 — Access Control and Parameters

**Status**: Proposed
**Date**: 2025-11-06
**Deciders**: Smart Contract Engineering Team
**Related FRs**: FR-02, FR-03, FR-08

### Context

The vault requires access control for operational functions (keeper operations) and parameter management (performance fee, minimum profit threshold, fee recipient). The challenge is determining who can execute operations, who can modify parameters, and what governance model to use.

**Keeper Authorization:**
Per ADR-004, keepers monitor market prices off-chain and submit arbitrage transactions. A single-keeper model creates operational risk (key compromise, unavailability). The 7-day unstaking period amplifies this risk, as positions cannot be claimed without keeper access.

**Parameter Management:**
The vault has configurable parameters affecting economics and operations:
- Performance fee percentage (affects depositor returns)
- Fee recipient address (receives collected fees)
- Minimum profit threshold (minimum spread for arbitrage execution)
- Keeper whitelist (who can execute trades)

Parameters must be updatable by authorized roles while protecting depositors from sudden adverse changes.

### Decision

**Single owner/admin controls all parameters and keeper whitelist.** Owner can update performance fee, fee recipient, minimum profit threshold, and manage keeper authorization. All parameter changes emit events for transparency. No timelocks or multi-sig requirements for initial version - prioritizing operational simplicity.

**Keeper Authorization:**
- Whitelisted keeper set (multiple addresses)
- Owner adds/removes keepers via `addKeeper()` and `removeKeeper()`
- All authorized keepers have identical permissions
- Keepers cannot cause losses (on-chain validation ensures profitable trades)
- Keepers provided by project developers

**Configurable Parameters (5 total):**
1. **Performance Fee** (uint256, basis points, 0-10000, default: 1000 = 10%)
2. **Fee Recipient** (address, cannot be zero address)
3. **Minimum Profit Threshold** (uint256, basis points, default: 10 = 0.1%)
4. **Keeper Whitelist** (mapping(address => bool))
5. **Owner** (address, transferable via standard Ownable pattern)

This provides operational flexibility while maintaining clear accountability through owner-controlled governance.

### Options Considered

**Owner-Controlled with Whitelisted Keepers (chosen)**
Single owner controls all parameters; multiple whitelisted keepers for operations. Trade-offs: Simple governance model, clear accountability, operational redundancy for keepers, fast parameter updates; centralized control, owner compromise affects all parameters, no protection against malicious parameter changes.

**Multi-Sig Governance**
Require multiple signatures for parameter changes and keeper management. Trade-offs: Distributed control, protection against single key compromise, transparent decision-making; slower parameter updates, coordination overhead, implementation complexity, overkill for initial version.

**Timelock + Owner**
Parameter changes queued with delay before execution. Trade-offs: Users can exit before adverse changes, prevents instant rug pulls; delayed response to urgent situations, additional implementation complexity, may not be necessary given keepers cannot cause losses.

**DAO Governance**
Token-based voting for parameter changes. Trade-offs: Maximally decentralized, community-controlled; high complexity, slow decision-making, requires governance token, unnecessary for initial version with project-operated keepers.

**Immutable Parameters**
No parameter updates allowed after deployment. Trade-offs: Maximum trust minimization, no governance attack surface; cannot adapt to changing conditions, cannot fix fee misconfiguration, cannot update fee recipient if compromised.

### Consequences

**Access Control Structure**
- Single owner address with full control over all parameters
- Owner can update: performance fee, fee recipient, minimum profit threshold
- Owner can manage keeper whitelist: add/remove keeper addresses
- Standard Ownable pattern for ownership transfer

**Keeper Authorization**
- Multiple whitelisted keeper addresses for operational redundancy
- Keepers execute arbitrage trades and claim matured positions
- Keepers cannot cause losses (on-chain validation ensures profitable trades)
- Owner adds/removes keepers without timelock or delay

**Parameter Management**
- Performance fee: owner can update, range 0-10000 basis points (0-100%), default 1000 (10%)
- Fee recipient: owner can update, must not be zero address
- Minimum profit threshold: owner can update, default 10 basis points (0.1%)
- All parameter changes emit events: `PerformanceFeeUpdated`, `FeeRecipientUpdated`, `MinProfitThresholdUpdated`
- Keeper changes emit events: `KeeperAdded`, `KeeperRemoved`

**Trade-offs**
- Centralized control enables fast responses to issues
- No protection against malicious owner (trust assumption on project operators)
- Users must trust owner not to set unfavorable parameters
- Simple model suitable for initial version with project-operated keepers

**Future Governance Evolution**
- Multi-sig wallet or timelock contract can be added later as owner
- Standard Ownable pattern allows ownership transfer to governance contract
- Additional access control layers (e.g., Gnosis Safe, Timelock Controller) can wrap current contract without code changes
- Out of scope for initial version - can be deployed separately and set as owner via transferOwnership()

### On-Chain Implementation Notes

**Keeper Management**
- Implement mapping for keeper whitelist tracking
- Functions: addKeeper(address), removeKeeper(address) restricted to owner
- Authorization check in executeArbitrage() and claimPosition()
- Events: KeeperAdded(address indexed keeper), KeeperRemoved(address indexed keeper)

**Parameter Update Functions (all restricted to owner)**
- setPerformanceFee(uint256 basisPoints) - validate ≤ 10000
- setFeeRecipient(address recipient) - validate != address(0)
- setMinProfitThreshold(uint256 basisPoints) - validate reasonable range

**Events for Parameter Changes**
- PerformanceFeeUpdated(uint256 oldFee, uint256 newFee)
- FeeRecipientUpdated(address indexed oldRecipient, address indexed newRecipient)
- MinProfitThresholdUpdated(uint256 oldThreshold, uint256 newThreshold)

**Authorization in executeArbitrage()**
- Check keeper authorization: require(isKeeper[msg.sender])

**Ownership**
- Inherit OpenZeppelin Ownable for standard ownership management
- Owner can transfer ownership via transferOwnership(address)

### Dependencies

- ADR-004 (Price Discovery Mechanism): Minimum profit threshold validates arbitrage profitability.
- ADR-007 (Fee Collection Timing): Performance fee parameter affects fee collection.

### ADRs Depending on This

- All ADRs depend on owner-controlled parameter management for configuration.

### References

- [OpenZeppelin Access Control](https://docs.openzeppelin.com/contracts/4.x/access-control)
- [Ethereum Key Management Best Practices](https://consensys.github.io/smart-contract-best-practices/development-recommendations/general/key-management/)
