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
 * - ADR-002: Time-weighted profit accrual
 * - ADR-003: O(1) position accounting via accrual rate
 * - ADR-005: Owner + keeper access control
 * - ADR-008: Proxy orchestration for concurrent unstakes
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
     * @dev Currently returns only idle USDe balance
     *      Will be extended in Phase 3 to include position values
     */
    function totalAssets() public view virtual override returns (uint256) {
        // Phase 1: Simple implementation - only idle USDe
        // Phase 3 will add: idle USDe + position values with time-weighted accrual
        return IERC20(asset()).balanceOf(address(this));
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
}
