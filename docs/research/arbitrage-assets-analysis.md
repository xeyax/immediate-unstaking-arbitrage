# Arbitrage Assets Analysis

Research on assets with similar arbitrage potential to sUSDe/USDe.

## Key Criteria

For a staking arbitrage strategy to work, two conditions are essential:

### 1. Cooldown Period (Required)
- Creates a temporal arbitrage window
- Market cannot instantly close the price gap
- Without cooldown → bots arbitrage instantly → no opportunity

### 2. Sufficient DEX Liquidity (Required)
- Ability to enter/exit positions with meaningful size
- Deep liquidity pools on Curve, Uniswap, Balancer, etc.
- Reduces slippage on trades

## Asset Analysis

### Qualifying Assets (Have Cooldown + Liquidity)

| Asset | Protocol | Cooldown | DEX Liquidity | Redemption Mechanism |
|-------|----------|----------|---------------|----------------------|
| **sUSDe/USDe** | Ethena | 7 days | ~$100M+ (Curve) | `cooldownShares()` → `unstake()` |
| **stETH/ETH** | Lido | 1-5+ days | ~$500M+ (Curve) | Withdrawal queue |
| **rETH/ETH** | Rocket Pool | days-weeks | ~$50M | Depends on minipool exits |
| **wBETH/ETH** | Binance | 7-15 days | ~$30M | Centralized process |
| **mETH/ETH** | Mantle | ~days | ~$20M | Withdrawal queue |

### Disqualified Assets (No Cooldown)

| Asset | Protocol | Why Disqualified |
|-------|----------|------------------|
| sUSDS/USDS | Sky (MakerDAO) | Instant redemption - arbitrage closed by bots immediately |
| sDAI/DAI | MakerDAO | Instant redemption |
| sFRAX/FRAX | Frax | Instant redemption |
| wstETH/stETH | Lido | Instant wrap/unwrap - no arbitrage window |

## Detailed Analysis: Top Candidates

### 1. sUSDe/USDe (Current Implementation)

```
Protocol: Ethena
Cooldown: 7 days (fixed)
Liquidity: ~$100M+ on Curve
Historical discount: 0-5%
Base asset: Stablecoin (USDe ≈ $1)
Yield: 15-25% APY (creates selling pressure on sUSDe)
```

**Advantages:**
- Long cooldown (7 days) creates larger arbitrage windows
- Stable base asset (no ETH price risk)
- High yield creates consistent selling pressure → discounts
- Large TVL ($5B+)

### 2. stETH/ETH (Lido)

```
Protocol: Lido
Cooldown: 1-5+ days (variable, depends on queue)
Liquidity: ~$500M+ on Curve (largest LST liquidity)
Historical discount: 0-0.5% typical, up to 5% in stress
Base asset: ETH (volatile)
```

**Conversion Flow:**
```
wstETH ──[instant]──> stETH ──[cooldown]──> ETH
         unwrap()            Lido queue
```

**Key Points:**
- wstETH/stETH: NO arbitrage (instant conversion)
- stETH/ETH: YES arbitrage (cooldown on withdrawal)
- wstETH/ETH: YES arbitrage (goes through stETH)

**Advantages:**
- Largest liquidity of any LST
- Well-established protocol
- Transparent withdrawal queue

**Disadvantages:**
- ETH price exposure during cooldown
- Smaller typical discounts (0-0.5%)
- Variable cooldown period

### 3. rETH/ETH (Rocket Pool)

```
Protocol: Rocket Pool
Cooldown: Days to weeks (depends on minipool exits)
Liquidity: ~$50M (moderate)
Historical discount/premium: -2% to +2%
```

**Key Points:**
- Can trade at PREMIUM (not just discount)
- Less predictable cooldown
- Decentralized validator set

**Disadvantages:**
- Lower liquidity
- Unpredictable redemption timing
- Premium scenarios don't fit discount arbitrage model

### 4. wBETH/ETH (Binance)

```
Protocol: Binance
Cooldown: 7-15 days
Liquidity: ~$30M
```

**Disadvantages:**
- Centralized (counterparty risk)
- Less transparent redemption process
- Lower liquidity

## Comparison Matrix

| Factor | sUSDe | stETH | rETH | wBETH |
|--------|-------|-------|------|-------|
| Cooldown predictability | High (fixed 7d) | Medium (1-5d+) | Low (variable) | Medium |
| DEX liquidity | High | Very High | Medium | Low |
| Base asset volatility | None (stablecoin) | High (ETH) | High (ETH) | High (ETH) |
| Discount frequency | High | Low | Variable | Low |
| Protocol risk | Medium | Low | Low | High (centralized) |
| Implementation complexity | Medium | Medium | High | Medium |

## Conclusions

### Best Candidates for Arbitrage Vault

1. **sUSDe/USDe** (Current) - Best overall due to:
   - Fixed, long cooldown
   - Stable base asset
   - Frequent discounts from high yield selling pressure

2. **stETH/ETH** - Second best due to:
   - Highest liquidity
   - Established protocol
   - But: ETH price risk, smaller discounts

### Not Recommended

- **sUSDS/USDS, sDAI/DAI, sFRAX/FRAX** - No cooldown = no arbitrage opportunity
- **wstETH/stETH** - Instant conversion = no arbitrage opportunity
- **rETH/ETH** - Unpredictable cooldown, can trade at premium
- **wBETH/ETH** - Centralization risk, lower liquidity

## Future Research

- [ ] Historical discount analysis for stETH/ETH (on-chain data)
- [ ] Lido withdrawal queue statistics (average wait times)
- [ ] Gas cost comparison for different redemption mechanisms
- [ ] Multi-asset vault architecture considerations

---

*Last updated: 2026-01-22*
