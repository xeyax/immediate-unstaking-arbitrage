# Development Plan: sUSDe/USDe Arbitrage Vault

## Project Overview
Development of ArbitrageVault.sol - an ERC-4626 compliant vault that performs automated staking arbitrage between sUSDe and USDe tokens.

## Development Phases

### Phase 1: Core ERC-4626 Vault Implementation ✅
**Status:** Completed
**Dependencies:** None
**Related ADRs:** ADR-001

**Scope:**
- Basic ERC-4626 vault with deposit/mint/withdraw/redeem
- Stub `totalAssets()` implementation
- Initial test suite

**Acceptance Criteria:**
- Users can deposit USDe and receive shares
- Users can withdraw USDe by burning shares
- 100% test coverage for implemented functions

---

### Phase 2: Position Tracking System
**Status:** Pending
**Dependencies:** Phase 1
**Related ADRs:** ADR-003

**Scope:**
- Position struct and storage
- Position lifecycle (open/claim)
- Accrual rate mechanism
- Position-related events and view functions

**Acceptance Criteria:**
- Positions can be opened with sUSDe amount and book value
- Positions can be claimed after 7-day cooldown
- Accrual tracking updates correctly

---

### Phase 3: NAV Calculation Engine
**Status:** Pending
**Dependencies:** Phase 2
**Related ADRs:** ADR-002, ADR-003

**Scope:**
- Time-weighted profit accrual formula
- Full `totalAssets()` implementation
- Position valuation helpers
- Integration with Ethena's `convertToAssets()`

**Acceptance Criteria:**
- `totalAssets()` correctly reflects idle USDe + position values
- NAV increases linearly over 7-day cooldown period
- Share price is always accurate

---

### Phase 4: Arbitrage Execution Module
**Status:** Pending
**Dependencies:** Phase 3
**Related ADRs:** ADR-004, ADR-005

**Scope:**
- Keeper whitelist and access control
- `executeArbitrage()` function
- Minimum profit threshold validation
- DEX swap integration
- Ethena staking integration

**Acceptance Criteria:**
- Only authorized keepers can execute arbitrage
- Arbitrage only executes if profit threshold is met
- New positions are correctly opened after arbitrage
- Events emitted for transparency

---

### Phase 5: Withdrawal Queue System
**Status:** Pending
**Dependencies:** Phase 1, Phase 3
**Related ADRs:** ADR-001, ADR-006

**Scope:**
- Withdrawal request queue (FIFO)
- Request/cancel/fulfill functionality
- Partial fulfillment support
- Integration with position claiming
- 7-day maximum guarantee tracking

**Acceptance Criteria:**
- Users can request withdrawals when liquidity is insufficient
- Requests are fulfilled in FIFO order
- Partial fulfillments are supported
- Cancellations work correctly
- 7-day maximum withdrawal time is enforced

---

### Phase 6: Fee Collection Mechanism
**Status:** Pending
**Dependencies:** Phase 3
**Related ADRs:** ADR-007

**Scope:**
- Performance fee calculation
- Continuous fee collection hooks
- Fee recipient management
- Fee withdrawal functionality

**Acceptance Criteria:**
- Fees are collected continuously on external calls
- Performance fee correctly calculated from realized profits
- Fee recipient can withdraw accumulated fees
- Fee collection doesn't affect user share values unfairly

---

### Phase 7: Parameter Management and Access Control
**Status:** Pending
**Dependencies:** Phase 4, Phase 6
**Related ADRs:** ADR-005

**Scope:**
- Owner-controlled parameter setters
- Parameter validation
- Parameter change events
- Emergency functions (if needed)
- Integration test suite

**Acceptance Criteria:**
- Only owner can change parameters
- Parameter validation prevents invalid values
- All parameter changes emit events
- Full integration tests pass

---

## Post-Development Tasks

### Testing & Quality Assurance
- Achieve 100% line and branch coverage
- Run Slither static analysis
- Run invariant/fuzz tests
- Gas optimization review
- Code review checklist completion

### Documentation
- Complete NatSpec comments for all functions
- Generate Solidity documentation
- Create deployment guide
- Create keeper implementation guide
- Document integration specifications
- Create security audit checklist

### Deployment Preparation
- Mainnet contract addresses collection (Ethena)
- Constructor parameters preparation
- Initial configuration values
- Deployment scripts
- Post-deployment verification scripts

---

## Dependencies Graph

```
Phase 1 (Core Vault)
    ├── Phase 2 (Position Tracking)
    │       └── Phase 3 (NAV Calculation)
    │               ├── Phase 4 (Arbitrage)
    │               └── Phase 6 (Fees)
    └── Phase 5 (Withdrawal Queue)

Phase 7 depends on: Phase 4, Phase 6
```

---

## Timeline Estimate

| Phase | Estimated Duration |
|-------|-------------------|
| Phase 1: Core Vault | 1-2 days ✅ |
| Phase 2: Position Tracking | 1 day |
| Phase 3: NAV Calculation | 2 days |
| Phase 4: Arbitrage | 2-3 days |
| Phase 5: Withdrawal Queue | 2-3 days |
| Phase 6: Fee Collection | 1 day |
| Phase 7: Parameter Management | 1 day |
| **Total Core Development** | **10-14 days** |
| Testing & Documentation | 3-5 days |
| **Total Project Duration** | **2-3 weeks** |

---

## Success Criteria

- All functional requirements (FR-01 to FR-08) implemented
- 100% test coverage achieved
- All ADRs implemented as specified
- Gas optimized (< 500k gas for deposit/withdraw)
- Zero critical/high severity issues from static analysis
- Code follows CODING_STANDARDS.md requirements
- All functions have complete NatSpec documentation
