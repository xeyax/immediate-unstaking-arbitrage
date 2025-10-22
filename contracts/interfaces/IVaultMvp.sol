// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title IVaultMvp
 * @notice Interface for the sUSDe arbitrage vault (ERC-4626 compliant)
 * @dev Extends ERC-4626 with arbitrage execution and withdrawal queue functionality
 */
interface IVaultMvp {
    /*//////////////////////////////////////////////////////////////
                                STRUCTS
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Parameters for executing an arbitrage trade
     * @param baseAmountIn Amount of USDe to spend on swap
     * @param router Address of the DEX router to use
     * @param swapCalldata Calldata for low-level call to router
     * @param minProfitBps Minimum profit in basis points (overrides global if non-zero)
     * @param maxUnstakeTime Maximum unstake time in seconds (overrides global if non-zero)
     */
    struct ExecuteArbParams {
        uint256 baseAmountIn;
        address router;
        bytes swapCalldata;
        uint256 minProfitBps;
        uint256 maxUnstakeTime;
    }

    /*//////////////////////////////////////////////////////////////
                                EVENTS
    //////////////////////////////////////////////////////////////*/

    event BatchOpened(
        uint256 indexed batchId,
        address indexed locker,
        uint256 cost,
        uint256 expectedMature,
        uint256 gain,
        uint64 t0,
        uint64 t1,
        uint256 rate
    );

    event BatchMatured(
        uint256 indexed batchId,
        address indexed locker,
        uint256 actualReceived
    );

    event AccrualUpdated(
        uint256 accruedGain,
        uint256 emissionRate,
        uint256 timestamp
    );

    event WithdrawQueued(
        address indexed user,
        uint256 shares,
        uint256 owed,
        uint256 paidNow,
        uint256 queuedAmount
    );

    event WithdrawPaidFromQueue(
        address indexed user,
        uint256 amount
    );

    event FeesTaken(
        uint256 feeAmount,
        uint256 sharesMinted,
        address indexed feeRecipient
    );

    event ParametersUpdated(
        uint256 minProfitBps,
        uint256 maxUnstakeTime,
        uint256 depositCap,
        uint256 perfFeeBps
    );

    /*//////////////////////////////////////////////////////////////
                            ARBITRAGE FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Execute arbitrage: swap USDe -> sUSDe and start cooldown
     * @param p Arbitrage execution parameters
     * @return batchId The ID of the newly created batch
     */
    function executeArb(ExecuteArbParams calldata p) external returns (uint256 batchId);

    /**
     * @notice Claim a matured batch after cooldown completes
     * @param batchId The ID of the batch to claim
     * @return amountBaseReceived Amount of USDe received
     */
    function claimBatch(uint256 batchId) external returns (uint256 amountBaseReceived);

    /*//////////////////////////////////////////////////////////////
                        WITHDRAWAL QUEUE FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Request withdrawal with FIFO queue if insufficient cash
     * @param shares Number of shares to withdraw
     */
    function requestWithdraw(uint256 shares) external;

    /*//////////////////////////////////////////////////////////////
                            VIEW FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Get current Net Asset Value
     * @return Current NAV = C + P0 + accruedGain - R
     */
    function nav() external view returns (uint256);

    /**
     * @notice Get current Price Per Share
     * @return Current PPS based on NAV and total supply
     */
    function pps() external view returns (uint256);
}
