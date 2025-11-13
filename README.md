# sUSDe/USDe Staking Arbitrage Vault

ERC-4626 vault that captures arbitrage opportunities between sUSDe (staked USDe) and USDe tokens by purchasing discounted sUSDe on secondary markets and unstaking for profit.

## Overview

The vault enables depositors to earn returns by exploiting sUSDe market price discrepancies. When sUSDe trades below its fair value on DEXs (typically 0.1%-0.3% discount), authorized keepers execute arbitrage trades: purchase discounted sUSDe and initiate unstaking to receive full USDe value after the 7-day cooldown period.

## Key Features

- **ERC-4626 Standard**: Standard tokenized vault with withdrawal queue extension
- **Automated Arbitrage**: Authorized keepers execute profitable trades with minimum profit threshold
- **Fair Share Pricing**: Time-weighted profit accrual ensures fair NAV for all depositors
- **Withdrawal Queue**: FIFO queue with cancellation and partial fulfillment support
- **Performance Fees**: Configurable fee on realized profits

## How It Works

1. **Deposit**: Users deposit USDe and receive vault shares
2. **Arbitrage Execution**: Authorized keepers purchase discounted sUSDe when profitable
3. **Unstaking**: Vault immediately initiates 7-day cooldown unstaking
4. **Position Maturation**: After 7 days, positions become claimable
5. **Profit Realization**: Claimed positions add profit to vault, increasing share value
6. **Withdrawal**: Users request withdrawals via queue, fulfilled FIFO as positions mature

## Development

### Tech Stack
- **Smart Contracts**: Solidity 0.8.20
- **Framework**: Hardhat
- **Testing**: TypeScript + Chai + Ethers v6
- **Type Generation**: TypeChain for contract types

### Quick Start

```bash
# Install dependencies
npm install

# Compile contracts and generate TypeChain types
npm run compile

# Run tests
npm test

# Run tests with gas reporting
npm run test:gas

# Run coverage
npm run coverage
```

### Project Structure
```
contracts/
  ├── ArbitrageVault.sol      # Main ERC-4626 vault
  └── mocks/
      └── MockERC20.sol        # Test token
test/
  └── ArbitrageVault.test.ts   # TypeScript tests
docs/
  └── development-plan.md      # Implementation roadmap
```

## Documentation

- [Vision](docs/vision.md) - Product vision and success metrics
- [Requirements](docs/requirements.md) - Functional requirements
- [ADRs](docs/adrs/plan.md) - Architecture decision records
- [Development Plan](docs/development-plan.md) - Implementation roadmap
- [Test Coverage](docs/test-coverage.md) - Test checklist and coverage tracking

## Architecture Decisions

The vault implements several key design decisions:

- **ERC-4626 with Withdrawal Queue** (ADR-001): Standard vault interface extended with withdrawal queue to prevent indefinite lockup during continuous redeployment
- **Time-Weighted NAV** (ADR-002): Fair share pricing using time-proportional profit accrual
- **Accrual Rate Accounting** (ADR-003): O(1) NAV calculation via aggregate accrual rate instead of iterating positions
- **Off-Chain Price Discovery** (ADR-004): Keepers provide swap parameters, vault validates minimum profit threshold
- **Owner-Controlled Parameters** (ADR-005): Single owner controls all 5 parameters (performance fee, fee recipient, min profit threshold, keeper whitelist, owner)
- **No Deployment Limits** (ADR-006): Withdraw via queue instead of limiting capital deployment
- **Continuous Fee Collection** (ADR-007): Fees collected on every external call for smooth distribution

## Security

- Owner-controlled parameter management
- Minimum profit threshold prevents unprofitable trades
- Keeper authorization prevents unauthorized arbitrage execution
- 7-day unstaking period enforced by Ethena protocol

## License

MIT
