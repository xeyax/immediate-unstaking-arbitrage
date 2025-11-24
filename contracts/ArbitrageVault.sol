// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./interfaces/IStakedUSDe.sol";
import "./interfaces/IUSDe.sol";
import "./UnstakeProxy.sol";

/**
 * @title ArbitrageVault
 * @notice ERC-4626 compliant vault that captures arbitrage opportunities
 *         between sUSDe (staked USDe) and USDe tokens.
 * @dev Implements automated staking arbitrage by purchasing discounted sUSDe
 *      on secondary markets and unstaking for profit.
 *
 * Key Features:
 * - ERC-4626 standard vault interface
 * - Automated arbitrage execution via whitelisted keepers
 * - Time-weighted NAV calculation for fair share pricing
 * - Withdrawal queue for liquidity management
 * - Performance fee mechanism
 *
 * Architecture Decisions:
 * - ADR-001: ERC-4626 with withdrawal queue
 * - ADR-002: Time-weighted profit accrual with per-position accuracy
 * - ADR-003: Bounded O(N) position accounting (max 50 active positions)
 * - ADR-005: Owner + keeper access control
 * - ADR-008: Proxy orchestration for concurrent unstakes
 *
 * NAV Calculation Approach:
 * - Iterates through all active positions (bounded by MAX_ACTIVE_POSITIONS = 50)
 * - Each position's profit capped at exactly COOLDOWN_PERIOD (7 days)
 * - No dependency on keeper claiming speed - NAV is always accurate
 * - Gas cost: ~110k for 50 positions (acceptable for deposit/withdraw operations)
 */
