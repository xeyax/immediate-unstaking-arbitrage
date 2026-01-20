# Development Plan: sUSDe/USDe Arbitrage Vault

## Project Overview
Development of ArbitrageVault.sol - a simplified ERC-4626 vault that performs automated staking arbitrage between sUSDe and USDe tokens.

**Fully Asynchronous Withdrawal Model:** This vault uses a simplified, async-only withdrawal approach:
- `deposit(assets)` - Synchronous deposits with auto-fulfill: mints shares first, then fulfills queue with new liquidity (FIFO priority, no depositor dilution)
- `requestWithdrawal(shares)` - **PRIMARY and ONLY** withdrawal method (async via FIFO queue, instant if idle liquidity available)
- `redeem(shares)`, `mint(shares)`, `withdraw(assets)` - **DISABLED** (always revert with helpful messages)
- **All withdrawals are asynchronous** through the FIFO queue for maximum simplicity and fairness
- **Instant fulfillment** when idle liquidity available - no waiting in typical case
- **Fairness invariant maintained**: `idle_liquidity == 0 OR pending_queue.length == 0` (queue always has priority)
- **Permissionless claims** - anyone can call claimPosition() to fulfill queue (no keeper dependency)
- Queue fulfilled when: idle liquidity available (instant), new deposits arrive (auto-fulfill), or anyone calls claimPosition() after cooldown

## Development Phases

### Phase 1: Core ERC-4626 Vault Implementation ✅
**Status:** Completed
**Dependencies:** None
**Related ADRs:** ADR-001

**Scope:**
- Simplified ERC-4626 vault with `deposit(assets)` and `redeem(shares)` only
- Omitted: `mint(shares)` and `withdraw(assets)` (redundant for typical UX)
- Stub `totalAssets()` implementation
- Initial test suite

**Acceptance Criteria:**
- Users can deposit USDe and receive shares (immediate) ✓
- Users can request withdrawals via async queue (requestWithdrawal) ✓
- 100% test coverage for implemented functions ✓

**Design Decision (Async-Only Model with Auto-Fulfill):**
- `deposit(assets)` - Synchronous deposits with auto-fulfill: mints shares, then fulfills queue (FIFO priority)
- `requestWithdrawal(shares)` - **ONLY** withdrawal method: async via FIFO queue, instant if idle liquidity
- **DISABLED**: `redeem(shares)`, `mint(shares)`, `withdraw(assets)` (always revert)
- Rationale: Perfect FIFO fairness, simpler code (-118 lines), no priority edge cases, instant withdrawals in typical case
- Fairness invariant: `idle_liquidity == 0 OR pending_queue.length == 0` ensures queue always has priority

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
- `contracts/test/ArbitrageVaultHarness.sol` ✓ (test-only harness for unit tests - NOT for production)
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
- Created ArbitrageVaultHarness for unit testing (exposes internal functions - FOR TESTS ONLY, never production)

**Test Coverage:** 23 tests covering:
- Proxy deployment (5 tests)
- Status tracking (4 tests)
- Proxy functionality (3 tests)
- Round-robin allocation (2 tests)
- Full lifecycle (6 tests)
- Exchange rate integration (3 tests)

---

### Phase 3: Access Control & Parameter Management
**Status:** Completed ✅
**Dependencies:** Phase 1
**Related ADRs:** ADR-005
**Priority:** MEDIUM (can be developed in parallel with Phase 2)

**Scope:**
- Keeper whitelist system ✓
- `onlyKeeper` modifier ✓
- Parameter storage (fee %, profit threshold, etc.) ✓
- Owner functions for parameter management ✓
- Events for access control changes ✓

**Deliverables:**
- Keeper management in `ArbitrageVault.sol` ✓
  - `addKeeper(address)` / `removeKeeper(address)` functions
  - `isKeeper` mapping for authorization
- Parameter state variables ✓
  - `performanceFee` (basis points, default 1000 = 10%, max 5000 = 50%)
  - `feeRecipient` (address for fee collection)
  - `minProfitThreshold` (basis points, default 10 = 0.1%)
  - Constants: `MAX_PERFORMANCE_FEE`, `BASIS_POINTS`
- Parameter setter functions ✓
  - `setPerformanceFee(uint256)` with validation
  - `setFeeRecipient(address)` with zero-address check
  - `setMinProfitThreshold(uint256)` with range validation
- Access control tests ✓ (23 tests in AccessControl.test.ts)

