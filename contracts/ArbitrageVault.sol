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
     * @dev Overrides ERC4626.deposit to add custom event emission
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
    }

    /**
     * @notice Mints vault shares by depositing USDe tokens
     * @param shares Amount of vault shares to mint
     * @param receiver Address that will receive the vault shares
     * @return assets Amount of USDe tokens deposited
     * @dev Overrides ERC4626.mint to add custom event emission
     */
    function mint(
        uint256 shares,
        address receiver
    )
        public
        virtual
        override
        nonReentrant
        returns (uint256 assets)
    {
        assets = super.mint(shares, receiver);
        emit Deposited(msg.sender, assets, shares);
    }

    /**
     * @notice Withdraws USDe tokens from the vault by burning shares
     * @param assets Amount of USDe tokens to withdraw
     * @param receiver Address that will receive the USDe tokens
     * @param owner Address that owns the shares being burned
     * @return shares Amount of vault shares burned
     * @dev Overrides ERC4626.withdraw to add custom event emission
     */
    function withdraw(
        uint256 assets,
        address receiver,
        address owner
    )
        public
        virtual
        override
        nonReentrant
        returns (uint256 shares)
    {
        shares = super.withdraw(assets, receiver, owner);
        emit Withdrawn(msg.sender, assets, shares);
    }

    /**
     * @notice Redeems vault shares for USDe tokens
     * @param shares Amount of vault shares to redeem
     * @param receiver Address that will receive the USDe tokens
     * @param owner Address that owns the shares being redeemed
     * @return assets Amount of USDe tokens withdrawn
     * @dev Overrides ERC4626.redeem to add custom event emission
     */
    function redeem(
        uint256 shares,
        address receiver,
        address owner
    )
        public
        virtual
        override
        nonReentrant
        returns (uint256 assets)
    {
        assets = super.redeem(shares, receiver, owner);
        emit Withdrawn(msg.sender, assets, shares);
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
     * @param bookValue USDe paid to acquire sUSDe
     * @param expectedAssets Expected USDe from Ethena cooldownShares
     * @param proxyAddress Address of proxy handling the unstake
     * @return positionId ID of the newly created position
     *
     * @dev ⚠️ SECURITY CRITICAL - PHASE 4 LIMITATION:
     *
     *      This function currently TRUSTS the caller to provide accurate bookValue and expectedAssets.
     *      There is NO on-chain verification that these values match actual USDe spent or Ethena's
     *      return value. This creates a CRITICAL VULNERABILITY:
     *
     *      Attack Scenario:
     *      1. Malicious keeper calls executeArbitrage with fake bookValue (e.g., 1M USDe)
     *      2. No USDe actually leaves vault (idle balance unchanged)
     *      3. totalAssets() += bookValue (NAV inflated by 1M USDe)
     *      4. Attacker deposits small amount, gets huge shares at inflated NAV
     *      5. Attacker withdraws, stealing real USDe from other depositors
     *
     *      MITIGATION FOR PHASE 4 (Testing):
     *      - Function is internal (not directly callable)
     *      - Only test harness has access (controlled environment)
     *      - Production code (executeArbitrage) not yet implemented
     *
     *      REQUIRED FOR PHASE 5 (Production):
     *      executeArbitrage() MUST derive these values trustlessly:
     *
     *      ```solidity
     *      function executeArbitrage(...) external onlyKeeper {
     *          uint256 balanceBefore = IERC20(asset()).balanceOf(address(this));
     *
     *          // Execute DEX swap (USDe -> sUSDe)
     *          (bool success, ) = dexRouter.call(swapCalldata);
     *          require(success, "Swap failed");
     *
     *          uint256 balanceAfter = IERC20(asset()).balanceOf(address(this));
     *          uint256 bookValue = balanceBefore - balanceAfter; // ✅ Measured on-chain
     *
     *          // Get sUSDe received
     *          uint256 sUsdeAmount = IERC20(stakedUsde).balanceOf(address(this));
     *
     *          // Transfer to proxy and initiate unstake
     *          address proxy = _allocateFreeProxy();
     *          IERC20(stakedUsde).transfer(proxy, sUsdeAmount);
     *          uint256 expectedAssets = UnstakeProxy(proxy).initiateUnstake(sUsdeAmount); // ✅ From Ethena
     *
     *          _openPosition(sUsdeAmount, bookValue, expectedAssets, proxy); // ✅ Validated inputs
     *      }
     *      ```
     *
     *      Alternative: Add balance verification directly in _openPosition (but this requires
     *      additional state tracking and complicates the function).
     *
     * @custom:security-note DO NOT expose this function publicly or call with untrusted inputs
     * @custom:audit-note Phase 5 implementation MUST validate bookValue via balance measurement
     */
    function _openPosition(
        uint256 sUsdeAmount,
        uint256 bookValue,
        uint256 expectedAssets,
        address proxyAddress
    ) internal returns (uint256 positionId) {
        // Basic sanity checks (NOT sufficient for security against malicious inputs)
        require(expectedAssets >= bookValue, "Expected assets must be >= book value");
        require(bookValue > 0, "Book value must be > 0");
        require(sUsdeAmount > 0, "sUSDe amount must be > 0");

        // Additional sanity check: bookValue should be reasonable relative to expectedAssets
        // Prevent obvious manipulation (e.g., bookValue = 1M, expectedAssets = 1.1M)
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

    /* ========== POSITION MANAGEMENT ========== */

    /**
     * @notice Claims the oldest matured position after cooldown period (FIFO order)
     * @dev Only keepers can call this after cooldown period. Vault receives the USDe from proxy.
     *      Positions must be claimed in FIFO order (oldest first).
     *      This ensures no gaps in the active position range [firstActivePositionId, nextPositionId).
     */
    function claimPosition() external nonReentrant onlyKeeper {
        // Get the oldest active position (FIFO)
        uint256 positionId = firstActivePositionId;

        require(positionId < nextPositionId, "No active positions");

        Position storage position = positions[positionId];

        // Validation checks
        require(!position.claimed, "Position already claimed");
        require(
            block.timestamp >= position.startTime + COOLDOWN_PERIOD,
            "Cooldown period not elapsed"
        );

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
