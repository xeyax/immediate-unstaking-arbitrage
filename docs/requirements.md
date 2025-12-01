# Functional Requirements

## FR-01 — Vault Deposit and Withdrawal Management

The vault must provide a mechanism for users to deposit USDe tokens and receive proportional vault shares representing their ownership stake. Users should be able to withdraw their funds by burning vault shares to receive their proportional share of vault assets, with the system ensuring fair value distribution that accounts for any pending arbitrage positions and accumulated profits. The vault must maintain accurate accounting of all depositor positions and prevent any timing manipulations that could disadvantage existing depositors.

_Related:_ FR-02, FR-05

## FR-02 — Arbitrage Opportunity Validation

The vault must validate that proposed arbitrage trades are profitable after accounting for all costs and the 7-day unstaking period. The vault must enforce a configurable minimum profit threshold to prevent execution of trades with insufficient spread. The vault must verify sufficient capital is available for executing the trade.

_Related:_ FR-01, FR-03, FR-04

## FR-03 — Arbitrage Trade Execution

The vault must allow authorized keepers to execute validated arbitrage trades that purchase sUSDe and initiate unstaking to USDe. Keepers cannot cause losses to the vault due to on-chain validation ensuring profitable trades through slippage protection.

_Related:_ FR-02, FR-04

## FR-04 — Unstaking Position Tracking

The vault must track all active unstaking positions including their amounts, start times, and maturity dates. The vault must allow claiming matured positions and reinvesting realized profits back into vault capital.

_Related:_ FR-03, FR-05, FR-07

## FR-05 — Share Value Calculation

The vault must calculate share value based on total vault assets including liquid USDe, deployed sUSDe positions, and pending unstaking positions. The calculation must ensure fair pricing for deposits and withdrawals that prevents existing shareholders from being diluted or exploited.

_Related:_ FR-01, FR-04

## FR-06 — Withdrawal Liquidity Management

The vault must manage withdrawal requests when capital is deployed in unstaking positions. The vault must attempt to finalize matured positions to provide liquidity for withdrawals. Users must be informed of maximum withdrawal wait time (7 days corresponding to unstaking cooldown period).

_Related:_ FR-01, FR-04

## FR-07 — Profit Compounding

The vault must reinvest realized profits from completed arbitrage trades back into vault capital, proportionally increasing the value of all vault shares.

_Related:_ FR-04, FR-05, FR-08

## FR-08 — Performance Fee Collection

The vault must collect a performance fee on realized arbitrage profits. The fee percentage must be configurable by authorized roles and the collected fees must be distributed to a designated fee recipient address.

_Related:_ FR-07

## FR-09 — Interface View Functions

The vault must provide view functions for efficient data retrieval by frontend applications and monitoring tools. These functions must aggregate commonly needed data into single calls to minimize RPC requests and improve user experience. The vault must provide:

- **Vault Statistics** (`getVaultStats`): Aggregate vault metrics including total assets, share supply, share price, idle liquidity, active positions count, pending withdrawals count, total fees collected, and fee parameters
- **User Information** (`getUserInfo`): Aggregate user data including share balance, asset value, number of pending withdrawals, and total amounts in pending withdrawals
- **User Withdrawal Requests** (`getUserWithdrawals`): List of all withdrawal request IDs for a given user address
- **Active Positions** (`getActivePositions`): Array of all unclaimed arbitrage positions with their full details
****
These functions enable efficient monitoring and display of vault state without requiring multiple separate contract calls.

_Related:_ FR-01, FR-04, FR-06