**Acceptance Criteria:**
- Only owner can add/remove keepers ✓
- `onlyKeeper` modifier correctly restricts access ✓
- Parameter setters validate inputs ✓
- Events emitted on all changes ✓
- Multiple keepers supported ✓
- Performance fee capped at 50% for depositor protection ✓

**Key Implementation Details:**
- Owner-controlled governance model ✓
- Keeper whitelist for operational redundancy ✓
- Performance fee maximum enforced on-chain ✓
- All parameter changes emit events for transparency ✓
- Constructor requires initial fee recipient ✓

**Test Coverage:** 23 tests covering:
- Initialization (2 tests)
- Keeper management (7 tests)
- Performance fee management (5 tests)
- Fee recipient management (3 tests)
- Min profit threshold management (5 tests)
- Updated existing tests with new constructor parameter (1 test)

---

### Phase 4: Position Tracking & NAV Calculation
**Status:** Completed ✅
**Dependencies:** Phase 2 (Ethena integration)
**Related ADRs:** ADR-002, ADR-003
**Priority:** HIGH (foundational for arbitrage execution)

**Scope:**
- Position struct with proxy tracking ✓
- Bounded iteration mechanism for accurate NAV ✓
- Time-weighted profit accrual with per-position capping ✓
- NAV calculation via position iteration (no keeper timing dependency) ✓
- Position open/claim lifecycle ✓
- Integration with proxy system ✓
- Input validation and security checks ✓

**Deliverables:**
- Position tracking in `ArbitrageVault.sol` ✓
  - `Position` struct with all position data
  - State variables: `firstActivePositionId`, `nextPositionId` (FIFO range tracking)
  - Events for position lifecycle (PositionOpened, PositionClaimed)
- `totalAssets()` override with FIFO range iteration NAV ✓
- `_calculatePositionsValue()` internal helper ✓ (eliminates code duplication)
- `_openPosition()` internal function ✓
- `claimPosition()` keeper function (FIFO-only, no positionId parameter) ✓
- View functions ✓:
  - `getPosition()` - returns position details
  - `getAccruedProfit()` - returns total accrued profit (uses _calculatePositionsValue)
  - `activePositionCount()` - returns active positions count
  - `isPositionClaimable()` - checks if position can be claimed
- `ArbitrageVaultHarness.sol` ✓ - test-only contract for unit tests (exposes `openPositionForTesting()`)
- Full position lifecycle tests ✓ (26 tests in PositionTracking.test.ts + 14 in BugFixes.test.ts including MAX_ACTIVE_POSITIONS)

**⚠️ IMPORTANT - Test Harness Usage:**
- `ArbitrageVaultHarness` is **ONLY for unit tests** - allows testing edge cases and internal functions
- Integration tests (ArbitrageExecution.test.ts) use **production ArbitrageVault** with executeArbitrage()
- **Production deployment**: Deploy `ArbitrageVault.sol` ONLY, NOT the harness!

**Acceptance Criteria:**
- Positions track real Ethena profit via proxy return values ✓
- NAV reflects actual sUSDe value with bounded O(N) complexity ✓
- Time-weighted accrual works correctly with per-position accuracy ✓
- Profit capped at exactly COOLDOWN_PERIOD per position ✓
- No dependency on keeper claiming speed ✓
- Positions store assigned proxy address ✓
- Claiming via correct proxy works ✓
- 100% test coverage for position logic ✓

**Key Implementation Details:**
- **FIFO range-based NAV calculation** - iterates [firstActivePositionId, nextPositionId) (max 50 positions)
- **Per-position time capping** - `min(timeElapsed, COOLDOWN_PERIOD)` prevents over-accrual
- **NAV formula:** `idle USDe + Σ(bookValue[i] + accruedProfit[i])` for all active positions
- **FIFO claim order** - positions must be claimed oldest-first (simplest implementation)
- **No array management** - simple increment of firstActivePositionId on claim
- **Gas cost:** ~100k for 50 positions (10% improvement over array approach)
- **MAX_ACTIVE_POSITIONS = 50** - bounds gas cost and prevents DoS
- **Code simplification** - eliminated 50 lines (array/index management, emergency functions, dead code)
- **Owner auto-added as keeper** in constructor for operational safety

**Architecture Change (vs Original ADR-003):**
- Original: O(1) via global accrualRate (had rate inflation bug)
- Current: Bounded O(N) via position iteration (no bugs, always accurate)
- Trade-off: 2x gas cost for deposit/withdraw, but perfect NAV accuracy

**Test Coverage:** 36 tests covering:
- Position opening (5 tests)
- Time-weighted NAV calculation (5 tests)
- Position claiming (7 tests)
- View functions (4 tests)
- Integration scenarios (5 tests)
- Bug fixes verification (10 tests)

