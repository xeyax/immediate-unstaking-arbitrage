# Test Harness Contracts

This directory contains test-only contracts that should **NEVER** be deployed to production.

## Purpose

Test harnesses expose internal functions and provide test helpers without polluting the production contracts with test-specific code.

## Contracts

### ArbitrageVaultHarness.sol

**Purpose:** Unit testing and edge case testing (ALL PHASES).

**Test Helpers:**
- `openPositionForTesting()` - Opens position with specific parameters for edge case testing
- Exposes internal functions for isolated component testing

**Usage Pattern (Phase 5+):**
- **Unit tests**: Use harness for isolated component testing
  - `ProxyOrchestration.test.ts` - tests proxy allocation logic
  - `PositionTracking.test.ts` - tests position lifecycle and NAV edge cases
  - `BugFixes.test.ts` - tests specific edge cases (zero profit, accrual cap, etc.)
- **Integration tests**: Use production `executeArbitrage()`
  - `ArbitrageExecution.test.ts` - tests full arbitrage flow with real DEX interaction

**Why keep harness after Phase 5:**
- ✅ Unit tests need isolated component testing
- ✅ Edge cases (zero profit, specific timing) hard to reproduce via executeArbitrage()
- ✅ Separation: unit tests (harness) vs integration tests (production)

**Production Deployment:**
- ✅ Deploy: `ArbitrageVault.sol` ONLY
- ❌ DO NOT deploy: `ArbitrageVaultHarness.sol` (test-only contract)

## Usage in Tests

**Unit Tests (use harness):**
```typescript
// Import harness for unit tests
import { ArbitrageVaultHarness } from "../typechain-types";

// Deploy harness in test fixture
const factory = await ethers.getContractFactory("ArbitrageVaultHarness");
const vault = await factory.deploy(usde, sUsde, feeRecipient);

// Test edge cases with specific parameters
await vault.openPositionForTesting(sUsdeAmount, bookValue, expectedAssets);
```

**Integration Tests (use production):**
```typescript
// Import production contract for integration tests
import { ArbitrageVault } from "../typechain-types";

// Deploy production contract
const factory = await ethers.getContractFactory("ArbitrageVault");
const vault = await factory.deploy(usde, sUsde, feeRecipient);

// Test real arbitrage flow
await vault.executeArbitrage(dexTarget, amountIn, minOut, swapCalldata);
```

## Production Deployment

**IMPORTANT:** When deploying to production:

1. Deploy `contracts/ArbitrageVault.sol` (production contract)
2. **DO NOT** deploy `contracts/test/ArbitrageVaultHarness.sol`
3. Test helpers are only for development/testing

The main `ArbitrageVault.sol` contract remains clean and production-ready without any test-specific code.

## Benefits

✅ **Clean production code** - No test functions in deployed contracts
✅ **Access to internals** - Can test internal functions directly
✅ **Gradual migration** - Replace test helpers with real functions in later phases
✅ **Clear separation** - Test code clearly isolated in `/test` directory
