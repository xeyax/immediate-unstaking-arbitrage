// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title MockERC20
 * @notice Mock ERC20 token for testing purposes
 * @dev Allows unrestricted minting for test scenarios
 */
contract MockERC20 is ERC20 {
    uint8 private immutable _decimals;

    /**
     * @notice Creates a new MockERC20 token
     * @param name_ Token name
     * @param symbol_ Token symbol
     * @param decimals_ Token decimals
     */
    constructor(
        string memory name_,
        string memory symbol_,
        uint8 decimals_
    ) ERC20(name_, symbol_) {
        _decimals = decimals_;
    }

    /**
     * @notice Returns the number of decimals used by the token
     * @return Number of decimals
     */
    function decimals() public view virtual override returns (uint8) {
        return _decimals;
    }

    /**
     * @notice Mints tokens to a specified address
     * @param to Address to receive the minted tokens
     * @param amount Amount of tokens to mint
     * @dev Public function for testing - allows anyone to mint
     */
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    /**
     * @notice Burns tokens from a specified address
     * @param from Address to burn tokens from
     * @param amount Amount of tokens to burn
     * @dev Public function for testing - allows anyone to burn
     */
    function burn(address from, uint256 amount) external {
        _burn(from, amount);
    }
}