**✅ SECURITY IMPLEMENTED (Phase 5 Completed):**

`_openPosition()` is `internal` and called by:
1. ✅ **Production**: `executeArbitrage()` with trustless validation (balance delta + Ethena return value)
2. ✅ **Testing**: `ArbitrageVaultHarness.openPositionForTesting()` in controlled unit tests

**Security guarantees (Phase 5):**
- ✅ `bookValue` measured via balance delta (keeper CANNOT manipulate)
- ✅ `expectedAssets` from Ethena cooldownShares() (keeper CANNOT manipulate)
- ✅ Allowance reset to 0 after each swap (prevents malicious keeper attack)
- ✅ Profit threshold validation prevents unprofitable trades
- ✅ Slippage protection prevents sandwich attacks

See contracts/ArbitrageVault.sol:566-589 for security implementation details.

---

### Phase 5: Arbitrage Execution
**Status:** ✅ Completed (2025-11-21)
**Dependencies:** Phase 2, Phase 3, Phase 4
**Related ADRs:** ADR-004

**Scope:**
- `executeArbitrage()` function ✓
- DEX swap integration (generic calldata) ✓
- Profit threshold validation ✓
- Slippage protection ✓
- Proxy allocation during execution ✓
- Full arbitrage flow ✓

**Deliverables:**
- `executeArbitrage()` implementation ✓ (lines 591-658)
- Trustless bookValue measurement via balance delta ✓
- expectedAssets from Ethena via proxy.initiateUnstake() ✓
- Slippage protection via minAmountOut ✓
- Profit threshold validation ✓
- ArbitrageExecuted event ✓
- MockDEX for testing ✓
- Full arbitrage flow tests ✓ (23 tests in ArbitrageExecution.test.ts)

**Acceptance Criteria:**
- Only authorized keepers can execute ✓
- Validates minimum profit threshold ✓
- Allocates free proxy (reverts if none available) ✓
- Executes DEX swap correctly ✓
- Initiates unstake via proxy ✓
- Opens position with validated data ✓
- Events emitted for monitoring ✓

**Security Implementation:**
- ✅ Trustless bookValue: measured via `balanceBefore - balanceAfter` (keeper CANNOT manipulate)
- ✅ Trustless expectedAssets: from Ethena's `cooldownShares()` return value (keeper CANNOT manipulate)
- ✅ Profit validation: requires `expectedProfit >= minProfitThreshold`
- ✅ Slippage protection: requires `sUsdeReceived >= minAmountOut`
- ✅ Attack prevention: all critical values measured on-chain or from Ethena
- ✅ See contracts/ArbitrageVault.sol:566-589 for detailed security flow

---

### Phase 6: Withdrawal Queue System
**Status:** ✅ Completed (2025-11-21)
**Dependencies:** Phase 1, Phase 4, Phase 5
**Related ADRs:** ADR-001, ADR-006
**Implementation:** FIFO-compatible (auto-claim firstActivePositionId only)

**Scope:**
- Withdrawal request queue (FIFO) ✓
- Request/cancel/fulfill functionality ✓
- Partial fulfillment support ✓
- Integration with position claiming (FIFO-compatible) ✓
- Auto-claim first position on withdraw if ready ✓

**Deliverables:**
- Queue data structures ✓ (WithdrawalRequest struct with escrow mechanism)
- `requestWithdrawal()` function ✓ (PRIMARY withdrawal method - escrow: transfers shares to contract)
- `cancelWithdrawal()` function ✓ (FIFO-safe: O(1) removal marks slot empty)
- **DISABLED** `redeem()` ✓ (always reverts - async-only model for max fairness)
- **DISABLED** `withdraw()`, `mint()` ✓ (explicit reverts with helpful messages)
- `deposit()` ✓ (standard deposit, NO auto-fulfill to prevent dilution)
- Modified `claimPosition()` to permissionless ✓ (no onlyKeeper - anyone can trigger fulfillment)
- `_fulfillPendingWithdrawals()` internal helper ✓ (dynamic NAV, called by claimPosition only)
- `_tryClaimFirstPosition()` internal helper ✓ (claim + auto-fulfill consolidated)
- `_removeFirstFromQueue()` helper ✓ (O(1) head pointer increment)
- `_removeFromQueue()` helper ✓ (O(1) - marks slot empty, advances head if first element)
- Head/tail pointer queue for O(1) operations ✓ (DoS protection)
- `maxWithdrawalsPerTx` batch limit ✓ (gas safety)
- `maxRedeem()` override ✓ (always returns 0 - async-only model)
- `maxWithdraw()` override ✓ (always returns 0 - async-only model)
- **Permissionless claims** ✓ (claimPosition() has no onlyKeeper - anyone can call)
- View functions (pendingWithdrawalCount, getWithdrawalRequest) ✓
- Queue tests ✓ (core queue scenarios + FIFO verification + integration tests)

