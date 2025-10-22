// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IVaultMvp} from "../interfaces/IVaultMvp.sol";
import {ICooldownManager} from "../interfaces/ICooldownManager.sol";
import {ISUSDeAdapter} from "../interfaces/ISUSDeAdapter.sol";

/**
 * @title Vault
 * @notice ERC-4626 vault for sUSDe/USDe immediate unstaking arbitrage
 * @dev Implements linear profit accrual, FIFO withdrawal queue, and on-chain profit verification
 */
contract Vault is IVaultMvp, ERC4626, AccessControl, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;
    using Math for uint256;

    /*//////////////////////////////////////////////////////////////
                                STRUCTS
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Batch information for tracking cooldown positions
     * @param cost Amount of USDe spent on swap (part of P0)
     * @param expectedMature Expected USDe at maturity
     * @param t0 Start timestamp
     * @param t1 Maturity timestamp
     * @param rate Emission rate for this batch (gain per second)
     * @param locker Address holding the position
     * @param claimId Protocol claim identifier
     * @param claimed Whether batch has been claimed
     */
    struct Batch {
        uint256 cost;
        uint256 expectedMature;
        uint64 t0;
        uint64 t1;
        uint256 rate;
        address locker;
        bytes32 claimId;
        bool claimed;
    }

    /**
     * @notice Entry in the ends queue tracking when batches mature
     * @param t1 Maturity timestamp
     * @param rate Emission rate to remove at this time
     */
    struct EndEntry {
        uint64 t1;
        uint256 rate;
    }

    /**
     * @notice Withdrawal queue entry
     * @param user User address
     * @param amount Amount of USDe owed
     */
    struct WithdrawalQueueEntry {
        address user;
        uint256 amount;
    }

    /*//////////////////////////////////////////////////////////////
                            STATE VARIABLES
    //////////////////////////////////////////////////////////////*/

    // Roles
    bytes32 public constant KEEPER_ROLE = keccak256("KEEPER_ROLE");

    // External contracts
    ICooldownManager public immutable cooldownManager;
    ISUSDeAdapter public immutable adapter;
    address public immutable stakeToken; // sUSDe

    // NAV components: NAV = C + P0 + accruedGain - R
    uint256 public C; // Cash (idle USDe balance)
    uint256 public P0; // Total cost locked in cooldowns
    uint256 public accruedGain; // Accrued gain up to lastUpdate
    uint256 public emissionRate; // Current gain per second
    uint256 public lastUpdate; // Last accrual update timestamp
    uint256 public R; // Total withdrawal queue obligations

    // Batch tracking
    uint256 public nextBatchId;
    mapping(uint256 => Batch) public batches;

    // Ends queue (sorted by t1)
    EndEntry[] public ends;

    // Withdrawal queue (FIFO)
    WithdrawalQueueEntry[] public withdrawalQueue;
    uint256 public withdrawalQueueHead; // Index of next item to process

    // Parameters
    uint256 public minProfitBps; // Minimum profit in basis points (e.g., 15 = 0.15%)
    uint256 public maxUnstakeTime; // Maximum unstake time in seconds
    uint256 public depositCap; // Maximum total assets
    uint256 public perfFeeBps; // Performance fee in basis points (e.g., 1000 = 10%)
    address public feeRecipient; // Address to receive fees

    // Whitelisted routers for DEX swaps
    mapping(address => bool) public whitelistedRouters;

    /*//////////////////////////////////////////////////////////////
                                ERRORS
    //////////////////////////////////////////////////////////////*/

    error InsufficientProfit();
    error ExcessiveUnstakeTime();
    error DepositCapExceeded();
    error RouterNotWhitelisted();
    error SwapFailed();
    error BatchNotReady();
    error BatchNotFound();
    error InsufficientCash();
    error InvalidParameter();

    /*//////////////////////////////////////////////////////////////
                              CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Initialize vault
     * @param _asset Base asset (USDe)
     * @param _name Vault token name
     * @param _symbol Vault token symbol
     * @param _cooldownManager CooldownManager address
     * @param _adapter Staking adapter address
     * @param admin Admin address
     */
    constructor(
        address _asset,
        string memory _name,
        string memory _symbol,
        address _cooldownManager,
        address _adapter,
        address admin
    ) ERC20(_name, _symbol) ERC4626(IERC20(_asset)) {
        cooldownManager = ICooldownManager(_cooldownManager);
        adapter = ISUSDeAdapter(_adapter);
        stakeToken = adapter.stakeToken();

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(KEEPER_ROLE, admin);

        // Default parameters
        minProfitBps = 15; // 0.15%
        maxUnstakeTime = 10 days;
        depositCap = type(uint256).max; // No cap by default
        perfFeeBps = 0; // No fees in MVP
        feeRecipient = admin;

        lastUpdate = block.timestamp;
        nextBatchId = 1;
    }

    /*//////////////////////////////////////////////////////////////
                            ADMIN FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Update vault parameters
     */
    function setParameters(
        uint256 _minProfitBps,
        uint256 _maxUnstakeTime,
        uint256 _depositCap,
        uint256 _perfFeeBps
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_perfFeeBps > 10000) revert InvalidParameter(); // Max 100%

        minProfitBps = _minProfitBps;
        maxUnstakeTime = _maxUnstakeTime;
        depositCap = _depositCap;
        perfFeeBps = _perfFeeBps;

        emit ParametersUpdated(_minProfitBps, _maxUnstakeTime, _depositCap, _perfFeeBps);
    }

    /**
     * @notice Set fee recipient
     */
    function setFeeRecipient(address _feeRecipient) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_feeRecipient == address(0)) revert InvalidParameter();
        feeRecipient = _feeRecipient;
    }

    /**
     * @notice Whitelist or blacklist a DEX router
     */
    function setRouterWhitelist(address router, bool whitelisted)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        whitelistedRouters[router] = whitelisted;
    }

    /**
     * @notice Pause vault operations
     */
    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _pause();
    }

    /**
     * @notice Unpause vault operations
     */
    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    /*//////////////////////////////////////////////////////////////
                        ACCRUAL SYSTEM
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Update accrual state to current timestamp
     * @dev Processes matured batches and takes performance fees
     */
    function updateAccrual() public {
        uint256 elapsed = block.timestamp - lastUpdate;
        if (elapsed == 0) return;

        // Accrue gain based on emission rate
        if (emissionRate > 0) {
            uint256 newGain = emissionRate * elapsed;
            accruedGain += newGain;
        }

        // Process matured batches (remove their emission rates)
        _processEndsQueue();

        // Take performance fee if enabled
        if (perfFeeBps > 0 && accruedGain > 0) {
            _takePerformanceFee();
        }

        lastUpdate = block.timestamp;

        emit AccrualUpdated(accruedGain, emissionRate, block.timestamp);
    }

    /**
     * @notice Process ends queue to remove emission rates of matured batches
     */
    function _processEndsQueue() internal {
        uint256 length = ends.length;
        uint256 processed = 0;

        // Process all matured entries
        for (uint256 i = 0; i < length; i++) {
            if (ends[i].t1 > block.timestamp) break;

            emissionRate -= ends[i].rate;
            processed++;
        }

        // Remove processed entries
        if (processed > 0) {
            for (uint256 i = 0; i < length - processed; i++) {
                ends[i] = ends[i + processed];
            }
            for (uint256 i = 0; i < processed; i++) {
                ends.pop();
            }
        }
    }

    /**
     * @notice Take performance fee from accrued gains
     */
    function _takePerformanceFee() internal {
        uint256 feeAmount = (accruedGain * perfFeeBps) / 10000;
        if (feeAmount == 0) return;

        // Calculate shares to mint for fee
        uint256 supply = totalSupply();
        uint256 sharesMinted = 0;

        if (supply > 0) {
            uint256 currentNav = nav();
            sharesMinted = (feeAmount * supply) / currentNav;
            _mint(feeRecipient, sharesMinted);
        }

        // Reduce accrued gain by fee taken
        accruedGain -= feeAmount;

        emit FeesTaken(feeAmount, sharesMinted, feeRecipient);
    }

    /*//////////////////////////////////////////////////////////////
                        ARBITRAGE FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /**
     * @inheritdoc IVaultMvp
     */
    function executeArb(ExecuteArbParams calldata p)
        external
        override
        onlyRole(KEEPER_ROLE)
        nonReentrant
        whenNotPaused
        returns (uint256 batchId)
    {
        updateAccrual();

        // Validate router
        if (!whitelistedRouters[p.router]) revert RouterNotWhitelisted();

        // Use provided params or fall back to global
        uint256 minProfit = p.minProfitBps > 0 ? p.minProfitBps : minProfitBps;
        uint256 maxTime = p.maxUnstakeTime > 0 ? p.maxUnstakeTime : maxUnstakeTime;

        // Execute swap: USDe -> sUSDe
        uint256 balanceBefore = IERC20(stakeToken).balanceOf(address(this));
        IERC20(asset()).forceApprove(p.router, p.baseAmountIn);

        (bool success,) = p.router.call(p.swapCalldata);
        if (!success) revert SwapFailed();

        uint256 balanceAfter = IERC20(stakeToken).balanceOf(address(this));
        uint256 sUSDeOut = balanceAfter - balanceBefore;

        // Preview unstake
        (uint256 expectedBase, uint256 etaSeconds) = adapter.previewUnstake(sUSDeOut);

        // On-chain verification
        uint256 expectedGain = expectedBase > p.baseAmountIn
            ? expectedBase - p.baseAmountIn
            : 0;
        uint256 minGain = (p.baseAmountIn * minProfit) / 10000;

        if (expectedGain < minGain) revert InsufficientProfit();
        if (etaSeconds > maxTime) revert ExcessiveUnstakeTime();

        // Approve and open cooldown
        IERC20(stakeToken).forceApprove(address(cooldownManager), sUSDeOut);

        ICooldownManager.OpenCooldownResult memory result =
            cooldownManager.openCooldown(sUSDeOut, "");

        // Register batch
        batchId = nextBatchId++;
        uint256 gain = expectedBase - p.baseAmountIn;
        uint256 duration = uint256(result.t1 - result.t0);
        uint256 rate = duration > 0 ? (gain * 1e18) / duration : 0; // Scale by 1e18 for precision

        batches[batchId] = Batch({
            cost: p.baseAmountIn,
            expectedMature: expectedBase,
            t0: result.t0,
            t1: result.t1,
            rate: rate,
            locker: result.locker,
            claimId: result.claimId,
            claimed: false
        });

        // Update NAV components
        P0 += p.baseAmountIn;
        emissionRate += rate;
        C -= p.baseAmountIn; // Reduce cash

        // Add to ends queue
        _insertEnd(result.t1, rate);

        emit BatchOpened(
            batchId,
            result.locker,
            p.baseAmountIn,
            expectedBase,
            gain,
            result.t0,
            result.t1,
            rate
        );

        return batchId;
    }

    /**
     * @inheritdoc IVaultMvp
     */
    function claimBatch(uint256 batchId)
        external
        override
        onlyRole(KEEPER_ROLE)
        nonReentrant
        returns (uint256 amountBaseReceived)
    {
        updateAccrual();

        Batch storage batch = batches[batchId];
        if (batch.t0 == 0) revert BatchNotFound();
        if (batch.claimed) revert BatchNotFound();
        if (block.timestamp < batch.t1) revert BatchNotReady();

        // Mark as claimed
        batch.claimed = true;

        // Claim from cooldown manager
        amountBaseReceived = cooldownManager.claim(batchId);

        // Update NAV components
        C += amountBaseReceived;
        P0 -= batch.cost;

        // Process withdrawal queue
        _processWithdrawalQueue();

        emit BatchMatured(batchId, batch.locker, amountBaseReceived);

        return amountBaseReceived;
    }

    /**
     * @notice Insert an end entry in sorted order
     */
    function _insertEnd(uint64 t1, uint256 rate) internal {
        ends.push(EndEntry({t1: t1, rate: rate}));

        // Bubble sort (simple for small arrays in MVP)
        uint256 length = ends.length;
        for (uint256 i = length - 1; i > 0; i--) {
            if (ends[i].t1 < ends[i - 1].t1) {
                EndEntry memory temp = ends[i];
                ends[i] = ends[i - 1];
                ends[i - 1] = temp;
            } else {
                break;
            }
        }
    }

    /*//////////////////////////////////////////////////////////////
                        WITHDRAWAL QUEUE
    //////////////////////////////////////////////////////////////*/

    /**
     * @inheritdoc IVaultMvp
     */
    function requestWithdraw(uint256 shares) external override nonReentrant whenNotPaused {
        updateAccrual();

        uint256 assets = convertToAssets(shares);

        // Burn shares immediately
        _burn(msg.sender, shares);

        // Try to pay immediately from cash
        uint256 available = C;
        uint256 paid = available >= assets ? assets : available;

        if (paid > 0) {
            C -= paid;
            IERC20(asset()).safeTransfer(msg.sender, paid);
        }

        // Queue the rest
        uint256 queued = assets - paid;
        if (queued > 0) {
            withdrawalQueue.push(WithdrawalQueueEntry({
                user: msg.sender,
                amount: queued
            }));
            R += queued;

            emit WithdrawQueued(msg.sender, shares, assets, paid, queued);
        }
    }

    /**
     * @notice Process withdrawal queue using available cash
     */
    function _processWithdrawalQueue() internal {
        while (withdrawalQueueHead < withdrawalQueue.length && C > 0) {
            WithdrawalQueueEntry storage entry = withdrawalQueue[withdrawalQueueHead];

            uint256 toPay = entry.amount > C ? C : entry.amount;

            C -= toPay;
            R -= toPay;
            entry.amount -= toPay;

            IERC20(asset()).safeTransfer(entry.user, toPay);
            emit WithdrawPaidFromQueue(entry.user, toPay);

            if (entry.amount == 0) {
                withdrawalQueueHead++;
            }
        }
    }

    /*//////////////////////////////////////////////////////////////
                        ERC-4626 OVERRIDES
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Get total assets (NAV)
     */
    function totalAssets() public view override returns (uint256) {
        return nav();
    }

    /**
     * @notice Deposit assets
     */
    function deposit(uint256 assets, address receiver)
        public
        override
        nonReentrant
        whenNotPaused
        returns (uint256 shares)
    {
        updateAccrual();

        if (totalAssets() + assets > depositCap) revert DepositCapExceeded();

        shares = previewDeposit(assets);

        IERC20(asset()).safeTransferFrom(msg.sender, address(this), assets);
        _mint(receiver, shares);

        C += assets;

        emit Deposit(msg.sender, receiver, assets, shares);

        return shares;
    }

    /**
     * @notice Mint shares
     */
    function mint(uint256 shares, address receiver)
        public
        override
        nonReentrant
        whenNotPaused
        returns (uint256 assets)
    {
        updateAccrual();

        assets = previewMint(shares);

        if (totalAssets() + assets > depositCap) revert DepositCapExceeded();

        IERC20(asset()).safeTransferFrom(msg.sender, address(this), assets);
        _mint(receiver, shares);

        C += assets;

        emit Deposit(msg.sender, receiver, assets, shares);

        return assets;
    }

    /**
     * @notice Withdraw assets (must use requestWithdraw for queue)
     */
    function withdraw(uint256 assets, address receiver, address owner)
        public
        override
        nonReentrant
        whenNotPaused
        returns (uint256 shares)
    {
        updateAccrual();

        if (C < assets) revert InsufficientCash();

        shares = previewWithdraw(assets);

        if (msg.sender != owner) {
            _spendAllowance(owner, msg.sender, shares);
        }

        _burn(owner, shares);
        C -= assets;

        IERC20(asset()).safeTransfer(receiver, assets);

        emit Withdraw(msg.sender, receiver, owner, assets, shares);

        return shares;
    }

    /**
     * @notice Redeem shares (must use requestWithdraw for queue)
     */
    function redeem(uint256 shares, address receiver, address owner)
        public
        override
        nonReentrant
        whenNotPaused
        returns (uint256 assets)
    {
        updateAccrual();

        assets = previewRedeem(shares);

        if (C < assets) revert InsufficientCash();

        if (msg.sender != owner) {
            _spendAllowance(owner, msg.sender, shares);
        }

        _burn(owner, shares);
        C -= assets;

        IERC20(asset()).safeTransfer(receiver, assets);

        emit Withdraw(msg.sender, receiver, owner, assets, shares);

        return assets;
    }

    /*//////////////////////////////////////////////////////////////
                            VIEW FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /**
     * @inheritdoc IVaultMvp
     */
    function nav() public view override returns (uint256) {
        uint256 currentAccrued = accruedGain;

        // Add accrued gain since last update
        uint256 elapsed = block.timestamp - lastUpdate;
        if (elapsed > 0 && emissionRate > 0) {
            currentAccrued += (emissionRate * elapsed);
        }

        // NAV = C + P0 + G(t) - R
        return C + P0 + currentAccrued - R;
    }

    /**
     * @inheritdoc IVaultMvp
     */
    function pps() external view override returns (uint256) {
        uint256 supply = totalSupply();
        if (supply == 0) return 1e18;
        return (nav() * 1e18) / supply;
    }

    /**
     * @notice Get batch info
     */
    function getBatch(uint256 batchId) external view returns (Batch memory) {
        return batches[batchId];
    }

    /**
     * @notice Get withdrawal queue length
     */
    function withdrawalQueueLength() external view returns (uint256) {
        return withdrawalQueue.length - withdrawalQueueHead;
    }

    /**
     * @notice Get ends queue length
     */
    function endsQueueLength() external view returns (uint256) {
        return ends.length;
    }
}
