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
- Users can deposit USDe and receive shares ✓
- Users can withdraw USDe by burning shares ✓
- 100% test coverage for implemented functions ✓

---

### Phase 2: Ethena Protocol Integration & Proxy Orchestration
**Status:** Completed ✅
**Dependencies:** Phase 1
**Related ADRs:** ADR-002, ADR-008
**Priority:** HIGH (foundational, everything depends on this)

**Scope:**
- Ethena protocol interfaces (`IStakedUSDe`, `IUSDe`) ✓
- `UnstakeProxy` contract (minimal, single-purpose) ✓
- Proxy pool management in vault ✓
- Real `convertToAssets()` integration for profit calculation ✓
- Mock Ethena contracts for testing ✓

**Deliverables:**
- `interfaces/IStakedUSDe.sol` ✓ (35 lines, minimal interface)
- `interfaces/IUSDe.sol` ✓ (14 lines)
- `contracts/UnstakeProxy.sol` ✓ (107 lines)
- `contracts/mocks/MockStakedUSDe.sol` ✓ (136 lines with authorization)
- Proxy management functions in `ArbitrageVault.sol` ✓
- `contracts/test/ArbitrageVaultHarness.sol` ✓ (test harness pattern)
- Full test suite for proxy orchestration ✓ (23 tests in ProxyOrchestration.test.ts)

**Acceptance Criteria:**
- Can call Ethena `convertToAssets()` for real profit calculation ✓
- Can allocate/release proxies correctly ✓
- Proxy initiate unstake via `cooldownShares()` (returns expected USDe amount) ✓
- Proxy claim unstake via `unstake()` after 7 days (sends USDe to vault) ✓
- Tests cover all proxy lifecycle scenarios ✓
- Vault contains factory logic to deploy new proxies via `deployProxies(count)` ✓

**Key Implementation Details:**
- Proxies are minimal wrappers (no complex logic) ✓
- Vault tracks `proxyBusy` mapping ✓
- Round-robin allocation with `lastAllocatedIndex` for O(1) average case ✓
- If no free proxy: revert "No proxies available" ✓
- Admin monitors and deploys proxies as needed ✓
- Test harness pattern separates test code from production contracts ✓

**Improvements Made:**
- Removed 113 lines of unused code (cooldownAssets, convertToShares, recoverTokens, etc.)
- Implemented round-robin proxy allocation for efficiency
- Added authorization checks in MockStakedUSDe (owner or allowance)
- Created ArbitrageVaultHarness for clean test separation

**Test Coverage:** 23 tests covering:
- Proxy deployment (5 tests)
- Status tracking (4 tests)
- Proxy functionality (3 tests)
- Round-robin allocation (2 tests)
- Full lifecycle (6 tests)
- Exchange rate integration (3 tests)

---

### Phase 3: Access Control & Parameter Management
**Status:** Pending
**Dependencies:** Phase 1
**Related ADRs:** ADR-005
**Priority:** MEDIUM (can be developed in parallel with Phase 2)

**Scope:**
- Keeper whitelist system
- `onlyKeeper` modifier
- Parameter storage (fee %, profit threshold, etc.)
- Owner functions for parameter management
- Events for access control changes

**Deliverables:**
- Keeper management in `ArbitrageVault.sol`
- Parameter state variables
- Access control tests

**Acceptance Criteria:**
- Only owner can add/remove keepers
- `onlyKeeper` modifier correctly restricts access
- Parameter setters validate inputs
- Events emitted on all changes

---

### Phase 4: Position Tracking & NAV Calculation
**Status:** Pending
**Dependencies:** Phase 2 (Ethena integration)
**Related ADRs:** ADR-002, ADR-003

**Scope:**
- Position struct with proxy tracking
- Accrual rate mechanism for O(1) NAV
- Time-weighted profit accrual
- NAV calculation using real Ethena `convertToAssets()`
- Position open/claim lifecycle
- Integration with proxy system

**Deliverables:**
- Position tracking in `ArbitrageVault.sol`
- `totalAssets()` override with real NAV calculation
- `_openPosition()` internal function
- `claimPosition()` public function
- Full position lifecycle tests

**Acceptance Criteria:**
- Positions track real Ethena profit via `convertToAssets()`
- NAV reflects actual sUSDe value
- Time-weighted accrual works correctly
- Positions store assigned proxy address
- Claiming via correct proxy works
- 100% test coverage for position logic

---

### Phase 5: Arbitrage Execution
**Status:** Pending
**Dependencies:** Phase 2, Phase 3, Phase 4
**Related ADRs:** ADR-004

**Scope:**
- `executeArbitrage()` function
- DEX swap integration (generic calldata)
- Profit threshold validation
- Slippage protection
- Proxy allocation during execution
- Full arbitrage flow

**Deliverables:**
- `executeArbitrage()` implementation
- Swap execution logic
- Integration with Phases 2, 3, 4
- Full arbitrage flow tests

**Acceptance Criteria:**
- Only authorized keepers can execute
- Validates minimum profit threshold
- Allocates free proxy (reverts if none available)
- Executes DEX swap correctly
- Initiates unstake via proxy
- Opens position with correct data
- Events emitted for monitoring

---

### Phase 6: Withdrawal Queue System
**Status:** Pending
**Dependencies:** Phase 1, Phase 4
**Related ADRs:** ADR-001, ADR-006
**Priority:** MEDIUM (can be developed in parallel with Phase 5)

**Scope:**
- Withdrawal request queue (FIFO)
- Request/cancel/fulfill functionality
- Partial fulfillment support
- Integration with position claiming
- 7-day maximum guarantee tracking

