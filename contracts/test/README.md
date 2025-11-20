# Test Harness Contracts

This directory contains test-only contracts that should **NEVER** be deployed to production.

## Purpose

Test harnesses expose internal functions and provide test helpers without polluting the production contracts with test-specific code.

## Contracts

### ArbitrageVaultHarness.sol

**Purpose:** Testing proxy orchestration during Phase 2-4.

**Test Helpers:**
- `initiateUnstakeForTesting()` - Simulates arbitrage execution for Phase 2
- `claimUnstakeForTesting()` - Simulates position claiming for Phase 2

**Lifecycle:**
- **Phase 2-4:** Use harness for testing proxy and position logic
- **Phase 5+:** Switch to testing through `executeArbitrage()` and `claimPosition()`
- **Production:** Deploy only `ArbitrageVault.sol`, **NOT** this harness

## Usage in Tests

```typescript
// Import harness instead of main contract
import { ArbitrageVaultHarness } from "../typechain-types";

// Deploy harness in test fixture
const ArbitrageVaultHarnessFactory = await ethers.getContractFactory("ArbitrageVaultHarness");
const vault = await ArbitrageVaultHarnessFactory.deploy(usde, sUsde);

// Use test helpers
await vault.initiateUnstakeForTesting(amount);
await vault.claimUnstakeForTesting(proxyAddress);
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
