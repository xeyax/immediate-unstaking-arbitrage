// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

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
 */
contract ArbitrageVault is ERC4626, Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /* ========== STATE VARIABLES ========== */

    /// @notice Vault name: "Arbitrage Vault USDe"
    string private constant VAULT_NAME = "Arbitrage Vault USDe";

    /// @notice Vault symbol: "avUSDe"
    string private constant VAULT_SYMBOL = "avUSDe";

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

    /* ========== CONSTRUCTOR ========== */

    /**
     * @notice Initializes the ArbitrageVault contract
     * @param usdeToken Address of the USDe token (underlying asset)
     * @dev Sets up ERC4626 with USDe as the underlying asset
     *      and initializes ownership to the deployer
     */
    constructor(
        address usdeToken
    )
        ERC4626(IERC20(usdeToken))
        ERC20(VAULT_NAME, VAULT_SYMBOL)
        Ownable(msg.sender)
    {
        require(usdeToken != address(0), "ArbitrageVault: zero address");
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
}
