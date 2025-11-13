# sUSDe/USDe Staking Arbitrage Vault

Automated DeFi vault that captures arbitrage opportunities between sUSDe (staked USDe) and USDe tokens by exploiting market price discrepancies.

## Overview

This vault systematically:
1. Monitors sUSDe/USDe price spreads across DEXs
2. Purchases discounted sUSDe when spread exceeds threshold (0.15%+)
3. Initiates unstaking process to receive full USDe value
4. Manages 7-day cooldown period efficiently
5. Distributes profits to vault depositors

## Key Features

- **Automated Arbitrage**: Continuous monitoring and execution of profitable trades
- **Capital Efficient**: Maintains >85% capital utilization through rolling positions
- **Risk Minimized**: Pure arbitrage with no directional market exposure
- **Market Support**: Improves sUSDe liquidity and reduces market discounts

## Architecture

```
├── contracts/          # Smart contracts
│   ├── ArbitrageVault.sol
│   ├── PriceOracle.sol
│   └── interfaces/
├── src/               # TypeScript bot implementation
│   ├── bot/           # Arbitrage bot logic
│   ├── monitoring/    # Price monitoring services
│   └── strategies/    # Trading strategies
├── test/              # Test suites
└── docs/              # Documentation
```

## How It Works

### Arbitrage Cycle

1. **Detection**: Bot monitors DEX pools for sUSDe trading below fair value
2. **Execution**: When spread > 0.15%, vault buys sUSDe at discount
3. **Unstaking**: Initiates unstaking to convert sUSDe → USDe at full value
4. **Cooldown**: Manages 7-day waiting period with capital rotation
5. **Collection**: Claims USDe after cooldown, realizing profit
6. **Distribution**: Profits compound into vault share value

### Example Trade

- sUSDe market price: 0.997 USDe
- sUSDe fair value: 1.000 USDe (1:1 unstaking ratio)
- Spread: 0.3%
- Trade size: 100,000 USDe
- Cost: 99,700 USDe
- Receive after 7 days: 100,000 USDe
- Profit: 300 USDe (0.3%)

## Technical Stack

- **Smart Contracts**: Solidity 0.8.x
- **Bot**: TypeScript, Ethers.js
- **Monitoring**: The Graph, custom indexers
- **Infrastructure**: Docker, Kubernetes
- **Testing**: Hardhat, Foundry

## Risk Management

### Primary Risks
- Smart contract risk (Ethena protocol)
- Liquidity risk (large position sizes)
- Gas cost risk (unprofitable during high gas)
- Cooldown period capital lock

### Mitigations
- Position size limits
- Minimum spread requirements
- Gas price monitoring
- Rolling position management

## Getting Started

### Prerequisites
```bash
node >= 18.0.0
npm >= 9.0.0
```

### Installation
```bash
npm install
```

### Configuration
```bash
cp .env.example .env
# Edit .env with your settings
```

### Running the Bot
```bash
npm run bot:start
```

### Testing
```bash
npm test
```

## Performance Targets

| Metric | Target | Description |
|--------|--------|-------------|
| APY | 10-15% | Annual yield for vault depositors |
| Spread Capture | 0.20%+ | Average profit per arbitrage |
| Success Rate | >95% | Profitable trades percentage |
| Capital Efficiency | >85% | Active capital deployment |

## Security

- Multi-sig vault control
- Timelock on parameter changes
- Emergency pause functionality
- Regular audits scheduled

## License

MIT