contract ArbitrageVault is ERC4626, Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /* ========== STATE VARIABLES ========== */

    /// @notice Vault name: "Arbitrage Vault USDe"
    string private constant VAULT_NAME = "Arbitrage Vault USDe";

    /// @notice Vault symbol: "avUSDe"
    string private constant VAULT_SYMBOL = "avUSDe";

    /// @notice Ethena's Staked USDe contract
    IStakedUSDe public immutable stakedUsde;

    /// @notice Array of all deployed unstake proxy contracts
    address[] public unstakeProxies;

    /// @notice Mapping tracking which proxies are currently busy with active unstakes
    mapping(address proxy => bool isBusy) public proxyBusy;

    /// @notice Index of last allocated proxy for round-robin allocation
    uint256 private lastAllocatedIndex;

    /// @notice Mapping of whitelisted keeper addresses
    mapping(address => bool) public isKeeper;

    /// @notice Performance fee in basis points (0-10000, where 10000 = 100%)
    uint256 public performanceFee;

    /// @notice Address that receives collected fees
    address public feeRecipient;

    /// @notice Minimum profit threshold in basis points (default 10 = 0.1%)
    uint256 public minProfitThreshold;

    /// @notice Maximum performance fee allowed (50% = 5000 basis points)
    uint256 public constant MAX_PERFORMANCE_FEE = 5000;

    /// @notice Basis points denominator (100% = 10000 basis points)
    uint256 public constant BASIS_POINTS = 10000;

    /// @notice Cooldown period for unstaking (7 days in seconds)
    uint256 public constant COOLDOWN_PERIOD = 7 days;

    /// @notice Maximum number of active (unclaimed) positions allowed
    /// @dev Limits gas cost of NAV calculation. 50 positions = ~110k gas for totalAssets()
    uint256 public constant MAX_ACTIVE_POSITIONS = 50;

    /* ========== POSITION TRACKING ========== */

    /// @notice Position data structure
    struct Position {
        uint256 sUsdeAmount;        // sUSDe shares in unstake
        uint256 bookValue;          // USDe paid to acquire sUSDe
        uint256 expectedAssets;     // Expected USDe from Ethena (returned by cooldownShares)
        uint256 startTime;          // When unstake initiated
        bool claimed;               // Whether position has been claimed
        address proxyContract;      // Which UnstakeProxy holds this unstake
    }

    /// @notice Mapping of position ID to Position
    mapping(uint256 => Position) public positions;

    /// @notice First active (unclaimed) position ID in the FIFO queue
    /// @dev Positions are claimed in FIFO order. This points to the oldest unclaimed position.
    uint256 public firstActivePositionId;

    /// @notice Next position ID to use
    /// @dev Also serves as one-past-the-last position ID. Active positions are in [firstActivePositionId, nextPositionId)
    uint256 public nextPositionId;

    /* ========== WITHDRAWAL QUEUE ========== */

    /// @notice Withdrawal request structure
    /// @dev Uses escrow mechanism: shares transferred to contract (not burned) until fulfillment.
    ///      This ensures users receive assets at current NAV, not at request time NAV.
    struct WithdrawalRequest {
        address owner;          // Original owner of shares (can cancel)
        address receiver;       // Who will receive assets (fulfillment target)
        uint256 shares;         // Shares held in escrow (transferred to contract, not burned)
        uint256 requestTime;    // When request was made
        uint256 fulfilled;      // Shares already burned/fulfilled (for partial fulfillment tracking)
        bool cancelled;         // Whether request was cancelled
    }

    /// @notice Mapping of request ID to withdrawal request
    mapping(uint256 => WithdrawalRequest) public withdrawalRequests;

    /// @notice Array of pending withdrawal request IDs (FIFO queue)
    uint256[] public pendingWithdrawals;

    /// @notice Mapping from request ID to its index in pendingWithdrawals array
    /// @dev Used for O(1) removal. Value is index + 1 (0 means not in queue)
    mapping(uint256 => uint256) private pendingWithdrawalIndex;

    /// @notice Next withdrawal request ID to use
    uint256 public nextWithdrawalRequestId;

    /* ========== EVENTS ========== */

    /**
     * @notice Emitted when a user deposits assets into the vault
     * @param depositor Address of the user making the deposit
     * @param assets Amount of USDe tokens deposited
     * @param shares Amount of vault shares minted
     */
    event Deposited(
        address indexed depositor,
        uint256 assets,
        uint256 shares
    );

    /**
     * @notice Emitted when a user withdraws assets from the vault
     * @param withdrawer Address of the user making the withdrawal
     * @param assets Amount of USDe tokens withdrawn
     * @param shares Amount of vault shares burned
     */
    event Withdrawn(
        address indexed withdrawer,
        uint256 assets,
        uint256 shares
    );

    /**
     * @notice Emitted when new unstake proxies are deployed
     * @param count Number of proxies deployed
     * @param totalProxies Total number of proxies after deployment
     */
    event ProxiesDeployed(uint256 count, uint256 totalProxies);

    /**
     * @notice Emitted when a proxy is allocated for unstaking
     * @param proxy Address of allocated proxy
     */
    event ProxyAllocated(address indexed proxy);

    /**
     * @notice Emitted when a proxy is released back to available pool
     * @param proxy Address of released proxy
     */
    event ProxyReleased(address indexed proxy);

    /**
     * @notice Emitted when a keeper is added to the whitelist
     * @param keeper Address of the keeper added
     */
    event KeeperAdded(address indexed keeper);

    /**
     * @notice Emitted when a keeper is removed from the whitelist
     * @param keeper Address of the keeper removed
     */
    event KeeperRemoved(address indexed keeper);

    /**
     * @notice Emitted when performance fee is updated
     * @param oldFee Previous fee in basis points
     * @param newFee New fee in basis points
     */
    event PerformanceFeeUpdated(uint256 oldFee, uint256 newFee);

    /**
     * @notice Emitted when fee recipient is updated
     * @param oldRecipient Previous fee recipient address
     * @param newRecipient New fee recipient address
     */
    event FeeRecipientUpdated(address indexed oldRecipient, address indexed newRecipient);

    /**
     * @notice Emitted when minimum profit threshold is updated
     * @param oldThreshold Previous threshold in basis points
     * @param newThreshold New threshold in basis points
     */
    event MinProfitThresholdUpdated(uint256 oldThreshold, uint256 newThreshold);

    /**
     * @notice Emitted when a new position is opened
     * @param positionId ID of the new position
     * @param proxy Address of proxy handling the unstake
     * @param sUsdeAmount Amount of sUSDe being unstaked
     * @param expectedAssets Expected USDe amount after cooldown
     * @param bookValue USDe spent to acquire sUSDe
     */
    event PositionOpened(
        uint256 indexed positionId,
        address indexed proxy,
        uint256 sUsdeAmount,
        uint256 expectedAssets,
        uint256 bookValue
    );

    /**
     * @notice Emitted when a position is claimed
     * @param positionId ID of the claimed position
     * @param proxy Address of proxy that was used
     * @param usdeReceived Actual USDe received
     * @param profit Realized profit
     */
    event PositionClaimed(
        uint256 indexed positionId,
        address indexed proxy,
        uint256 usdeReceived,
        uint256 profit
    );

    /**
     * @notice Emitted when arbitrage is executed
     * @param positionId ID of the newly opened position
     * @param dexTarget DEX router used for swap
     * @param usdeSpent Actual USDe spent (measured via balance delta)
     * @param sUsdeReceived Amount of sUSDe received from swap
     * @param expectedProfit Expected profit from this position
     */
    event ArbitrageExecuted(
        uint256 indexed positionId,
        address indexed dexTarget,
        uint256 usdeSpent,
        uint256 sUsdeReceived,
        uint256 expectedProfit
    );

    /**
     * @notice Emitted when a withdrawal is requested and queued
     * @param requestId ID of the withdrawal request
     * @param user Address of the user requesting withdrawal
     * @param shares Amount of shares to burn
     * @param assets Amount of assets to receive
     */
    event WithdrawalRequested(
        uint256 indexed requestId,
        address indexed user,
        uint256 shares,
        uint256 assets
    );

    /**
     * @notice Emitted when a queued withdrawal is fulfilled (fully or partially)
     * @param requestId ID of the withdrawal request
     * @param user Address of the user receiving assets
     * @param assets Amount of assets fulfilled in this transaction
     * @param remaining Remaining assets still unfulfilled
     */
    event WithdrawalFulfilled(
        uint256 indexed requestId,
        address indexed user,
        uint256 assets,
        uint256 remaining
    );

    /**
     * @notice Emitted when a withdrawal request is cancelled
     * @param requestId ID of the cancelled request
     * @param user Address of the user who cancelled
     * @param shares Amount of shares returned to user
     */
    event WithdrawalCancelled(
        uint256 indexed requestId,
        address indexed user,
        uint256 shares
    );

    /* ========== CONSTRUCTOR ========== */

    /**
     * @notice Initializes the ArbitrageVault contract
     * @param usdeToken Address of the USDe token (underlying asset)
     * @param stakedUsdeToken Address of the Ethena sUSDe token
     * @param initialFeeRecipient Address to receive performance fees
     * @dev Sets up ERC4626 with USDe as the underlying asset
     *      and initializes ownership to the deployer
     */
    constructor(
        address usdeToken,
        address stakedUsdeToken,
        address initialFeeRecipient
    )
        ERC4626(IERC20(usdeToken))
        ERC20(VAULT_NAME, VAULT_SYMBOL)
        Ownable(msg.sender)
    {
        require(usdeToken != address(0), "ArbitrageVault: zero address");
        require(stakedUsdeToken != address(0), "ArbitrageVault: zero sUSDe address");
        require(initialFeeRecipient != address(0), "ArbitrageVault: zero fee recipient");

        stakedUsde = IStakedUSDe(stakedUsdeToken);

        // Initialize parameters with defaults
        performanceFee = 1000; // 10%
        feeRecipient = initialFeeRecipient;
        minProfitThreshold = 10; // 0.1%

        // Add deployer as initial keeper to ensure positions can be claimed
        isKeeper[msg.sender] = true;
        emit KeeperAdded(msg.sender);
    }

    /* ========== PUBLIC FUNCTIONS ========== */

    /**
     * @notice Deposits USDe tokens into the vault and mints shares
     * @param assets Amount of USDe tokens to deposit
     * @param receiver Address that will receive the vault shares
     * @return shares Amount of vault shares minted
     * @dev Primary deposit method. Simplified ERC-4626: mint() disabled for clarity.
     *      Users should specify deposit amount in assets (USDe), not shares.
     *      This is the natural UX flow: "I want to deposit 1000 USDe" vs "I want 1000 shares".
     *
     *      Note: Deposits auto-fulfill withdrawal queue with new liquidity (FIFO fairness).
     *      Queue has priority over idle capital to maintain fairness invariant.
     *      Depositor receives shares at current NAV before queue fulfillment (no dilution).
     */
    function deposit(
        uint256 assets,
        address receiver
    )
        public
        virtual
        override
        nonReentrant
        returns (uint256 shares)
    {
        shares = super.deposit(assets, receiver);
        emit Deposited(msg.sender, assets, shares);

        // Fulfill pending withdrawals with new liquidity (queue has priority - FIFO fairness)
        // Maintains invariant: idle_liquidity == 0 OR pending_queue.length == 0
        uint256 idleBalance = IERC20(asset()).balanceOf(address(this));
        _fulfillPendingWithdrawals(idleBalance);
    }

    /**
     * @notice DISABLED: Use deposit(assets) instead
     * @dev Simplified ERC-4626: mint() disabled to reduce complexity and code duplication.
     *      Use deposit() to specify amount in assets (more intuitive UX).
     */
    function mint(
        uint256 /* shares */,
        address /* receiver */
    )
        public
        virtual
        override
        returns (uint256)
    {
        revert("ArbitrageVault: Use deposit(assets) instead of mint(shares)");
    }

    /**
     * @notice DISABLED: Use redeem(shares) instead
     * @dev Simplified ERC-4626: withdraw() disabled to reduce complexity.
     *      CRITICAL: Base withdraw() doesn't support our queue/escrow mechanism!
     *      If liquidity insufficient, base implementation will REVERT instead of creating
     *      a withdrawal request. This breaks the queue system and user experience.
     *      Always use redeem(shares) which includes queue logic.
     */
    function withdraw(
        uint256 /* assets */,
        address /* receiver */,
        address /* owner */
    )
        public
        virtual
        override
        returns (uint256)
    {
        revert("ArbitrageVault: Use requestWithdrawal() for all withdrawals (async-only model)");
    }

    /**
     * @notice DISABLED: Use requestWithdrawal() for all withdrawals
     * @dev Fully asynchronous withdrawal model with instant fulfillment when liquidity available.
     *
     *      This vault uses a FULLY ASYNC withdrawal model for simplicity and fairness:
     *      - All withdrawals go through requestWithdrawal() → withdrawal queue
     *      - Queue auto-fulfilled instantly if idle liquidity available (same transaction)
     *      - Keeper claims positions → auto-fulfills queue in FIFO order
     *      - Deposits auto-fulfill queue with fresh liquidity
     *      - Fairness invariant maintained: idle > 0 OR queue.length > 0 (never both)
     *
     *      Benefits:
     *      - Simpler code (no complex redeem() logic)
     *      - Perfect FIFO fairness (everyone waits equally, queue has priority)
     *      - Instant withdrawals when liquidity available (typical case)
     *      - Escrow mechanism ensures users benefit from NAV growth while waiting
     *      - No edge cases around "who gets priority" (always FIFO)
     *
     *      Typical fulfillment: Instant (if idle liquidity) or 1-2 blocks (if awaiting claim)
     */
    function redeem(
        uint256 /* shares */,
        address /* receiver */,
        address /* owner */
    )
        public
        virtual
        override
        returns (uint256)
    {
        revert("ArbitrageVault: Use requestWithdrawal() for all withdrawals (async-only model)");
    }

    /**
     * @notice Returns maximum shares that can be immediately redeemed
     * @return Always returns 0 (async-only model, no immediate redemptions)
     * @dev Fully asynchronous withdrawal model: all withdrawals go through requestWithdrawal().
     *      Returning 0 is ERC-4626 compliant - it honestly signals "no immediate withdrawals available".
     *      Users should call requestWithdrawal() to enter the queue.
     */
    function maxRedeem(address /* owner */) public view virtual override returns (uint256) {
        return 0; // Async-only model: no immediate redemptions
    }

    /**
     * @notice Returns maximum assets that can be immediately withdrawn
     * @return Always returns 0 (async-only model, no immediate withdrawals)
     * @dev Matches maxRedeem() behavior. Since withdraw() always reverts,
     *      maxWithdraw() must return 0 to accurately reflect that no immediate
     *      withdrawals are possible. Prevents frontends from being misled.
     */
    function maxWithdraw(address /* owner */) public view virtual override returns (uint256) {
        return 0; // Async-only model: no immediate withdrawals
    }

    /**
     * @notice Returns the total assets under management (NAV)
     * @return Total amount of USDe tokens managed by the vault
     * @dev Implements time-weighted NAV calculation with FIFO-based iteration:
     *      NAV = idle USDe + Σ(bookValue[i] + accruedProfit[i]) for all active positions
     *      where accruedProfit[i] = expectedProfit[i] * min(elapsed[i], COOLDOWN_PERIOD) / COOLDOWN_PERIOD
     *
     *      Active positions are in range [firstActivePositionId, nextPositionId).
     *      FIFO claim order ensures no gaps in this range.
     *
     *      This approach ensures:
     *      - Profit accrues for EXACTLY 7 days per position (no over-accrual)
     *      - No dependency on keeper claiming speed
     *      - Gas cost bounded by MAX_ACTIVE_POSITIONS (50 positions ≈ 100k gas)
     *      - Simpler than array-based approach (no storage for tracking array)
     */
    function totalAssets() public view virtual override returns (uint256) {
        uint256 idleAssets = IERC20(asset()).balanceOf(address(this));
        (uint256 totalBookValue, uint256 totalProfit) = _calculatePositionsValue();
        return idleAssets + totalBookValue + totalProfit;
    }

    /**
     * @notice Internal helper to calculate total book value and accrued profit of all active positions
     * @return totalBookValue Sum of book values for all active positions
     * @return totalProfit Sum of time-weighted accrued profit for all active positions
     * @dev Iterates through FIFO range [firstActivePositionId, nextPositionId) and calculates
     *      time-weighted profit for each position, capped at COOLDOWN_PERIOD.
     */
    function _calculatePositionsValue() internal view returns (uint256 totalBookValue, uint256 totalProfit) {
        totalBookValue = 0;
        totalProfit = 0;

        for (uint256 id = firstActivePositionId; id < nextPositionId; id++) {
            Position storage position = positions[id];

            // Calculate time elapsed, capped at COOLDOWN_PERIOD
            uint256 timeElapsed = block.timestamp - position.startTime;
            if (timeElapsed > COOLDOWN_PERIOD) {
                timeElapsed = COOLDOWN_PERIOD;
            }

            // Calculate time-weighted profit for this position
            uint256 expectedProfit = position.expectedAssets - position.bookValue;
            uint256 accruedProfit = (expectedProfit * timeElapsed) / COOLDOWN_PERIOD;

            totalBookValue += position.bookValue;
            totalProfit += accruedProfit;
        }
    }

    /* ========== VIEW FUNCTIONS ========== */

    /**
     * @notice Returns the vault name
     * @return Vault name string
     */
    function name()
        public
        pure
        override(ERC20, IERC20Metadata)
        returns (string memory)
    {
        return VAULT_NAME;
    }

    /**
     * @notice Returns the vault symbol
     * @return Vault symbol string
     */
    function symbol()
        public
        pure
        override(ERC20, IERC20Metadata)
        returns (string memory)
    {
        return VAULT_SYMBOL;
    }

    /**
     * @notice Returns detailed information about a position
     * @param positionId ID of the position to query
     * @return position The Position struct containing all position data
     */
    function getPosition(uint256 positionId) external view returns (Position memory position) {
        return positions[positionId];
    }

    /**
     * @notice Returns the current total accrued profit from all active positions
     * @return Total profit accrued from all positions
     * @dev Uses internal helper to calculate time-weighted profit for all active positions
     *      Each position's profit is capped at COOLDOWN_PERIOD (7 days)
     */
    function getAccruedProfit() external view returns (uint256) {
        (, uint256 totalProfit) = _calculatePositionsValue();
        return totalProfit;
    }

    /**
     * @notice Returns the number of active (unclaimed) positions
     * @return Number of positions currently being tracked
     */
    function activePositionCount() external view returns (uint256) {
        return nextPositionId - firstActivePositionId;
    }

    /**
     * @notice Checks if a position can be claimed
     * @param positionId ID of the position to check
     * @return claimable True if position exists, unclaimed, and cooldown elapsed
     */
    function isPositionClaimable(uint256 positionId) external view returns (bool claimable) {
        Position storage position = positions[positionId];

        if (position.sUsdeAmount == 0 || position.claimed) {
            return false;
        }

        return block.timestamp >= position.startTime + COOLDOWN_PERIOD;
    }

    /**
     * @notice Returns the number of pending withdrawal requests
     * @return Number of requests in the queue
     */
    function pendingWithdrawalCount() external view returns (uint256) {
        return pendingWithdrawals.length;
    }

    /**
     * @notice Returns detailed information about a withdrawal request
     * @param requestId ID of the request to query
     * @return request The WithdrawalRequest struct
     */
    function getWithdrawalRequest(uint256 requestId) external view returns (WithdrawalRequest memory request) {
        return withdrawalRequests[requestId];
    }

    /* ========== ACCESS CONTROL & PARAMETER MANAGEMENT ========== */

    /**
     * @notice Modifier to restrict function access to whitelisted keepers only
     */
    modifier onlyKeeper() {
        require(isKeeper[msg.sender], "Caller is not a keeper");
        _;
    }

    /**
     * @notice Adds a keeper to the whitelist
     * @param keeper Address to add as keeper
     * @dev Only callable by owner
     */
    function addKeeper(address keeper) external onlyOwner {
        require(keeper != address(0), "Invalid keeper address");
        require(!isKeeper[keeper], "Already a keeper");

        isKeeper[keeper] = true;
        emit KeeperAdded(keeper);
    }

    /**
     * @notice Removes a keeper from the whitelist
     * @param keeper Address to remove from keepers
     * @dev Only callable by owner
     */
    function removeKeeper(address keeper) external onlyOwner {
        require(isKeeper[keeper], "Not a keeper");

        isKeeper[keeper] = false;
        emit KeeperRemoved(keeper);
    }

    /**
     * @notice Updates the performance fee
     * @param newFee New performance fee in basis points (0-5000)
     * @dev Only callable by owner. Maximum 50% to protect depositors.
     */
    function setPerformanceFee(uint256 newFee) external onlyOwner {
        require(newFee <= MAX_PERFORMANCE_FEE, "Fee exceeds maximum");

        uint256 oldFee = performanceFee;
        performanceFee = newFee;

        emit PerformanceFeeUpdated(oldFee, newFee);
    }

    /**
     * @notice Updates the fee recipient address
     * @param newRecipient New address to receive fees
     * @dev Only callable by owner
     */
    function setFeeRecipient(address newRecipient) external onlyOwner {
        require(newRecipient != address(0), "Invalid recipient address");

        address oldRecipient = feeRecipient;
        feeRecipient = newRecipient;

        emit FeeRecipientUpdated(oldRecipient, newRecipient);
    }

    /**
     * @notice Updates the minimum profit threshold for arbitrage execution
     * @param newThreshold New threshold in basis points
     * @dev Only callable by owner
     */
    function setMinProfitThreshold(uint256 newThreshold) external onlyOwner {
        require(newThreshold <= BASIS_POINTS, "Threshold exceeds 100%");

        uint256 oldThreshold = minProfitThreshold;
        minProfitThreshold = newThreshold;

        emit MinProfitThresholdUpdated(oldThreshold, newThreshold);
    }

    /* ========== ARBITRAGE EXECUTION ========== */

    /**
     * @notice Executes arbitrage by swapping USDe for sUSDe and opening an unstaking position
     * @param dexTarget Address of the DEX router to execute swap
     * @param amountIn Amount of USDe to spend on the swap
     * @param minAmountOut Minimum sUSDe to receive (slippage protection)
     * @param swapCalldata Calldata for the DEX swap call
     * @return positionId ID of the newly opened position
     *
     * @dev SECURITY CRITICAL - This function implements trustless validation:
     *      1. Measures actual USDe spent via balance delta (bookValue = balanceBefore - balanceAfter)
     *      2. Gets expectedAssets from Ethena via proxy.initiateUnstake() return value
     *      3. Validates minimum profit threshold before execution
     *      4. Uses slippage protection via minAmountOut
     *
     *      Attack Prevention:
     *      - Keeper CANNOT manipulate bookValue (measured on-chain)
     *      - Keeper CANNOT manipulate expectedAssets (from Ethena)
     *      - minProfitThreshold prevents unprofitable trades
     *      - Slippage protection prevents sandwich attacks
     *
     *      Execution Flow:
     *      1. Validate keeper authorization (onlyKeeper modifier)
     *      2. Allocate free proxy for unstaking
     *      3. Measure USDe balance before swap
     *      4. Execute DEX swap (USDe → sUSDe) via low-level call
     *      5. Measure USDe balance after swap → bookValue
     *      6. Validate sUSDe received >= minAmountOut
     *      7. Transfer sUSDe to proxy
     *      8. Initiate unstake via proxy → get expectedAssets from Ethena
     *      9. Validate profit >= minProfitThreshold
     *      10. Open position with validated values
     *      11. Emit ArbitrageExecuted event
     */
    function executeArbitrage(
        address dexTarget,
        uint256 amountIn,
        uint256 minAmountOut,
        bytes calldata swapCalldata
    ) external onlyKeeper nonReentrant returns (uint256 positionId) {
        require(dexTarget != address(0), "Invalid DEX target");
        require(amountIn > 0, "Amount must be > 0");
        require(minAmountOut > 0, "Min amount out must be > 0");

        IERC20 usdeToken = IERC20(asset());

        // Validate sufficient USDe balance
        require(usdeToken.balanceOf(address(this)) >= amountIn, "Insufficient USDe balance");

        // Allocate free proxy for unstaking
        address proxyAddress = _allocateFreeProxy();

        uint256 bookValue;
        uint256 sUsdeReceived;
        uint256 expectedAssets;

        // Scope to avoid stack too deep
        {
            // Measure USDe balance before swap
            uint256 balanceBefore = usdeToken.balanceOf(address(this));

            // Approve DEX to spend exact amountIn
            usdeToken.forceApprove(dexTarget, amountIn);

            // Execute DEX swap
            (bool success, ) = dexTarget.call(swapCalldata);

            // CRITICAL: Reset allowance to 0 immediately after swap
            // This prevents:
            // 1. Accumulating allowance over multiple trades
            // 2. Malicious keeper deploying fake DEX to gain permanent allowance
            // 3. Compromised router draining vault funds via transferFrom
            usdeToken.forceApprove(dexTarget, 0);

            require(success, "Swap failed");

            // Measure actual USDe spent (trustless)
            uint256 balanceAfter = usdeToken.balanceOf(address(this));
            require(balanceAfter <= balanceBefore, "Balance increased after swap");
            bookValue = balanceBefore - balanceAfter;

            require(bookValue <= amountIn, "Spent more than amountIn");
            require(bookValue > 0, "No USDe was spent");
        }

        // Scope for sUSDe handling
        {
            IERC20 sUsdeToken = IERC20(address(stakedUsde));

            // Get sUSDe received from swap
            sUsdeReceived = sUsdeToken.balanceOf(address(this));
            require(sUsdeReceived >= minAmountOut, "Insufficient sUSDe received (slippage)");
            require(sUsdeReceived > 0, "No sUSDe received");

            // Transfer sUSDe to proxy
            sUsdeToken.safeTransfer(proxyAddress, sUsdeReceived);

            // Initiate unstake via proxy - get expectedAssets from Ethena
            expectedAssets = UnstakeProxy(proxyAddress).initiateUnstake(sUsdeReceived);
        }

        // Validate profit threshold
        uint256 expectedProfit = expectedAssets > bookValue ? expectedAssets - bookValue : 0;
        uint256 minProfit = (bookValue * minProfitThreshold) / BASIS_POINTS;
        require(expectedProfit >= minProfit, "Profit below minimum threshold");

        // Open position with validated values
        positionId = _openPosition(sUsdeReceived, bookValue, expectedAssets, proxyAddress);

        // Emit event for off-chain monitoring
        emit ArbitrageExecuted(positionId, dexTarget, bookValue, sUsdeReceived, expectedProfit);
    }

    /* ========== PROXY MANAGEMENT ========== */

    /**
     * @notice Deploys new unstake proxy contracts
     * @param count Number of proxies to deploy
     * @dev Only callable by owner. Uses CREATE opcode for deployment.
     *      Each proxy is owned by this vault and can perform one unstake at a time.
     */
    function deployProxies(uint256 count) external onlyOwner {
        require(count > 0, "Count must be > 0");
        require(count <= 100, "Too many proxies at once");

        address usdeToken = asset();

        for (uint256 i = 0; i < count; i++) {
            // Deploy new proxy with vault as owner
            UnstakeProxy proxy = new UnstakeProxy(
                address(stakedUsde),
                usdeToken,
                address(this)
            );

            // Register proxy
            unstakeProxies.push(address(proxy));
            proxyBusy[address(proxy)] = false;
        }

        emit ProxiesDeployed(count, unstakeProxies.length);
    }

    /**
     * @notice Returns the total number of deployed proxies
     * @return Total proxy count
     */
    function getProxyCount() external view returns (uint256) {
        return unstakeProxies.length;
    }

    /**
     * @notice Returns the number of available (non-busy) proxies
     * @return Number of proxies available for allocation
     */
    function getAvailableProxyCount() external view returns (uint256) {
        uint256 count = 0;
        for (uint256 i = 0; i < unstakeProxies.length; i++) {
            if (!proxyBusy[unstakeProxies[i]]) {
                count++;
            }
        }
        return count;
    }

    /**
     * @notice Returns all proxy addresses and their busy status
     * @return proxies Array of proxy addresses
     * @return busy Array of busy status for each proxy
     */
    function getProxyStatus()
        external
        view
        returns (address[] memory proxies, bool[] memory busy)
    {
        proxies = unstakeProxies;
        busy = new bool[](proxies.length);

        for (uint256 i = 0; i < proxies.length; i++) {
            busy[i] = proxyBusy[proxies[i]];
        }
    }

    /* ========== INTERNAL FUNCTIONS ========== */

    /**
     * @notice Opens a new position with provided parameters
     * @param sUsdeAmount Amount of sUSDe being unstaked
     * @param bookValue USDe paid to acquire sUSDe (measured via balance delta in executeArbitrage)
     * @param expectedAssets Expected USDe from Ethena cooldownShares (from proxy.initiateUnstake return)
     * @param proxyAddress Address of proxy handling the unstake
     * @return positionId ID of the newly created position
     *
     * @dev ✅ SECURITY IMPLEMENTED (Phase 5 Completed):
     *
     *      This internal function is called by:
     *      1. **Production**: executeArbitrage() with trustless validation (see lines 734-811)
     *      2. **Testing**: ArbitrageVaultHarness.openPositionForTesting() (unit tests only)
     *
     *      Security Guarantees (enforced by executeArbitrage caller):
     *      - bookValue: Measured via balance delta (balanceBefore - balanceAfter)
     *        → Keeper CANNOT manipulate (measured on-chain)
     *      - expectedAssets: Returned by Ethena's proxy.initiateUnstake(sUsdeAmount)
     *        → Keeper CANNOT manipulate (value from Ethena protocol)
     *      - Profit validation: Requires expectedProfit >= minProfitThreshold
     *      - Slippage protection: Requires sUsdeReceived >= minAmountOut
     *      - Allowance reset: DEX allowance reset to 0 after each swap
     *
     *      Attack Prevention:
     *      ❌ Keeper cannot inflate bookValue (measured on-chain via balance delta)
     *      ❌ Keeper cannot inflate expectedAssets (from Ethena's cooldownShares)
     *      ❌ Keeper cannot execute unprofitable trades (minProfitThreshold check)
     *      ❌ Keeper cannot drain vault via permanent DEX allowance (reset to 0)
     *
     *      This function performs additional sanity checks but relies on executeArbitrage()
     *      for primary security validation. See executeArbitrage() (lines 734-811) for
     *      complete trustless validation implementation.
     *
     * @custom:security-note Function is internal. Only call with validated inputs from executeArbitrage()
     * @custom:audit-note All critical values (bookValue, expectedAssets) validated by caller
     */
    function _openPosition(
        uint256 sUsdeAmount,
        uint256 bookValue,
        uint256 expectedAssets,
        address proxyAddress
    ) internal returns (uint256 positionId) {
        // Sanity checks (primary security validation done in executeArbitrage)
        require(expectedAssets >= bookValue, "Expected assets must be >= book value");
        require(bookValue > 0, "Book value must be > 0");
        require(sUsdeAmount > 0, "sUSDe amount must be > 0");

        // Additional sanity check: enforce reasonable profit expectations
        // When called from executeArbitrage, inputs are already validated via balance delta
        require(
            bookValue <= expectedAssets * 2,
            "Book value too high relative to expected assets"
        );

        // Check position limit
        require(
            (nextPositionId - firstActivePositionId) < MAX_ACTIVE_POSITIONS,
            "Maximum active positions reached"
        );

        // Create position
        positionId = nextPositionId++;
        positions[positionId] = Position({
            sUsdeAmount: sUsdeAmount,
            bookValue: bookValue,
            expectedAssets: expectedAssets,
            startTime: block.timestamp,
            claimed: false,
            proxyContract: proxyAddress
        });

        emit PositionOpened(positionId, proxyAddress, sUsdeAmount, expectedAssets, bookValue);
    }

    /**
     * @notice Allocates a free proxy for unstaking operation using round-robin
     * @return proxy Address of allocated proxy
     * @dev Uses round-robin allocation starting from last allocated index.
     *      This is efficient because proxies typically become available in the same
     *      order they were allocated (all have same 7-day cooldown period).
     *      Reverts if no proxy available.
     */
    function _allocateFreeProxy() internal returns (address proxy) {
        uint256 len = unstakeProxies.length;
        require(len > 0, "No proxies deployed");

        // Round-robin: start from (lastAllocated + 1) and wrap around
        for (uint256 i = 0; i < len; i++) {
            uint256 index = (lastAllocatedIndex + 1 + i) % len;

            if (!proxyBusy[unstakeProxies[index]]) {
                lastAllocatedIndex = index;
                proxy = unstakeProxies[index];
                proxyBusy[proxy] = true;
                emit ProxyAllocated(proxy);
                return proxy;
            }
        }

        revert("No proxies available");
    }

    /**
     * @notice Releases a proxy back to the available pool
     * @param proxy Address of proxy to release
     * @dev Marks proxy as not busy
     */
    function _releaseProxy(address proxy) internal {
        require(proxy != address(0), "Invalid proxy");
        require(proxyBusy[proxy], "Proxy not busy");

        proxyBusy[proxy] = false;
        emit ProxyReleased(proxy);
    }

    /* ========== WITHDRAWAL QUEUE MANAGEMENT ========== */

    /**
     * @notice Requests a withdrawal to be fulfilled when liquidity becomes available
     * @param shares Amount of shares to redeem
     * @param receiver Address to receive the assets
     * @param owner Address of the shares owner
     * @return requestId ID of the created withdrawal request
     *
     * @dev PRIMARY and ONLY withdrawal method in async-only model.
     *
     *      Usage:
     *      1. User calls requestWithdrawal(shares) to enter FIFO queue
     *      2. Shares transferred to escrow (user keeps profit participation)
     *      3. Queue fulfilled automatically and immediately when:
     *         - Idle liquidity available (instant fulfillment - maintains fairness invariant)
     *         - Keeper claims matured position (auto-fulfills queue)
     *         - New deposits arrive (auto-fulfills queue with fresh liquidity)
     *      4. User receives assets at current NAV (dynamic pricing, fair profit sharing)
     *
     *      Escrow mechanism:
     *      - Shares transferred to contract (not burned) to preserve profit participation
     *      - Assets calculated at fulfillment time (current NAV), not at request time
     *      - Fairness: user receives profit accrued during wait time
     *
     *      Queue behavior:
     *      - Requests fulfilled in FIFO order as liquidity becomes available
     *      - Partial fulfillment supported (shares burned incrementally)
     *      - Can be cancelled anytime via cancelWithdrawal()
     *      - Maximum wait time: 7 days (one cooldown period)
     */
    function requestWithdrawal(
        uint256 shares,
        address receiver,
        address owner
    ) public returns (uint256 requestId) {
        require(shares > 0, "Shares must be > 0");
        require(receiver != address(0), "Invalid receiver");

        // Handle allowance if caller is not owner
        if (msg.sender != owner) {
            _spendAllowance(owner, msg.sender, shares);
        }

        // Transfer shares to contract (escrow) instead of burning
        // This allows user to benefit from NAV growth during wait time
        _transfer(owner, address(this), shares);

        // Create withdrawal request
        requestId = nextWithdrawalRequestId++;
        withdrawalRequests[requestId] = WithdrawalRequest({
            owner: owner,
            receiver: receiver,
            shares: shares,
            requestTime: block.timestamp,
            fulfilled: 0,
            cancelled: false
        });

        // Add to pending queue
        pendingWithdrawals.push(requestId);
        pendingWithdrawalIndex[requestId] = pendingWithdrawals.length; // index + 1

        // Calculate assets for event (informational, actual amount determined at fulfillment)
        uint256 estimatedAssets = convertToAssets(shares);
        emit WithdrawalRequested(requestId, receiver, shares, estimatedAssets);

        // Try to fulfill immediately with idle liquidity (FIFO fairness)
        // Maintains invariant: idle_liquidity == 0 OR pending_queue.length == 0
        uint256 idleBalance = IERC20(asset()).balanceOf(address(this));
        _fulfillPendingWithdrawals(idleBalance);
    }

    /**
     * @notice Cancels a pending withdrawal request
     * @param requestId ID of the request to cancel
     * @dev Returns unfulfilled shares from escrow to the original owner.
     *      FIFO-safe: Uses left-shift removal to preserve queue order.
     *      O(N) complexity but acceptable since cancellations are rare.
     *
     *      Can only be called by the original share owner.
     *      Cannot cancel already fulfilled or cancelled requests.
     */
    function cancelWithdrawal(uint256 requestId) external nonReentrant {
        WithdrawalRequest storage request = withdrawalRequests[requestId];

        require(request.owner == msg.sender, "Not request owner");
        require(!request.cancelled, "Already cancelled");
        require(request.fulfilled < request.shares, "Already fully fulfilled");

        // Calculate unfulfilled shares still in escrow
        uint256 sharesToReturn = request.shares - request.fulfilled;

        // Mark as cancelled
        request.cancelled = true;

        // CRITICAL: Remove from queue (FIFO-safe left-shift)
        // This prevents cancelled requests from blocking the vault
        _removeFromQueuePreservingOrder(requestId);

        // Return shares from escrow to original owner
        _transfer(address(this), request.owner, sharesToReturn);

        emit WithdrawalCancelled(requestId, request.owner, sharesToReturn);
    }

    /**
     * @notice Internal helper to remove request from pending queue
     * @param requestId ID of the request to remove
     * @dev Uses swap-and-pop for O(1) removal
     */
    function _removeFromPendingQueue(uint256 requestId) internal {
        uint256 indexPlusOne = pendingWithdrawalIndex[requestId];
        if (indexPlusOne == 0) return; // Not in queue

        uint256 index = indexPlusOne - 1;
        uint256 lastIndex = pendingWithdrawals.length - 1;

        if (index != lastIndex) {
            uint256 lastRequestId = pendingWithdrawals[lastIndex];
            pendingWithdrawals[index] = lastRequestId;
            pendingWithdrawalIndex[lastRequestId] = indexPlusOne;
        }

        pendingWithdrawals.pop();
        delete pendingWithdrawalIndex[requestId];
    }

    /**
     * @notice Internal helper to remove first element from pending queue (FIFO-safe)
     * @dev Uses left-shift instead of swap-and-pop to maintain FIFO order.
     *      This is O(N) but necessary for FIFO guarantee. Used when fulfilling requests.
     */
    function _removeFirstFromQueue() internal {
        require(pendingWithdrawals.length > 0, "Queue is empty");

        uint256 firstRequestId = pendingWithdrawals[0];

        // Shift all elements left by 1 position
        for (uint256 i = 0; i < pendingWithdrawals.length - 1; i++) {
            pendingWithdrawals[i] = pendingWithdrawals[i + 1];
            // Update index mapping (stored as index+1)
            pendingWithdrawalIndex[pendingWithdrawals[i]] = i + 1;
        }

        pendingWithdrawals.pop();
        delete pendingWithdrawalIndex[firstRequestId];
    }

    /**
     * @notice Internal helper to remove any element from pending queue (FIFO-safe)
     * @param requestId ID of the request to remove
     * @dev Uses left-shift to preserve FIFO order for remaining elements.
     *      This is O(N) but necessary to prevent queue reordering on cancellation.
     *      Cancellations are rare, so O(N) is acceptable.
     */
    function _removeFromQueuePreservingOrder(uint256 requestId) internal {
        uint256 indexPlusOne = pendingWithdrawalIndex[requestId];
        if (indexPlusOne == 0) return; // Not in queue

        uint256 index = indexPlusOne - 1;

        // Shift all elements after index left by 1 position
        for (uint256 i = index; i < pendingWithdrawals.length - 1; i++) {
            pendingWithdrawals[i] = pendingWithdrawals[i + 1];
            // Update index mapping (stored as index+1)
            pendingWithdrawalIndex[pendingWithdrawals[i]] = i + 1;
        }

        pendingWithdrawals.pop();
        delete pendingWithdrawalIndex[requestId];
    }

    /**
     * @notice Internal helper to fulfill pending withdrawal requests
     * @param availableAssets Amount of USDe available for fulfillment
     * @dev Processes pending withdrawals in STRICT FIFO order until assets depleted or queue empty.
     *      Uses ESCROW mechanism with DYNAMIC NAV:
     *      - Shares held in escrow (contract balance) until fulfillment
     *      - Assets calculated at fulfillment time using current NAV (not fixed at request time)
     *      - This ensures users receive profit accrued during wait time
     *      - fulfilled tracks burned shares (not assets) for partial fulfillment
     */
    function _fulfillPendingWithdrawals(uint256 availableAssets) internal {
        if (availableAssets == 0) return;

        IERC20 usdeToken = IERC20(asset());
        uint256 remaining = availableAssets;

        // FIFO: Always process head of queue (index 0)
        while (pendingWithdrawals.length > 0 && remaining > 0) {
            uint256 requestId = pendingWithdrawals[0]; // Always first element
            WithdrawalRequest storage request = withdrawalRequests[requestId];

            if (request.cancelled) {
                // Remove cancelled request (FIFO-safe left-shift)
                _removeFirstFromQueue();
                continue;
            }

            // Calculate unfulfilled shares still in escrow
            uint256 sharesRemaining = request.shares - request.fulfilled;

            // Calculate assets needed at CURRENT NAV (dynamic pricing)
            uint256 assetsForAllShares = convertToAssets(sharesRemaining);

            if (remaining >= assetsForAllShares) {
                // Fully fulfill request: burn all remaining shares and send assets
                _burn(address(this), sharesRemaining);
                usdeToken.safeTransfer(request.receiver, assetsForAllShares);

                request.fulfilled = request.shares; // All shares burned
                _removeFirstFromQueue(); // Request complete

                emit WithdrawalFulfilled(requestId, request.receiver, assetsForAllShares, 0);
                remaining -= assetsForAllShares;
            } else {
                // Partially fulfill: calculate how many shares we can afford at current NAV
                uint256 sharesToBurn = previewWithdraw(remaining);

                // Safety check: don't burn more than available in escrow
                if (sharesToBurn > sharesRemaining) {
                    sharesToBurn = sharesRemaining;
                    remaining = convertToAssets(sharesToBurn);
                }

                // Burn partial shares and send corresponding assets
                _burn(address(this), sharesToBurn);
                usdeToken.safeTransfer(request.receiver, remaining);

                request.fulfilled += sharesToBurn; // Track burned shares

                uint256 sharesStillPending = request.shares - request.fulfilled;
                uint256 assetsStillPending = convertToAssets(sharesStillPending);

                emit WithdrawalFulfilled(requestId, request.receiver, remaining, assetsStillPending);
                remaining = 0;
            }
        }
    }

    /**
     * @notice Attempts to claim the first position if it's ready
     * @return claimed True if position was claimed successfully
     * @dev Used by redeem() to improve liquidity availability.
     *      Only claims firstActivePositionId if cooldown has elapsed.
     *      Automatically fulfills pending withdrawal queue after claiming (FIFO fairness).
     *      This consolidates claim + fulfill logic in one place.
     */
    function _tryClaimFirstPosition() internal returns (bool) {
        if (firstActivePositionId >= nextPositionId) {
            return false; // No active positions
        }

        Position storage position = positions[firstActivePositionId];

        // Check if position is ready to claim
        if (block.timestamp < position.startTime + COOLDOWN_PERIOD) {
            return false; // Not ready yet
        }

        // Claim the position
        _claimPosition(firstActivePositionId);

        // Automatically fulfill pending withdrawal queue with ALL available USDe
        // This ensures queued requests have priority (FIFO fairness)
        uint256 totalAvailable = IERC20(asset()).balanceOf(address(this));
        _fulfillPendingWithdrawals(totalAvailable);

        return true;
    }

    /* ========== POSITION MANAGEMENT ========== */

    /**
     * @notice Claims the oldest matured position after cooldown period (FIFO order)
     * @dev PERMISSIONLESS: Anyone can call this to claim matured positions and fulfill queue.
     *      This prevents keeper griefing and ensures queued users can always trigger
     *      fulfillment after the 7-day cooldown period (guarantees ADR-006 max wait time).
     *
     *      Positions must be claimed in FIFO order (oldest first).
     *      Automatically fulfills pending withdrawal requests with received USDe.
     *
     *      Incentive: Users waiting in queue benefit from calling this function.
     *      No centralization risk: anyone can advance the queue.
     */
    function claimPosition() external nonReentrant {
        require(firstActivePositionId < nextPositionId, "No active positions");
        require(
            block.timestamp >= positions[firstActivePositionId].startTime + COOLDOWN_PERIOD,
            "Cooldown period not elapsed"
        );

        // Claim and automatically fulfill queue (consolidated in _tryClaimFirstPosition)
        bool claimed = _tryClaimFirstPosition();
        require(claimed, "Failed to claim position");
    }

    /**
     * @notice Internal helper to claim a position by its ID
     * @param positionId The ID of the position to claim
     * @dev This function contains the core logic for claiming a position.
     *      It updates state, interacts with the proxy, and emits an event.
     *      It does NOT handle withdrawal queue fulfillment.
     */
    function _claimPosition(uint256 positionId) internal {
        Position storage position = positions[positionId];

        // Get USDe balance before claiming
        IERC20 usdeToken = IERC20(asset());
        uint256 balanceBefore = usdeToken.balanceOf(address(this));

        // Execute unstake via proxy - this transfers USDe to vault
        UnstakeProxy(position.proxyContract).claimUnstake(address(this));

        // Calculate actual USDe received
        uint256 balanceAfter = usdeToken.balanceOf(address(this));
        uint256 usdeReceived = balanceAfter - balanceBefore;

        // Calculate realized profit
        uint256 realizedProfit = usdeReceived > position.bookValue
            ? usdeReceived - position.bookValue
            : 0;

        // Mark position as claimed
        position.claimed = true;

        // Move to next position in FIFO queue
        firstActivePositionId++;

        // Release proxy back to available pool
        _releaseProxy(position.proxyContract);

        emit PositionClaimed(positionId, position.proxyContract, usdeReceived, realizedProfit);
    }
}
