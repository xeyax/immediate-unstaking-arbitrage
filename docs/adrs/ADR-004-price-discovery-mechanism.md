## ADR-004 — Price Discovery Mechanism

**Status**: Proposed
**Date**: 2025-11-06
**Deciders**: Smart Contract Engineering Team
**Related FRs**: FR-02

### Context

The vault must identify when sUSDe trades at a discount to its USDe-equivalent value to execute profitable arbitrage. Per FR-02, the vault validates that trades are profitable after accounting for all costs and the 7-day unstaking period.

Two distinct prices exist: sUSDe market price on DEXes and sUSDe fair value from Ethena protocol contracts. The spread between these represents the arbitrage opportunity.

The challenge is determining when arbitrage opportunities exist without introducing on-chain price oracles that add gas costs, staleness risk, and manipulation vectors.

### Decision

**Off-chain price discovery with on-chain slippage protection.** Keeper monitors market prices off-chain and submits arbitrage transactions only when profitable opportunities are detected. The vault contract does not validate prices or spreads - it only enforces slippage protection via minAmountOut during the swap. After execution, actual profit is immediately known via Ethena protocol contracts.

This approach eliminates on-chain price oracles entirely, prioritizing gas efficiency and execution speed. Protection against bad trades comes from slippage bounds, not pre-execution price validation.

### Options Considered

**Off-chain Monitoring with Slippage Protection (chosen)**
Keeper monitors market prices off-chain; submits transactions only when profitable. Contract enforces minAmountOut during swap; actual profit known via Ethena protocol contracts after execution. Trade-offs: Gas efficient, no oracle costs or staleness, fast execution captures fleeting opportunities; requires authorized keeper (centralization), keeper downtime halts operations.

**Chainlink Oracle Integration**
Deploy on Arbitrum to access Chainlink sUSDe/USDe feed; validate prices on-chain before execution. Trade-offs: Manipulation-resistant, decentralized; requires L2 deployment (conflicts with Ethereum mainnet), adds oracle staleness and gas overhead, Chainlink deviation threshold may miss small spreads below 0.5%.

**Uniswap V3 TWAP Oracle**
Use Uniswap V3 observe() for time-weighted average price. Trade-offs: On-chain, manipulation-resistant; requires sufficient pool liquidity (may not exist), TWAP lag prevents capturing short-lived opportunities, significant gas cost per query, UwU Lend precedent shows TWAP vulnerable to sustained manipulation.

**On-chain Spread Validation**
Keeper submits expected spread; contract validates against MIN_SPREAD threshold before execution. Trade-offs: Provides additional validation layer; adds gas cost and complexity, doesn't prevent losses if market moves during transaction, redundant with slippage protection that already prevents bad executions.

### Consequences

**Off-chain Responsibilities**
- Keeper monitors market for sUSDe discount opportunities.
- Keeper calculates expected profit and decides whether to submit transaction.
- Keeper determines appropriate minAmountOut based on acceptable slippage.

**On-chain Behavior**
- executeArbitrage() receives amountIn and minAmountOut parameters.
- Contract validates capital availability.
- Contract validates minimum profit threshold (configurable parameter, default 0.1%).
- Slippage protection via minAmountOut prevents execution at worse-than-expected prices.
- After swap completes, actual profit immediately known via Ethena protocol contracts.
- No on-chain price oracle validation.

**Trade-offs**
- Gas efficient: no oracle calls, minimal validation logic.
- Fast execution: no TWAP delays or oracle update waiting.
- Operational dependency: requires authorized keeper (botOperator role).
- Trust assumption: keeper must act in vault's interest (but slippage protection limits damage from mistakes).

### On-Chain Implementation Notes

**Function Signature**
- executeArbitrage(amountIn, minAmountOut, swapCalldata)
- No expectedSpread or market price parameters needed

**Execution Flow**
1. Validate keeper authorization
2. Validate capital availability
3. Calculate expected profit: sUSDe.convertToAssets(expected_sUSDe_amount) - amountIn
4. Validate minimum profit: require(expectedProfit >= (amountIn × minProfitThreshold) / 10000)
5. Execute swap with minAmountOut slippage protection
6. Initiate unstaking for received sUSDe
7. Calculate actual profit via Ethena protocol contracts
8. Emit ArbitrageExecuted event with actual profit for off-chain monitoring

**Key Points**
- No oracle calls or on-chain price validation
- Minimum profit threshold prevents unprofitable trades (default 0.1% = 10 basis points)
- Actual profit known immediately via Ethena protocol contracts
- Slippage protection and minimum profit threshold together prevent bad executions

### Dependencies

- ADR-005 (Access Control and Parameters): Keeper authorization and minimum profit threshold parameter.

### ADRs Depending on This

- ADR-006 (Withdrawal Liquidity Management): No deployment limits means keeper can execute all profitable opportunities above threshold.

### References

- [Ethena sUSDe Documentation](https://docs.ethena.fi/solution-overview/usde-overview/staked-usde) - protocol contracts for determining fair value
