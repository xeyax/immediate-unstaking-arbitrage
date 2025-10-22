# sUSDe Immediate Unstaking Arbitrage Vault

An ERC-4626 compliant vault that executes immediate unstaking arbitrage for sUSDe/USDe on Ethereum Mainnet, featuring linear profit accrual and FIFO withdrawal queues.

## Overview

This system captures arbitrage opportunities between sUSDe market prices and intrinsic unstaking value. The vault swaps USDe for sUSDe at market rates, immediately requests unstaking, and distributes profits linearly to LPs during the cooldown period.

### Key Features

- **ERC-4626 Compliant**: Standard vault interface for deposits/withdrawals
- **Linear Profit Accrual**: Smooth PPS growth using emission rate system
- **On-Chain Profit Verification**: Transactions revert if profit below threshold
- **FIFO Withdrawal Queue**: Handles liquidity during cooldown periods
- **Locker Pool Management**: Isolated cooldown positions with batch tracking
- **Access Control**: Admin and Keeper roles for secure operations
- **Pausable**: Emergency stop mechanism

## Architecture

### Core Contracts

```
contracts/
├── core/
│   ├── Vault.sol              # Main ERC-4626 vault with arbitrage logic
│   └── CooldownManager.sol    # Manages locker pool and batch lifecycle
├── adapters/
│   └── SUSDeAdapter.sol       # sUSDe protocol integration
├── utils/
│   ├── Locker.sol            # Holds individual unstaking positions
│   └── LockerFactory.sol     # Creates locker instances
└── interfaces/
    ├── IVaultMvp.sol
    ├── ICooldownManager.sol
    ├── ISUSDeAdapter.sol
    └── external/
        ├── ISUSDe.sol
        └── IUSDe.sol
```

### System Flow

```
1. User deposits USDe → receives vault shares
2. Keeper executes arbitrage:
   - Swaps USDe → sUSDe via DEX
   - Verifies profit on-chain
   - Opens cooldown via CooldownManager
   - Batch tracks maturity time
3. Profits accrue linearly during cooldown
4. Keeper claims matured batches
5. Users withdraw USDe (immediate if cash available, else queued)
```

### NAV Formula

```
NAV = C + P0 + G(t) - R

Where:
C  = Cash (idle USDe)
P0 = Cost locked in cooldowns
G(t) = Accrued gain = accruedGain + emissionRate × (now - lastUpdate)
R  = Withdrawal queue obligations
```

## Prerequisites

### Install Foundry

```bash
curl -L https://foundry.paradigm.xyz | bash
foundryup
```

### Install Dependencies

```bash
forge install
```

## Development

### Build

```bash
forge build
```

The project uses `via_ir = true` for optimization and to avoid stack-too-deep errors.

### Test

Run all tests:
```bash
forge test
```

Run with verbosity:
```bash
forge test -vvv
```

Run specific test:
```bash
forge test --match-test test_Deposit
```

Run tests with gas report:
```bash
forge test --gas-report
```

### Coverage

```bash
forge coverage
```

## Deployment

### Setup Environment

Create `.env` file:
```bash
PRIVATE_KEY=your_private_key_here
MAINNET_RPC_URL=https://eth.llamarpc.com
ETHERSCAN_API_KEY=your_etherscan_api_key
```

### Deploy to Mainnet

```bash
forge script script/DeployVault.s.sol:DeployVault \
  --rpc-url mainnet \
  --broadcast \
  --verify
```

This will:
1. Deploy SUSDeAdapter
2. Deploy CooldownManager
3. Deploy Vault
4. Deploy LockerFactory and create initial lockers
5. Configure roles and permissions
6. Save addresses to `.env.deployment`

### Post-Deployment Configuration

After deployment, you need to:

1. **Whitelist DEX Router**:
```solidity
vault.setRouterWhitelist(ROUTER_ADDRESS, true);
```

2. **Set Parameters** (optional, defaults are reasonable):
```solidity
vault.setParameters(
    15,                    // minProfitBps: 0.15%
    10 days,               // maxUnstakeTime
    type(uint256).max,     // depositCap (no limit)
    0                      // perfFeeBps (no fees in MVP)
);
```

3. **Grant Additional Keeper Roles** (optional):
```solidity
vault.grantRole(KEEPER_ROLE, KEEPER_ADDRESS);
```

## Usage

### For Users (LPs)

**Deposit USDe**:
```solidity
IERC20(USDe).approve(vault, amount);
vault.deposit(amount, receiver);
```

**Withdraw USDe** (immediate if cash available):
```solidity
vault.redeem(shares, receiver, owner);
```

**Request Withdrawal** (with queue if needed):
```solidity
vault.requestWithdraw(shares);
```

### For Keepers

**Execute Arbitrage**:
```solidity
IVaultMvp.ExecuteArbParams memory params = IVaultMvp.ExecuteArbParams({
    baseAmountIn: 100_000e18,           // USDe amount
    router: DEX_ROUTER_ADDRESS,
    swapCalldata: ...,                  // Encoded swap data
    minProfitBps: 15,                   // 0.15% minimum profit
    maxUnstakeTime: 10 days
});

vault.executeArb(params);
```

**Claim Matured Batch**:
```solidity
vault.claimBatch(batchId);
```

## Contract Addresses (Mainnet)

After deployment, addresses will be saved to `.env.deployment`:

```
VAULT_ADDRESS=0x...
COOLDOWN_MANAGER_ADDRESS=0x...
ADAPTER_ADDRESS=0x...
LOCKER_FACTORY_ADDRESS=0x...
```

## Token Addresses

- **USDe**: `0x4c9edd5852cd905f086c759e8383e09bff1e68b3`
- **sUSDe**: `0x9D39A5DE30e57443BfF2A8307A4256c8797A3497`

## Security

### Access Control

- **DEFAULT_ADMIN_ROLE**: Can set parameters, pause, manage roles
- **KEEPER_ROLE**: Can execute arbitrage and claim batches
- **VAULT_ROLE** (in CooldownManager): Only vault can open cooldowns

### Safety Features

- On-chain profit verification (reverts if profit < threshold)
- Maximum unstake time check
- Deposit cap to limit TVL
- Pausable for emergency stops
- ReentrancyGuard on all state-changing functions
- Router whitelist for DEX interactions

### Audits

⚠️ **This is an MVP and has not been audited. Use at your own risk.**

## Testing

The test suite covers:

- ✅ Basic deposit/withdraw functionality
- ✅ Multi-user interactions
- ✅ NAV and PPS calculations
- ✅ Access control
- ✅ Pause mechanism
- ✅ Deposit caps
- ✅ CooldownManager locker pool

For full arbitrage cycle testing with real DEX interactions, see advanced test suite (requires mainnet fork).

## Documentation

- [MVP Specification](docs/mvp.md) - Detailed technical specification
- [Design Document](docs/design.md) - Architecture and formulas

## License

MIT

## Contributing

Contributions are welcome! Please:

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests
5. Submit a pull request

## Acknowledgments

Built with:
- [Foundry](https://book.getfoundry.sh/) - Ethereum development toolkit
- [OpenZeppelin Contracts](https://github.com/OpenZeppelin/openzeppelin-contracts) - Secure smart contract library
- [Ethena](https://ethena.fi/) - USDe and sUSDe tokens
