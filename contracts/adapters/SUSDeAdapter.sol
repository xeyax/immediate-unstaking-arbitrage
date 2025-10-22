// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ISUSDeAdapter} from "../interfaces/ISUSDeAdapter.sol";
import {ISUSDe} from "../interfaces/external/ISUSDe.sol";
import {IUSDe} from "../interfaces/external/IUSDe.sol";
import {Locker} from "../utils/Locker.sol";

/**
 * @title SUSDeAdapter
 * @notice Adapter for sUSDe staking protocol integration
 * @dev Handles unstaking requests and claims via the sUSDe cooldown mechanism
 */
contract SUSDeAdapter is ISUSDeAdapter {
    using SafeERC20 for IERC20;

    /*//////////////////////////////////////////////////////////////
                            STATE VARIABLES
    //////////////////////////////////////////////////////////////*/

    /// @notice USDe token address (0x4c9edd5852cd905f086c759e8383e09bff1e68b3)
    IUSDe private immutable _baseAsset;

    /// @notice sUSDe token address (0x9D39A5DE30e57443BfF2A8307A4256c8797A3497)
    ISUSDe private immutable _stakeToken;

    /// @notice Address authorized to call adapter functions (CooldownManager)
    address public immutable cooldownManager;

    /*//////////////////////////////////////////////////////////////
                                ERRORS
    //////////////////////////////////////////////////////////////*/

    error Unauthorized();
    error InvalidLocker();
    error CooldownNotComplete();

    /*//////////////////////////////////////////////////////////////
                              CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Initialize adapter with token addresses
     * @param baseAsset_ USDe token address
     * @param stakeToken_ sUSDe token address
     * @param _cooldownManager CooldownManager address
     */
    constructor(
        address baseAsset_,
        address stakeToken_,
        address _cooldownManager
    ) {
        _baseAsset = IUSDe(baseAsset_);
        _stakeToken = ISUSDe(stakeToken_);
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
                            VIEW FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /**
     * @inheritdoc ISUSDeAdapter
     */
    function baseAsset() external view override returns (address) {
        return address(_baseAsset);
    }

    /**
     * @inheritdoc ISUSDeAdapter
     */
    function stakeToken() external view override returns (address) {
        return address(_stakeToken);
    }

    /**
     * @inheritdoc ISUSDeAdapter
     */
    function previewUnstake(uint256 amountStake)
        external
        view
        override
        returns (uint256 amountBase, uint256 etaSeconds)
    {
        // Convert sUSDe to USDe using current exchange rate
        amountBase = _stakeToken.convertToAssets(amountStake);

        // Get cooldown duration from protocol
        etaSeconds = uint256(_stakeToken.cooldownDuration());

        return (amountBase, etaSeconds);
    }

    /*//////////////////////////////////////////////////////////////
                            MAIN FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /**
     * @inheritdoc ISUSDeAdapter
     */
    function requestUnstake(address locker, uint256 amountStake)
        external
        override
        onlyManager
        returns (bytes32 claimId, uint64 t1, uint256 expectedBase)
    {
        if (locker == address(0)) revert InvalidLocker();

        // Transfer sUSDe from caller (CooldownManager/Vault) to this adapter
        IERC20(address(_stakeToken)).safeTransferFrom(
            msg.sender,
            address(this),
            amountStake
        );

        // Transfer sUSDe to locker
        IERC20(address(_stakeToken)).safeTransfer(locker, amountStake);

        // Calculate expected base amount
        expectedBase = _stakeToken.convertToAssets(amountStake);

        // Call cooldownShares via locker
        bytes memory cooldownCalldata = abi.encodeWithSelector(
            ISUSDe.cooldownShares.selector,
            amountStake
        );

        Locker(locker).execute(address(_stakeToken), cooldownCalldata);

        // Calculate maturity time
        uint64 cooldownDuration = _stakeToken.cooldownDuration();
        t1 = uint64(block.timestamp) + cooldownDuration;

        // Generate claim ID (hash of locker address and timestamp)
        claimId = keccak256(abi.encodePacked(locker, block.timestamp, amountStake));

        emit UnstakeRequested(locker, claimId, amountStake, expectedBase, t1);

        return (claimId, t1, expectedBase);
    }

    /**
     * @inheritdoc ISUSDeAdapter
     */
    function claim(address locker, bytes32 claimId, address receiver)
        external
        override
        onlyManager
        returns (uint256 amountBaseReceived)
    {
        if (locker == address(0)) revert InvalidLocker();

        // Check that cooldown is complete
        ISUSDe.UserCooldown memory cooldown = _stakeToken.cooldowns(locker);
        if (block.timestamp < cooldown.cooldownEnd) {
            revert CooldownNotComplete();
        }

        // Get balance before unstake
        uint256 balanceBefore = _baseAsset.balanceOf(receiver);

        // Call unstake via locker to receive USDe
        bytes memory unstakeCalldata = abi.encodeWithSelector(
            ISUSDe.unstake.selector,
            receiver
        );

        Locker(locker).execute(address(_stakeToken), unstakeCalldata);

        // Get balance after unstake
        uint256 balanceAfter = _baseAsset.balanceOf(receiver);
        amountBaseReceived = balanceAfter - balanceBefore;

        emit UnstakeClaimed(locker, claimId, receiver, amountBaseReceived);

        return amountBaseReceived;
    }
}
