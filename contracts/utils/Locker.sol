// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title Locker
 * @notice Simple contract that holds unstaking positions for the vault
 * @dev Each locker can hold at most one active batch at a time
 *      The CooldownManager is the only authorized caller
 */
contract Locker {
    using SafeERC20 for IERC20;

    /*//////////////////////////////////////////////////////////////
                            STATE VARIABLES
    //////////////////////////////////////////////////////////////*/

    /// @notice Address of the CooldownManager (only authorized caller)
    address public immutable cooldownManager;

    /*//////////////////////////////////////////////////////////////
                                ERRORS
    //////////////////////////////////////////////////////////////*/

    error Unauthorized();

    /*//////////////////////////////////////////////////////////////
                              CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Initialize locker with cooldown manager
     * @param _cooldownManager Address of the CooldownManager contract
     */
    constructor(address _cooldownManager) {
        cooldownManager = _cooldownManager;
    }

    /*//////////////////////////////////////////////////////////////
                               MODIFIERS
    //////////////////////////////////////////////////////////////*/

    modifier onlyManager() {
        if (msg.sender != cooldownManager) revert Unauthorized();
        _;
    }

    /*//////////////////////////////////////////////////////////////
                            MAIN FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Execute arbitrary call on behalf of this locker
     * @dev Only callable by CooldownManager
     * @param target Target contract address
     * @param data Calldata to execute
     * @return result Return data from the call
     */
    function execute(address target, bytes calldata data)
        external
        onlyManager
        returns (bytes memory result)
    {
        (bool success, bytes memory returnData) = target.call(data);
        if (!success) {
            // Bubble up revert reason
            assembly {
                revert(add(returnData, 32), mload(returnData))
            }
        }
        return returnData;
    }

    /**
     * @notice Transfer tokens from this locker to a recipient
     * @dev Only callable by CooldownManager
     * @param token Token address
     * @param to Recipient address
     * @param amount Amount to transfer
     */
    function transfer(address token, address to, uint256 amount)
        external
        onlyManager
    {
        IERC20(token).safeTransfer(to, amount);
    }

    /**
     * @notice Approve tokens for spending
     * @dev Only callable by CooldownManager
     * @param token Token address
     * @param spender Spender address
     * @param amount Amount to approve
     */
    function approve(address token, address spender, uint256 amount)
        external
        onlyManager
    {
        IERC20(token).forceApprove(spender, amount);
    }
}
