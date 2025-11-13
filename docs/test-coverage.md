# Test Coverage Checklist

## Phase 1: Core ERC-4626 Vault ✅

### Deployment
- [x] Sets correct vault name and symbol
- [x] Sets correct underlying asset (USDe)
- [x] Sets correct owner
- [x] Reverts on zero address

### Deposits
- [x] Allows deposit and mints shares
- [x] Emits `Deposited` event
- [x] First deposit has 1:1 ratio
- [x] Handles multiple deposits correctly

### Minting
- [x] Allows minting shares
- [x] Emits `Deposited` event on mint

### Withdrawals
- [x] Allows withdrawal by burning shares
- [x] Emits `Withdrawn` event
- [x] Reverts on insufficient balance

### Redeeming
- [x] Allows redeeming shares for assets
- [x] Emits `Withdrawn` event on redeem

### Total Assets
- [x] Calculates total assets correctly
- [x] Updates after withdrawals

### Share Pricing
- [x] Maintains 1:1 price (Phase 1)

**Coverage:** 18/18 tests passing

---

## Phase 2: Position Tracking System ⏳

### Position Lifecycle
- [ ] Opens position with sUSDe amount and book value
- [ ] Stores position timestamp
- [ ] Emits `PositionOpened` event
- [ ] Claims matured position (7+ days)
- [ ] Reverts claim if position not matured
- [ ] Emits `PositionClaimed` event
- [ ] Marks position as claimed

### Position Storage
- [ ] Tracks multiple positions correctly
- [ ] Returns correct position by ID
- [ ] Updates total active positions
- [ ] Updates total book value

### Accrual Rate
- [ ] Calculates accrual rate correctly
- [ ] Updates on position open
- [ ] Updates on position claim

**Coverage:** 0/14 tests

---

## Phase 3: NAV Calculation Engine ⏳

### Time-Weighted Accrual
- [ ] Calculates expected profit from sUSDe rate
- [ ] Accrues profit linearly over 7 days
- [ ] Returns full profit after 7 days
- [ ] Returns zero profit at position start

### Total Assets
- [ ] Includes idle USDe balance
- [ ] Includes position book values
- [ ] Includes accrued profits
- [ ] Correctly handles multiple positions
- [ ] Updates when positions mature

### Position Valuation
- [ ] `getPositionValue()` returns correct value
- [ ] `getTotalPositionsValue()` aggregates correctly

### Share Pricing
- [ ] Share price increases as profit accrues
- [ ] Maintains fairness for new depositors
- [ ] Maintains fairness for existing holders

**Coverage:** 0/13 tests

---

## Phase 4: Arbitrage Execution Module ⏳

### Access Control
- [ ] Allows keeper to be added by owner
- [ ] Allows keeper to be removed by owner
- [ ] Emits `KeeperAdded` event
- [ ] Emits `KeeperRemoved` event
- [ ] Reverts if non-owner adds keeper
- [ ] Reverts if non-owner removes keeper

### Arbitrage Execution
- [ ] Allows keeper to execute arbitrage
- [ ] Reverts if non-keeper tries to execute
- [ ] Validates minimum profit threshold
- [ ] Reverts if profit below threshold
- [ ] Executes DEX swap correctly
- [ ] Stakes USDe to receive sUSDe
- [ ] Opens position after arbitrage
- [ ] Emits `ArbitrageExecuted` event

### Parameter Management
- [ ] Owner can set min profit threshold
- [ ] Reverts on invalid threshold (e.g., > 100%)
- [ ] Emits parameter update event

**Coverage:** 0/15 tests

---

## Phase 5: Withdrawal Queue System ⏳

### Request Management
- [ ] Creates withdrawal request
- [ ] Returns request ID
- [ ] Stores request with correct data
- [ ] Emits `WithdrawalRequested` event
- [ ] Allows cancellation before fulfillment
- [ ] Emits `WithdrawalCanceled` event
- [ ] Reverts cancellation of fulfilled request

### Request Fulfillment
- [ ] Fulfills requests in FIFO order
- [ ] Handles partial fulfillment
- [ ] Marks request as fulfilled
- [ ] Emits `WithdrawalFulfilled` event
- [ ] Transfers assets to requester
- [ ] Burns shares from requester

### Queue Management
- [ ] Triggers fulfillment on position claim
- [ ] Respects 7-day maximum guarantee
- [ ] Handles multiple pending requests
- [ ] Returns correct queue status

**Coverage:** 0/16 tests

---

## Phase 6: Fee Collection Mechanism ⏳

### Fee Configuration
- [ ] Owner can set performance fee
- [ ] Validates fee <= 30%
- [ ] Owner can set fee recipient
- [ ] Validates non-zero recipient
- [ ] Emits `FeeParametersUpdated` event

### Fee Collection
- [ ] Collects fees on deposit
- [ ] Collects fees on withdrawal
- [ ] Collects fees on arbitrage
- [ ] Calculates fee from realized profit
- [ ] Accumulates fees correctly
- [ ] Emits `FeeCollected` event

### Fee Withdrawal
- [ ] Fee recipient can withdraw fees
- [ ] Transfers correct amount
- [ ] Updates accumulated fees

**Coverage:** 0/13 tests

---

## Phase 7: Parameter Management ⏳

### Owner Functions
- [ ] Only owner can change parameters
- [ ] Non-owner calls revert
- [ ] Parameter changes emit events

### Integration Tests
- [ ] Full deposit → arbitrage → claim → withdraw flow
- [ ] Multiple users with different entry/exit times
- [ ] Fee collection across full lifecycle
- [ ] Queue fulfillment under various conditions
- [ ] Gas consumption within limits

**Coverage:** 0/8 tests

---

## Edge Cases & Security ⏳

### Edge Cases
- [ ] Zero deposits
- [ ] Zero withdrawals
- [ ] First depositor edge case
- [ ] Last withdrawer edge case
- [ ] Simultaneous operations
- [ ] Position claim exactly at 7 days

### Security
- [ ] Reentrancy protection on all external calls
- [ ] Integer overflow/underflow protection
- [ ] Access control on privileged functions
- [ ] No locked funds scenarios
- [ ] No share price manipulation

**Coverage:** 0/11 tests

---

## Summary

| Phase | Tests Passing | Tests Total | Coverage |
|-------|--------------|-------------|----------|
| Phase 1: Core Vault | 18 | 18 | 100% ✅ |
| Phase 2: Position Tracking | 0 | 14 | 0% |
| Phase 3: NAV Calculation | 0 | 13 | 0% |
| Phase 4: Arbitrage | 0 | 15 | 0% |
| Phase 5: Withdrawal Queue | 0 | 16 | 0% |
| Phase 6: Fees | 0 | 13 | 0% |
| Phase 7: Integration | 0 | 8 | 0% |
| Edge Cases & Security | 0 | 11 | 0% |
| **TOTAL** | **18** | **108** | **17%** |

---

## Notes

- All tests use TypeScript with TypeChain-generated types
- Tests use Hardhat's `loadFixture` for gas optimization
- Each phase should achieve 100% coverage before moving to next
- Integration tests should be added throughout, not just at end
- Security tests should be written alongside functionality tests
