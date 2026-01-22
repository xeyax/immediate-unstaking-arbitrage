// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "../interfaces/IStakedUSDe.sol";
import "../interfaces/IUSDe.sol";

/**
 * @title MockStakedUSDe
 * @notice Mock implementation of Ethena's Staked USDe for testing
 * @dev Simulates sUSDe staking/unstaking with cooldown mechanism
 */
contract MockStakedUSDe is ERC20, IStakedUSDe {
    // ============ State Variables ============

    /// @notice Reference to USDe token
    IUSDe public immutable usde;

    /// @notice Cooldown duration in seconds (7 days = 604800)
    uint24 public immutable cooldownDuration;

    /// @notice Exchange rate: sUSDe to USDe (scaled by 1e18)
    /// @dev Example: 1.1e18 means 1 sUSDe = 1.1 USDe
    uint256 public exchangeRate;

    /// @notice Tracks cooldown data for each address
    struct UserCooldown {
        uint104 cooldownEnd;     // Timestamp when cooldown completes
        uint152 underlyingAmount; // Amount of USDe to receive
    }

    mapping(address => UserCooldown) public cooldowns;

    // ============ Constructor ============

    constructor(address _usde, uint24 _cooldownDuration)
        ERC20("Staked USDe", "sUSDe")
    {
        require(_usde != address(0), "Invalid USDe address");
        usde = IUSDe(_usde);
        cooldownDuration = _cooldownDuration;
        exchangeRate = 1e18; // Start at 1:1
    }

    // ============ Mock Control Functions ============

    /**
     * @notice Sets the exchange rate for testing
     * @param newRate New exchange rate (scaled by 1e18)
     */
    function setExchangeRate(uint256 newRate) external {
        require(newRate > 0, "Rate must be > 0");
        exchangeRate = newRate;
    }

    /**
     * @notice Mints sUSDe to an address for testing
     * @param to Address to receive sUSDe
     * @param amount Amount of sUSDe to mint
     */
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    // ============ IStakedUSDe Implementation ============

    /**
     * @notice Initiates cooldown for unstaking shares
     * @param shares Amount of sUSDe shares to unstake
     * @return assets Expected USDe amount after cooldown
     */
    function cooldownShares(uint256 shares)
        external
        override
        returns (uint256 assets)
    {
        address owner = msg.sender;
        require(shares > 0, "Shares must be > 0");
        require(balanceOf(owner) >= shares, "Insufficient balance");

        // Authorization: caller must be owner or have allowance
        if (msg.sender != owner) {
            uint256 currentAllowance = allowance(owner, msg.sender);
            require(currentAllowance >= shares, "Insufficient allowance");
            _approve(owner, msg.sender, currentAllowance - shares);
        }

        // Calculate expected USDe
        assets = convertToAssets(shares);

        // Burn sUSDe shares
        _burn(owner, shares);

        // Set cooldown
        cooldowns[owner] = UserCooldown({
            cooldownEnd: uint104(block.timestamp + cooldownDuration),
            underlyingAmount: uint152(assets)
        });

        return assets;
    }

    /**
     * @notice Claims USDe after cooldown completes
     * @param receiver Address to receive USDe
     */
    function unstake(address receiver) external override {
        UserCooldown memory cooldown = cooldowns[msg.sender];

        require(cooldown.underlyingAmount > 0, "No active cooldown");
        require(
            block.timestamp >= cooldown.cooldownEnd,
            "Cooldown not finished"
        );

        // Clear cooldown
        delete cooldowns[msg.sender];

        // Transfer USDe to receiver
        usde.transfer(receiver, cooldown.underlyingAmount);
    }

    /**
     * @notice Converts sUSDe shares to USDe assets
     * @param shares Amount of sUSDe shares
     * @return assets Equivalent USDe amount
     */
    function convertToAssets(uint256 shares)
        public
        view
        override
        returns (uint256 assets)
    {
        return (shares * exchangeRate) / 1e18;
    }
}
