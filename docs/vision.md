# Product Vision

## 1. Purpose

This vault product captures arbitrage opportunities between sUSDe and USDe by purchasing discounted sUSDe tokens on secondary markets and unstaking them for the full USDe value, earning the price discrepancy as profit. The solution addresses the persistent market inefficiency where sUSDe trades at 0.1-0.3% discount despite representing a higher underlying USDe value due to accumulated staking rewards. By systematically exploiting this spread, the vault generates consistent returns for depositors while simultaneously improving market efficiency and providing liquidity support for users exiting sUSDe positions. This matters now because the Ethena ecosystem has reached significant scale with billions in TVL, creating liquid markets with regular pricing inefficiencies that can be profitably arbitraged.

## 2. Target Users

| Persona | Goal | Primary Pain Point |
|---------|------|-------------------|
| DeFi Yield Farmers | Maximize returns on stablecoin holdings with minimal risk | Current stablecoin yields are low and require active management across multiple protocols |
| Risk-Averse Investors | Generate steady returns without exposure to volatile crypto assets | Traditional yield strategies involve impermanent loss or directional market risk |
| sUSDe Holders | Exit positions quickly without market slippage | Must accept 0.3%+ discount when selling sUSDe on secondary markets instead of waiting 7 days |

## 3. Problem Statement

Users face inefficient pricing between sUSDe and USDe on secondary markets because the 7-day unstaking period creates liquidity constraints and market impatience, which leads to persistent price discounts of 0.1-0.3% that represent pure arbitrage profit being left uncaptured while simultaneously harming users who need immediate liquidity from their sUSDe positions.

## 4. Product Hypothesis

If we provide users with an automated vault that continuously monitors and executes profitable sUSDe/USDe arbitrage trades, then we will generate consistent yield for vault depositors while improving liquidity and pricing efficiency for users exiting sUSDe positions.

## 5. Success Metrics

| Metric | Description | Target | Measurement Method |
|--------|-------------|--------|-------------------|
| Vault APY | Annualized percentage yield for vault depositors | 10-15% | Compound annual growth rate of vault share price |
| Vault Utilization | Percentage of time vault capital is actively deployed in arbitrage positions | >80% | Average deployment time across measurement period |