**Deliverables:**
- Queue data structures
- Request management functions
- Fulfillment logic
- Queue tests

**Acceptance Criteria:**
- Users can request withdrawals when liquidity insufficient
- Requests fulfilled in FIFO order
- Partial fulfillment works correctly
- Cancellations work
- 7-day maximum withdrawal time enforced
- Integration with proxy-based position claiming

---

### Phase 7: Fee Collection Mechanism
**Status:** Pending
**Dependencies:** Phase 4
**Related ADRs:** ADR-007
**Priority:** LOW (can be developed in parallel with Phases 5, 6)

**Scope:**
- Performance fee calculation
- Continuous fee collection hooks
- Fee recipient management
- Fee withdrawal functionality

**Deliverables:**
- Fee collection logic
- Fee management functions
- Fee tests

**Acceptance Criteria:**
- Fees collected continuously on external calls
- Performance fee correctly calculated from realized profits
- Fee recipient can withdraw accumulated fees
- Fee collection doesn't affect share values unfairly

---

### Phase 8: Integration Testing & Finalization
**Status:** Pending
**Dependencies:** Phases 5, 6, 7
**Related ADRs:** All

**Scope:**
- Full end-to-end integration tests
- Multi-user scenarios
- Edge case testing
- Gas optimization
- Security review preparation

**Deliverables:**
- Comprehensive integration test suite
- Gas benchmarks
- Security checklist completion
- Documentation finalization

**Acceptance Criteria:**
- Full deposit → arbitrage → claim → withdraw flow works
- Multiple users with different entry/exit times
- Fee collection across full lifecycle
- Queue fulfillment under various conditions
- Gas consumption within acceptable limits
- All edge cases covered

---

## Post-Development Tasks

### Testing & Quality Assurance
- Achieve 100% line and branch coverage
- Run Slither static analysis
- Run invariant/fuzz tests with Foundry
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
- Initial proxy deployment (e.g., 5 proxies)

---

## Dependencies Graph

```
Phase 1: Core Vault ✅
    │
    ├─────► Phase 2: Ethena Integration + Proxies (FOUNDATIONAL)
    │           │
    │           └──► Phase 4: Position Tracking + NAV
    │                   ├──► Phase 5: Arbitrage Execution
    │                   ├──► Phase 6: Withdrawal Queue
    │                   └──► Phase 7: Fee Collection
    │
    └─────► Phase 3: Access Control (can parallel Phase 2)
                └──► Phase 5: Arbitrage Execution

All → Phase 8: Integration Testing
```

**Parallelization Opportunities:**
- Phase 2 and Phase 3 can be developed **simultaneously** (independent)
- Phase 5, 6, 7 can be developed **simultaneously** after Phase 4 completes

---

## Timeline Estimate

| Phase | Estimated Duration | Can Parallel With | Status |
|-------|-------------------|-------------------|--------|
| Phase 1: Core Vault | 1-2 days | - | ✅ Completed |
| Phase 2: Ethena + Proxies | 2-3 days | Phase 3 | ✅ Completed |
| Phase 3: Access Control | 1 day | Phase 2 | ⏳ Next |
| Phase 4: Position + NAV | 2 days | - | Pending |
| Phase 5: Arbitrage | 2-3 days | Phase 6, 7 | Pending |
| Phase 6: Withdrawal Queue | 2-3 days | Phase 5, 7 | Pending |
| Phase 7: Fee Collection | 1 day | Phase 5, 6 | Pending |
| Phase 8: Integration | 1-2 days | - | Pending |
| **Total Core Development** | **12-17 days** | | **~3 days done** |
| Testing & Documentation | 3-5 days | | |
| **Total Project Duration** | **2-3 weeks** | | |

**Optimistic Timeline (with parallelization):**
- Week 1: Phase 1 ✅, Phase 2 ✅ (Phase 3 next)
- Week 2: Phase 4, then Phase 5 + 6 + 7 (parallel)
- Week 3: Phase 8, QA, Documentation

---

## Success Criteria

**Overall:**
- All functional requirements (FR-01 to FR-08) implemented
- All ADRs (including ADR-008) implemented as specified
- 100% test coverage achieved
- Gas optimized (< 500k gas for deposit/withdraw)
- Zero critical/high severity issues from static analysis
- Code follows CODING_STANDARDS.md requirements
- All functions have complete NatSpec documentation

**Phase 1 & 2 (Completed):**
- ✅ ERC-4626 vault with deposit/withdraw functionality
- ✅ Proxy orchestration working correctly with multiple concurrent unstakes
- ✅ Round-robin proxy allocation for efficiency
- ✅ Ethena protocol integration (convertToAssets, cooldownShares, unstake)
- ✅ Test harness pattern for clean separation of test code
- ✅ 42 tests passing (19 Phase 1 + 23 Phase 2)
- ✅ Mock contracts with proper authorization
- ✅ Minimal interfaces (unused code removed)

---

## Key Architectural Decisions

1. **Phase 2 moved to front** - Ethena integration is foundational, everything depends on it
2. **Proxy pattern (ADR-008)** - Enables concurrent unstakes, critical for capital efficiency
3. **Access Control independent** - Can be developed in parallel with Ethena integration
4. **Phase 4 combines Position + NAV** - These are tightly coupled, no benefit to splitting
5. **Phases 5-7 can parallelize** - After Phase 4, these features are independent

---

## Notes

- Phase 2 is **blocking** for Phases 4-7 - prioritize completion
- Phase 3 is **non-blocking** - can develop alongside Phase 2
- Admin must manually deploy proxies - no automatic deployment
- If no free proxy available during arbitrage: revert with clear error
- Keeper monitors proxy availability off-chain
