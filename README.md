# Immediate Unstaking Arbitrage

An automated trading system for immediate unstaking arbitrage opportunities.

## Project Structure

```
├── contracts/      # Solidity smart contracts
├── test/          # Contract tests (Foundry)
├── script/        # Deployment and interaction scripts
├── lib/           # Dependencies (managed by Foundry)
├── frontend/      # Frontend application
└── out/           # Compiled contract artifacts
```

## Smart Contract Development

This project uses [Foundry](https://book.getfoundry.sh/) for Solidity development.

### Prerequisites

Install Foundry:
```bash
curl -L https://foundry.paradigm.xyz | bash
foundryup
```

### Build Contracts

```bash
forge build
```

### Run Tests

```bash
forge test
```

For verbose output:
```bash
forge test -vvv
```

### Deploy Contracts

1. Copy `.env.example` to `.env` and fill in your values:
```bash
cp .env.example .env
```

2. Deploy to a network:
```bash
forge script script/Deploy.s.sol:DeployScript --rpc-url <your_rpc_url> --broadcast --verify
```

### Format Code

```bash
forge fmt
```

### Gas Snapshots

```bash
forge snapshot
```

## Frontend Development

```bash
cd frontend
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

## Deployment

Live at: https://immediate-unstaking-arbitrage.xeya.xyz

Production deployment is automatically triggered on every push to the main branch via Vercel.