**Acceptance Criteria:**
- Users can request withdrawals when liquidity insufficient ✓
- Requests fulfilled in FIFO order ✓
- Partial fulfillment works correctly ✓
- Cancellations work ✓
- Auto-claim firstActivePositionId on withdraw (FIFO-compatible) ✓
- Auto-fulfill queue when keeper claims positions ✓
- DoS protection: O(1) queue operations, MIN_WITHDRAWAL_ASSETS, MIN_TIME_BEFORE_CANCEL ✓

**FIFO Adaptation:**
- Auto-claim limited to `firstActivePositionId` only (respects FIFO from ADR-003)
- Simpler than iterating all positions, maintains FIFO invariant
- Users may queue more often vs. original ADR-006, but implementation is cleaner

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

**Current Status:**
- ✅ Phase 1: Core Vault - Completed
- ✅ Phase 2: Ethena Integration & Proxy Orchestration - Completed
- ✅ Phase 3: Access Control & Parameter Management - Completed
- ✅ Phase 4: Position Tracking & NAV Calculation - Completed
- ✅ Phase 5: Arbitrage Execution - Completed
- ✅ Phase 6: Withdrawal Queue System - Completed
- Pending: Phases 7-8

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

**Phase 1, 2, 3, 4, 5 & 6 (Completed):**
- ✅ Fully asynchronous withdrawal vault with `deposit(assets)` (sync) and `requestWithdrawal(shares)` (async)
  - redeem(), mint(), and withdraw() **ALL DISABLED** with explicit revert messages
  - Async-only model: all withdrawals via requestWithdrawal() → FIFO queue
  - maxRedeem() always returns 0 (honest: no immediate withdrawals)
- ✅ Proxy orchestration working correctly with multiple concurrent unstakes
- ✅ Round-robin proxy allocation for efficiency
- ✅ Ethena protocol integration (convertToAssets, cooldownShares, unstake)
- ✅ Keeper whitelist system with multiple keeper support
- ✅ Parameter management (performance fee, fee recipient, min profit threshold)
- ✅ Owner-controlled governance with on-chain validations
- ✅ Position tracking with bounded O(N) NAV calculation (FIFO range, max 50 positions)
- ✅ Time-weighted profit accrual mechanism (per-position accuracy)
- ✅ Position lifecycle (open, track, FIFO claim)
- ✅ **Arbitrage execution with trustless validation** (Phase 5)
- ✅ DEX integration with slippage protection
- ✅ Profit threshold enforcement
- ✅ Security: bookValue measured via balance delta (attack-proof)
- ✅ Security: expectedAssets from Ethena (attack-proof)
- ✅ Security: allowance reset after each swap (prevents malicious keeper attack)
- ✅ **Withdrawal queue system with explicit API** (Phase 6)
  - Escrow mechanism: shares held in contract, assets at current NAV (fairness)
  - FIFO-safe cancellation: O(1) removal via _removeFromQueue() (marks slot empty)
  - User-triggered claims: redeem() calls _tryClaimFirstPosition() if needed
  - Queue priority: redeem() blocked when queue not empty (prevents jumping)
  - Auto-fulfill on deposit: new liquidity goes to queue first
  - Consolidated claim+fulfill logic in _tryClaimFirstPosition()
- ✅ **DoS protection implemented:**
  - O(1) queue operations (head/tail pointers instead of array shifting)
  - MIN_WITHDRAWAL_ASSETS = 1 USDe (spam protection)
  - MIN_TIME_BEFORE_CANCEL = 5 minutes (request/cancel spam protection)
  - maxWithdrawalsPerTx batch limit for gas safety
- ✅ Test harness for unit tests (ArbitrageVaultHarness - testing only, NOT production)
- ✅ Integration tests use production executeArbitrage() (ArbitrageExecution.test.ts)
- ✅ **140 core tests passing, 16 pending** (async-only model - immediate withdrawal tests skipped)
  - Fully covers deposit, requestWithdrawal, queue fulfillment, FIFO, escrow, cancellation
- ✅ Mock contracts with proper authorization (including MockDEX)
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
