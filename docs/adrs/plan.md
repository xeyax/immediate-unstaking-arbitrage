# ADR Plan

## Context Snapshot

- **Core Function**: Automated vault that captures arbitrage between sUSDe and USDe by buying discounted sUSDe and unstaking for profit
- **Key Constraint**: 7-day unstaking period requires sophisticated position tracking and share valuation
- **Critical Behaviors**: Must validate profitable trades, track multiple unstaking positions, compound profits automatically
- **User Interface**: Depositors provide USDe, receive vault shares, withdraw proportionally anytime
- **Environment**: Ethereum mainnet, integrating with Ethena protocol's staking/unstaking mechanisms

## Proposed ADR List

| ADR ID | Title | Decision Question | Why it matters | Depends On | Affects FRs |
|-------:|-------|-------------------|----------------|------------|-------------|
| ADR-001 | Vault Token Standard | Use ERC-4626 or custom vault implementation? | Determines user deposit/withdraw interface and share accounting model | - | FR-01, FR-05 |
| ADR-002 | NAV Calculation Method | How to calculate NAV including liquid assets, sUSDe positions, and pending unstaking? | Critical for fair share pricing and preventing dilution/exploitation | ADR-001 | FR-05, FR-01 |
| ADR-003 | Position Accounting Model | How to track and value multiple concurrent unstaking positions? | Enables accurate position tracking for NAV calculation | ADR-002 | FR-04, FR-05 |
| ADR-004 | Price Discovery Mechanism | On-chain oracle vs off-chain keeper-provided prices? | Determines how vault identifies profitable arbitrage opportunities | - | FR-02 |
| ADR-005 | Access Control and Parameters | Owner-controlled vs multi-sig governance? | Defines who can update parameters and manage keepers | ADR-004 | FR-02, FR-03, FR-08 |
| ADR-006 | Withdrawal Liquidity Management | Reserve liquidity vs accept 7-day max withdrawal time? | Defines capital efficiency vs withdrawal speed trade-off | ADR-001, ADR-004 | FR-01, FR-04 |
| ADR-007 | Fee Collection Timing | Collect fees on position close vs periodic harvest? | Affects gas costs and fee recipient cash flow | ADR-003 | FR-07, FR-08 |

## Generation Order

1. ADR-001 (Vault Token Standard)
2. ADR-002 (NAV Calculation Method)
3. ADR-003 (Position Accounting Model)
4. ADR-004 (Price Discovery Mechanism)
5. ADR-005 (Access Control and Parameters)
6. ADR-006 (Withdrawal Liquidity Management)
7. ADR-007 (Fee Collection Timing)

## Notes on What's Out of Scope

- **Generic security best practices**: Standard reentrancy guards, overflow checks handled by Solidity 0.8+
- **Ethena protocol details**: Assuming their staking/unstaking interface is stable and documented
- **Gas optimizations**: Will follow standard patterns, optimize if needed after initial implementation
- **Advanced governance**: Multi-sig wallets and timelock contracts can be added later as owner via separate deployment and ownership transfer
- **Ethena protocol failure handling**: No fallback mechanism if Ethena contracts fail; transactions revert and vault operations halt until Ethena resumes. Depositors assume Ethena protocol risk.