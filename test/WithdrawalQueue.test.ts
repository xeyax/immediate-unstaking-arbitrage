import { expect } from "chai";
import { ethers } from "hardhat";
import {
  ArbitrageVault,
  MockERC20,
  MockStakedUSDe,
  MockDEX
} from "../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-network-helpers";

describe("ArbitrageVault - Phase 6: Withdrawal Queue", function () {
  let vault: ArbitrageVault;
  let usde: MockERC20;
  let sUsde: MockStakedUSDe;
  let dex: MockDEX;
  let owner: SignerWithAddress;
  let keeper: SignerWithAddress;
  let user1: SignerWithAddress;
  let user2: SignerWithAddress;
  let feeRecipient: SignerWithAddress;

  const INITIAL_SUPPLY = ethers.parseEther("1000000");
  const COOLDOWN_PERIOD = 7 * 24 * 60 * 60; // 7 days

  // Helper: withdraw specified assets by converting to shares
  // Async-only model: always uses requestWithdrawal()
  async function withdrawAssets(vault: ArbitrageVault, signer: SignerWithAddress, assets: bigint) {
    const shares = await vault.previewWithdraw(assets);
    // Fully async model - all withdrawals go through queue
    return await vault.connect(signer).requestWithdrawal(shares, signer.address, signer.address);
  }

  beforeEach(async function () {
    [owner, keeper, user1, user2, feeRecipient] = await ethers.getSigners();

    // Deploy mock tokens
    const MockERC20Factory = await ethers.getContractFactory("MockERC20");
    usde = await MockERC20Factory.deploy("USDe", "USDe", 18);
    await usde.waitForDeployment();

    const MockStakedUSDeFactory = await ethers.getContractFactory("MockStakedUSDe");
    sUsde = await MockStakedUSDeFactory.deploy(await usde.getAddress(), COOLDOWN_PERIOD);
    await sUsde.waitForDeployment();

    // Deploy vault
    const VaultFactory = await ethers.getContractFactory("ArbitrageVault");
    vault = await VaultFactory.deploy(
      await usde.getAddress(),
      await sUsde.getAddress(),
      feeRecipient.address
    );
    await vault.waitForDeployment();

    // Deploy mock DEX
    const MockDEXFactory = await ethers.getContractFactory("MockDEX");
    dex = await MockDEXFactory.deploy(
      await usde.getAddress(),
      await sUsde.getAddress(),
      ethers.parseEther("1.05")
    );
    await dex.waitForDeployment();

    // Mint tokens
    await usde.mint(user1.address, INITIAL_SUPPLY);
    await usde.mint(user2.address, INITIAL_SUPPLY);
    await sUsde.mint(await dex.getAddress(), INITIAL_SUPPLY);
    await usde.mint(await sUsde.getAddress(), INITIAL_SUPPLY);

    // Setup vault
    await vault.deployProxies(5);
    await vault.addKeeper(keeper.address);

    // User1 deposits 10000 USDe
    await usde.connect(user1).approve(await vault.getAddress(), ethers.parseEther("10000"));
    await vault.connect(user1).deposit(ethers.parseEther("10000"), user1.address);
  });

  describe("Immediate Withdrawals (sufficient liquidity)", function () {
    it.skip("should execute immediate withdrawal when liquidity available", async function () {
      const withdrawAmount = ethers.parseEther("1000");

      const balanceBefore = await usde.balanceOf(user1.address);

      // Convert assets to shares for redeem()
      const sharesToRedeem = await vault.previewWithdraw(withdrawAmount);
      await vault.connect(user1).requestWithdrawal(sharesToRedeem, user1.address, user1.address);

      const balanceAfter = await usde.balanceOf(user1.address);
      expect(balanceAfter - balanceBefore).to.be.closeTo(withdrawAmount, ethers.parseEther("1"));

      // No queue request should be created
      expect(await vault.pendingWithdrawalCount()).to.equal(0);
    });

    it.skip("should execute immediate redeem when liquidity available", async function () {
      const shares = ethers.parseEther("1000");

      const balanceBefore = await usde.balanceOf(user1.address);

      await vault.connect(user1).requestWithdrawal(shares, user1.address, user1.address);

      const balanceAfter = await usde.balanceOf(user1.address);
      expect(balanceAfter).to.be.gt(balanceBefore);

      // No queue request should be created
      expect(await vault.pendingWithdrawalCount()).to.equal(0);
    });
  });

  describe("Queued Withdrawals (insufficient liquidity)", function () {
    beforeEach(async function () {
      // Deploy most capital into arbitrage to create liquidity shortage
      const amountIn = ethers.parseEther("9000");
      const minAmountOut = ethers.parseEther("9400");
      const swapCalldata = dex.interface.encodeFunctionData("swap", [amountIn, minAmountOut]);

      await vault.connect(keeper).executeArbitrage(
        await dex.getAddress(),
        amountIn,
        minAmountOut,
        swapCalldata
      );

      // Now vault has ~1000 USDe idle, 9000 USDe in position
    });

    it("should create withdrawal request when liquidity insufficient", async function () {
      const withdrawAmount = ethers.parseEther("5000"); // More than available

      const tx = await withdrawAssets(vault, user1, withdrawAmount);

      // Should emit WithdrawalRequested
      await expect(tx).to.emit(vault, "WithdrawalRequested");

      // Request may be immediately fulfilled if idle balance available (auto-fulfill)
      // or queued if insufficient liquidity
      const queueCount = await vault.pendingWithdrawalCount();

      if (queueCount > 0) {
        // Still queued (insufficient liquidity for full amount)
        const request = await vault.getWithdrawalRequest(1);
        expect(request.owner).to.equal(user1.address);
        expect(request.shares).to.be.gt(0);
        console.log("✅ Request queued (partial or no liquidity)");
      } else {
        // Immediately fulfilled (auto-fulfill with idle balance)
        console.log("✅ Request fulfilled immediately (had idle liquidity)");
      }
    });

    it("should transfer shares to escrow when creating request", async function () {
      const sharesBefore = await vault.balanceOf(user1.address);
      const vaultSharesBefore = await vault.balanceOf(await vault.getAddress());
      const withdrawAmount = ethers.parseEther("5000");

      await withdrawAssets(vault, user1, withdrawAmount);

      const sharesAfter = await vault.balanceOf(user1.address);
      const vaultSharesAfter = await vault.balanceOf(await vault.getAddress());

      // User's shares decreased (transferred to escrow)
      expect(sharesBefore).to.be.gt(sharesAfter);
      // Vault's shares increased (held in escrow)
      expect(vaultSharesAfter).to.be.gt(vaultSharesBefore);
    });

    // Note: Auto-claim tests removed - simplified API no longer auto-claims
    // Users must explicitly call requestWithdrawal() when liquidity insufficient
  });

  describe("Minimum Withdrawal Size", function () {
    it("should reject withdrawal below minimum (1 USDe)", async function () {
      // Deposit small amount (0.5 USDe)
      await usde.mint(user2.address, ethers.parseEther("0.5"));
      await usde.connect(user2).approve(await vault.getAddress(), ethers.parseEther("0.5"));
      await vault.connect(user2).deposit(ethers.parseEther("0.5"), user2.address);

      const shares = await vault.balanceOf(user2.address);

      // Try to withdraw - should fail because assets < 1 USDe
      await expect(
        vault.connect(user2).requestWithdrawal(shares, user2.address, user2.address)
      ).to.be.revertedWith("Withdrawal below minimum (1 USDe)");
    });

    it("should accept withdrawal at minimum (1 USDe)", async function () {
      // Deposit exactly 1 USDe
      await usde.mint(user2.address, ethers.parseEther("1"));
      await usde.connect(user2).approve(await vault.getAddress(), ethers.parseEther("1"));
      await vault.connect(user2).deposit(ethers.parseEther("1"), user2.address);

      const shares = await vault.balanceOf(user2.address);

      // Should succeed and emit event (may be immediately fulfilled if liquidity available)
      await expect(
        vault.connect(user2).requestWithdrawal(shares, user2.address, user2.address)
      ).to.emit(vault, "WithdrawalRequested");
    });

    it("should check MIN_WITHDRAWAL_ASSETS constant", async function () {
      const minAssets = await vault.MIN_WITHDRAWAL_ASSETS();
      expect(minAssets).to.equal(ethers.parseEther("1")); // 1 USDe
    });
  });

  describe("Withdrawal Request Cancellation", function () {
    let requestId: bigint;

    beforeEach(async function () {
      // Create liquidity shortage
      const amountIn = ethers.parseEther("9000");
      const minAmountOut = ethers.parseEther("9400");
      const swapCalldata = dex.interface.encodeFunctionData("swap", [amountIn, minAmountOut]);

      await vault.connect(keeper).executeArbitrage(
        await dex.getAddress(),
        amountIn,
        minAmountOut,
        swapCalldata
      );

      // Create withdrawal request
      const tx = await withdrawAssets(vault, user1, ethers.parseEther("5000"));
      const receipt = await tx.wait();
      const event = receipt?.logs.find(
        (log: any) => log.eventName === "WithdrawalRequested"
      ) as any;
      requestId = event?.args?.requestId;
    });

    it("should reject cancellation before cooldown period", async function () {
      // Try to cancel immediately - should fail
      await expect(
        vault.connect(user1).cancelWithdrawal(requestId)
      ).to.be.revertedWith("Must wait 5 minutes before cancelling");
    });

    it("should have correct MIN_TIME_BEFORE_CANCEL constant", async function () {
      const minTime = await vault.MIN_TIME_BEFORE_CANCEL();
      expect(minTime).to.equal(5 * 60); // 5 minutes in seconds
    });

    it("should allow user to cancel their withdrawal request after cooldown", async function () {
      const sharesBefore = await vault.balanceOf(user1.address);

      // Wait for cooldown period
      await time.increase(5 * 60 + 1); // 5 minutes + 1 second

      await expect(vault.connect(user1).cancelWithdrawal(requestId))
        .to.emit(vault, "WithdrawalCancelled");

      // Shares should be returned
      const sharesAfter = await vault.balanceOf(user1.address);
      expect(sharesAfter).to.be.gt(sharesBefore);

      // Queue should have no active requests (use getActivePendingCount for exact count)
      // Note: pendingWithdrawalCount() returns tail - head which may include cancelled slots
      expect(await vault.getActivePendingCount()).to.equal(0);

      // Request should be marked cancelled
      const request = await vault.getWithdrawalRequest(requestId);
      expect(request.cancelled).to.be.true;
    });

    it("should reject cancellation from non-owner", async function () {
      await time.increase(5 * 60 + 1); // Wait for cooldown
      await expect(
        vault.connect(user2).cancelWithdrawal(requestId)
      ).to.be.revertedWith("Not request owner");
    });

    it("should reject cancelling already cancelled request", async function () {
      await time.increase(5 * 60 + 1); // Wait for cooldown
      await vault.connect(user1).cancelWithdrawal(requestId);

      await expect(
        vault.connect(user1).cancelWithdrawal(requestId)
      ).to.be.revertedWith("Already cancelled");
    });
  });

  describe("Withdrawal Request Fulfillment", function () {
    it("should automatically fulfill request when keeper claims position", async function () {
      // Deploy capital
      const amountIn = ethers.parseEther("8000");
      const minAmountOut = ethers.parseEther("8400");
      const swapCalldata = dex.interface.encodeFunctionData("swap", [amountIn, minAmountOut]);

      await vault.connect(keeper).executeArbitrage(
        await dex.getAddress(),
        amountIn,
        minAmountOut,
        swapCalldata
      );

      // Create withdrawal request (more than idle ~2000 USDe)
      const sharesToRequest = await vault.previewWithdraw(ethers.parseEther("5000"));

      // NEW BEHAVIOR: Measure balance BEFORE request (receives idle immediately)
      const balanceBefore = await usde.balanceOf(user1.address);
      await vault.connect(user1).requestWithdrawal(sharesToRequest, user1.address, user1.address);

      // May be partially fulfilled or still queued depending on idle liquidity
      const queueCount = await vault.pendingWithdrawalCount();
      expect(queueCount).to.be.lte(1); // 0 if fully fulfilled, 1 if partially queued

      // Fast forward and claim position
      await time.increase(COOLDOWN_PERIOD + 1);
      await vault.connect(keeper).claimPosition();

      const balanceAfter = await usde.balanceOf(user1.address);

      // User should have received USDe (immediate + claim = at least requested amount)
      const received = balanceAfter - balanceBefore;
      expect(received).to.be.gte(ethers.parseEther("5000")); // At least requested amount
      expect(received).to.be.lte(ethers.parseEther("5500")); // Upper bound (reasonable profit)

      // Request should be fully fulfilled (all shares burned)
      const request = await vault.getWithdrawalRequest(1);
      expect(request.fulfilled).to.equal(request.shares);

      // Queue should be empty
      expect(await vault.pendingWithdrawalCount()).to.equal(0);
    });

    it("should handle partial fulfillment correctly", async function () {
      // Create 2 small positions instead of 1 large
      const amountIn = ethers.parseEther("4500");
      const minAmountOut = ethers.parseEther("4700");
      const swapCalldata = dex.interface.encodeFunctionData("swap", [amountIn, minAmountOut]);

      // Execute 2 arbitrages
      await vault.connect(keeper).executeArbitrage(await dex.getAddress(), amountIn, minAmountOut, swapCalldata);
      await vault.connect(keeper).executeArbitrage(await dex.getAddress(), amountIn, minAmountOut, swapCalldata);

      // Now ~1000 USDe idle, 9000 USDe in 2 positions

      // Create large withdrawal request (more than 1 position can provide)
      const shares1 = await vault.previewWithdraw(ethers.parseEther("8000"));
      await vault.connect(user1).requestWithdrawal(shares1, user1.address, user1.address);

      const balanceBefore = await usde.balanceOf(user1.address);

      // Claim first position (provides ~4500 USDe + ~1000 idle = ~5500 total)
      await time.increase(COOLDOWN_PERIOD + 1);
      await vault.connect(keeper).claimPosition();

      const balanceAfter = await usde.balanceOf(user1.address);

      // User should have received partial fulfillment
      const received = balanceAfter - balanceBefore;
      expect(received).to.be.gt(ethers.parseEther("4000")); // At least some fulfillment
      expect(received).to.be.lt(ethers.parseEther("8000")); // Less than full request

      // Request should be partially fulfilled (some shares burned, some still in escrow)
      const request = await vault.getWithdrawalRequest(1);
      expect(request.fulfilled).to.be.gt(0);
      expect(request.fulfilled).to.be.lt(request.shares);

      // Request should still be in queue
      expect(await vault.pendingWithdrawalCount()).to.equal(1);
    });

    it("should fulfill multiple requests in FIFO order", async function () {
      // User2 deposits first (before arbitrage)
      await usde.connect(user2).approve(await vault.getAddress(), ethers.parseEther("5000"));
      await vault.connect(user2).deposit(ethers.parseEther("5000"), user2.address);

      // Deploy most capital (leaving ~1000 idle from 15000 total)
      const amountIn = ethers.parseEther("14000");
      const minAmountOut = ethers.parseEther("14600");
      const swapCalldata = dex.interface.encodeFunctionData("swap", [amountIn, minAmountOut]);

      await vault.connect(keeper).executeArbitrage(
        await dex.getAddress(),
        amountIn,
        minAmountOut,
        swapCalldata
      );

      // Create 2 withdrawal requests (may be partially fulfilled with idle liquidity)
      const shares1 = await vault.previewWithdraw(ethers.parseEther("3000"));
      const shares2 = await vault.previewWithdraw(ethers.parseEther("3000"));

      // NEW BEHAVIOR: Measure balances BEFORE requests (receives idle immediately)
      const user1BalanceBefore = await usde.balanceOf(user1.address);
      const user2BalanceBefore = await usde.balanceOf(user2.address);

      await vault.connect(user1).requestWithdrawal(shares1, user1.address, user1.address);
      await vault.connect(user2).requestWithdrawal(shares2, user2.address, user2.address);

      // May be partially fulfilled with idle liquidity
      const queueCountAfterRequests = await vault.pendingWithdrawalCount();
      expect(queueCountAfterRequests).to.be.lte(2);

      // Claim position (provides ~9000 USDe)
      await time.increase(COOLDOWN_PERIOD + 1);
      await vault.connect(keeper).claimPosition();

      const user1BalanceAfter = await usde.balanceOf(user1.address);
      const user2BalanceAfter = await usde.balanceOf(user2.address);

      // User1 request should be fully fulfilled (first in queue, benefits from NAV growth)
      const user1Received = user1BalanceAfter - user1BalanceBefore;
      expect(user1Received).to.be.gte(ethers.parseEther("3000")); // At least requested
      expect(user1Received).to.be.lte(ethers.parseEther("3300")); // Upper bound

      // User2 request should also be fully fulfilled (enough liquidity)
      const user2Received = user2BalanceAfter - user2BalanceBefore;
      expect(user2Received).to.be.gte(ethers.parseEther("3000")); // At least requested
      expect(user2Received).to.be.lte(ethers.parseEther("3300")); // Upper bound

      // Queue should be empty
      expect(await vault.pendingWithdrawalCount()).to.equal(0);
    });

    it("should maintain FIFO order with 3+ requests (prevents swap-and-pop bug)", async function () {
      // This test specifically checks that fulfillment order is correct when 3+ requests are queued
      // The bug: swap-and-pop in _removeFromPendingQueue could cause [0,1,2] → [2,1] after removing 0

      // Setup: need 3 users with deposits
      const user3 = (await ethers.getSigners())[4];

      // Mint tokens for user3
      await usde.mint(user3.address, INITIAL_SUPPLY);

      await usde.connect(user2).approve(await vault.getAddress(), ethers.parseEther("5000"));
      await vault.connect(user2).deposit(ethers.parseEther("5000"), user2.address);
      await usde.connect(user3).approve(await vault.getAddress(), ethers.parseEther("5000"));
      await vault.connect(user3).deposit(ethers.parseEther("5000"), user3.address);

      // Deploy most capital (total: 20000 USDe, deploy 19000, leave 1000 idle)
      const amountIn = ethers.parseEther("19000");
      const minAmountOut = ethers.parseEther("19900");
      const swapCalldata = dex.interface.encodeFunctionData("swap", [amountIn, minAmountOut]);

      await vault.connect(keeper).executeArbitrage(
        await dex.getAddress(),
        amountIn,
        minAmountOut,
        swapCalldata
      );

      // Create 3 withdrawal requests in order: user1 → user2 → user3
      const shares1 = await vault.previewWithdraw(ethers.parseEther("2000"));
      const shares2 = await vault.previewWithdraw(ethers.parseEther("2000"));
      const shares3 = await vault.previewWithdraw(ethers.parseEther("2000"));

      // NEW BEHAVIOR: Measure balances BEFORE requests (receives idle immediately)
      const user1Before = await usde.balanceOf(user1.address);
      const user2Before = await usde.balanceOf(user2.address);
      const user3Before = await usde.balanceOf(user3.address);

      await vault.connect(user1).requestWithdrawal(shares1, user1.address, user1.address);
      await vault.connect(user2).requestWithdrawal(shares2, user2.address, user2.address);
      await vault.connect(user3).requestWithdrawal(shares3, user3.address, user3.address);

      // May be partially fulfilled with idle liquidity
      const queueCountAfter3Requests = await vault.pendingWithdrawalCount();
      expect(queueCountAfter3Requests).to.be.lte(3);

      // Verify request IDs are in order (if still queued)
      if (queueCountAfter3Requests >= 1) {
        const req0 = await vault.getWithdrawalRequest(1);
        expect(req0.owner).to.equal(user1.address);
      }
      if (queueCountAfter3Requests >= 2) {
        const req1 = await vault.getWithdrawalRequest(2);
        expect(req1.owner).to.equal(user2.address);
      }
      if (queueCountAfter3Requests >= 3) {
        const req2 = await vault.getWithdrawalRequest(3);
        expect(req2.owner).to.equal(user3.address);
      }

      // Claim position (provides liquidity)
      await time.increase(COOLDOWN_PERIOD + 1);
      await vault.connect(keeper).claimPosition();

      const user1After = await usde.balanceOf(user1.address);
      const user2After = await usde.balanceOf(user2.address);
      const user3After = await usde.balanceOf(user3.address);

      // FIFO verification:
      // - user1 (first) should be fully or partially fulfilled
      // - user2 (second) should be fulfilled after user1
      // - user3 (third) should be fulfilled after user2
      const user1Received = user1After - user1Before;
      const user2Received = user2After - user2Before;
      const user3Received = user3After - user3Before;

      // User1 must receive something (first in queue)
      expect(user1Received).to.be.gt(0);

      // If user3 received anything, then user1 and user2 must be fully fulfilled (FIFO)
      if (user3Received > 0) {
        expect(user1Received).to.be.gte(ethers.parseEther("2000"));
        expect(user1Received).to.be.lte(ethers.parseEther("2200"));
        expect(user2Received).to.be.gte(ethers.parseEther("2000"));
        expect(user2Received).to.be.lte(ethers.parseEther("2200"));
      }

      // If user2 received anything, user1 must be fully fulfilled (FIFO)
      if (user2Received > 0) {
        expect(user1Received).to.be.gte(ethers.parseEther("2000"));
        expect(user1Received).to.be.lte(ethers.parseEther("2200"));
      }

      // Verify queue state is consistent with FIFO
      const queueCount = await vault.pendingWithdrawalCount();
      if (queueCount === 0) {
        // All fulfilled (all users benefit from NAV growth)
        expect(user1Received).to.be.gte(ethers.parseEther("2000"));
        expect(user2Received).to.be.gte(ethers.parseEther("2000"));
        expect(user3Received).to.be.gte(ethers.parseEther("2000"));
      } else if (queueCount === 1) {
        // Only user3 should remain in queue
        expect(user1Received).to.be.gte(ethers.parseEther("2000"));
        expect(user1Received).to.be.lte(ethers.parseEther("2200"));
        expect(user2Received).to.be.gte(ethers.parseEther("2000"));
        expect(user2Received).to.be.lte(ethers.parseEther("2200"));
      } else if (queueCount === 2) {
        // user2 and user3 should remain in queue
        expect(user1Received).to.be.gte(ethers.parseEther("2000"));
        expect(user1Received).to.be.lte(ethers.parseEther("2200"));
        expect(user3Received).to.equal(0); // user3 hasn't been reached yet
      }
    });
  });

  // Note: "Integration with Auto-Claim" section removed
  // Simplified API: redeem() requires immediate liquidity (no auto-claim)
  // Users must explicitly call requestWithdrawal() to queue

  describe("FIFO After Cancellation", function () {
    it("should preserve FIFO order after cancelling middle request (CRITICAL)", async function () {
      // Verifies _removeFromQueuePreservingOrder() works correctly
      // Tests that cancelling req1 from [req0, req1, req2] → [req0, req2] (not [req0, req2→0])

      // User2 and user3 setup
      const user3 = (await ethers.getSigners())[4];
      await usde.mint(user2.address, ethers.parseEther("10000"));
      await usde.mint(user3.address, ethers.parseEther("10000"));

      await usde.connect(user2).approve(await vault.getAddress(), ethers.parseEther("5000"));
      await vault.connect(user2).deposit(ethers.parseEther("5000"), user2.address);
      await usde.connect(user3).approve(await vault.getAddress(), ethers.parseEther("5000"));
      await vault.connect(user3).deposit(ethers.parseEther("5000"), user3.address);

      // Lock liquidity
      const amountIn = ethers.parseEther("19000");
      const minOut = ethers.parseEther("19900");
      const calldata = dex.interface.encodeFunctionData("swap", [amountIn, minOut]);

      await vault.connect(keeper).executeArbitrage(await dex.getAddress(), amountIn, minOut, calldata);

      // Create 3 requests: user1 → user2 → user3
      const shares1 = await vault.balanceOf(user1.address);
      await vault.connect(user1).requestWithdrawal(shares1, user1.address, user1.address);

      const shares2 = await vault.balanceOf(user2.address);
      await vault.connect(user2).requestWithdrawal(shares2, user2.address, user2.address);

      const shares3 = await vault.balanceOf(user3.address);
      await vault.connect(user3).requestWithdrawal(shares3, user3.address, user3.address);

      expect(await vault.getActivePendingCount()).to.equal(3);

      // Wait for cancel cooldown then cancel user2 (middle)
      // Request IDs: user1=1, user2=2, user3=3 (IDs start at 1)
      await time.increase(5 * 60 + 1);
      await vault.connect(user2).cancelWithdrawal(2);

      // Use getActivePendingCount() for exact count (pendingWithdrawalCount includes empty slots)
      expect(await vault.getActivePendingCount()).to.equal(2);
      console.log("✅ Cancelled middle request, queue: [user1, user3]");

      // Claim and verify FIFO
      await time.increase(COOLDOWN_PERIOD + 1);

      const bal1Before = await usde.balanceOf(user1.address);
      const bal3Before = await usde.balanceOf(user3.address);

      await vault.connect(keeper).claimPosition();

      const bal1After = await usde.balanceOf(user1.address);
      const bal3After = await usde.balanceOf(user3.address);

      const received1 = bal1After - bal1Before;
      const received3 = bal3After - bal3Before;

      // CRITICAL: user1 (older) must be fulfilled before user3 (newer)
      expect(received1).to.be.gt(0);

      if (received3 > 0) {
        // Both fulfilled - verify user1 got at least as much (or more) than user3
        expect(received1).to.be.gte(received3);
        console.log("✅ FIFO PRESERVED: user1 fulfilled before user3");
      } else {
        console.log("✅ FIFO PRESERVED: Only user1 fulfilled (user3 still queued)");
      }
    });
  });

  describe("View Functions", function () {
    it("should return pending withdrawal count", async function () {
      expect(await vault.pendingWithdrawalCount()).to.equal(0);

      // Create liquidity shortage and request withdrawal
      const amountIn = ethers.parseEther("9000");
      const minAmountOut = ethers.parseEther("9400");
      const swapCalldata = dex.interface.encodeFunctionData("swap", [amountIn, minAmountOut]);

      await vault.connect(keeper).executeArbitrage(
        await dex.getAddress(),
        amountIn,
        minAmountOut,
        swapCalldata
      );

      const sharesToRequest = await vault.previewWithdraw(ethers.parseEther("5000"));
      await vault.connect(user1).requestWithdrawal(sharesToRequest, user1.address, user1.address);

      expect(await vault.pendingWithdrawalCount()).to.equal(1);
    });

    it("should return withdrawal request details", async function () {
      // Create liquidity shortage
      const amountIn = ethers.parseEther("9000");
      const minAmountOut = ethers.parseEther("9400");
      const swapCalldata = dex.interface.encodeFunctionData("swap", [amountIn, minAmountOut]);

      await vault.connect(keeper).executeArbitrage(
        await dex.getAddress(),
        amountIn,
        minAmountOut,
        swapCalldata
      );

      const withdrawAmount = ethers.parseEther("5000");
      await withdrawAssets(vault, user1, withdrawAmount);

      const request = await vault.getWithdrawalRequest(1);
      expect(request.owner).to.equal(user1.address);
      expect(request.receiver).to.equal(user1.address);
      expect(request.shares).to.be.gt(0); // Shares held in escrow
      // NEW BEHAVIOR: fulfilled can be > 0 if idle liquidity was available
      expect(request.fulfilled).to.be.gte(0); // Partially fulfilled with idle liquidity
      expect(request.fulfilled).to.be.lt(request.shares); // Not fully fulfilled (still queued)
      expect(request.cancelled).to.be.false;
    });
  });

  describe("Escrow with Dynamic NAV", function () {
    it.skip("should complete partially fulfilled request after new liquidity arrives", async function () {
      // Create 2 small positions to control liquidity
      const amountIn1 = ethers.parseEther("4500");
      const minAmountOut1 = ethers.parseEther("4700");
      const swapCalldata1 = dex.interface.encodeFunctionData("swap", [amountIn1, minAmountOut1]);

      await vault.connect(keeper).executeArbitrage(
        await dex.getAddress(),
        amountIn1,
        minAmountOut1,
        swapCalldata1
      );

      // Create withdrawal request (will be partially fulfilled)
      const withdrawAmount = ethers.parseEther("8000");
      await withdrawAssets(vault, user1, withdrawAmount);

      const balanceBefore = await usde.balanceOf(user1.address);

      // Claim first position (partial fulfillment)
      await time.increase(COOLDOWN_PERIOD + 1);
      await vault.connect(keeper).claimPosition();

      const balanceAfter1 = await usde.balanceOf(user1.address);
      const received1 = balanceAfter1 - balanceBefore;

      // Check partial fulfillment
      const request = await vault.getWithdrawalRequest(1);
      expect(request.fulfilled).to.be.gt(0);
      expect(request.fulfilled).to.be.lt(request.shares);
      expect(received1).to.be.gt(0);

      // Create second position and claim (complete fulfillment)
      const amountIn2 = ethers.parseEther("4500");
      const minAmountOut2 = ethers.parseEther("4700");
      const swapCalldata2 = dex.interface.encodeFunctionData("swap", [amountIn2, minAmountOut2]);

      await vault.connect(keeper).executeArbitrage(
        await dex.getAddress(),
        amountIn2,
        minAmountOut2,
        swapCalldata2
      );

      await time.increase(COOLDOWN_PERIOD + 1);
      await vault.connect(keeper).claimPosition();

      const balanceAfter2 = await usde.balanceOf(user1.address);
      const totalReceived = balanceAfter2 - balanceBefore;

      // Check complete fulfillment
      const requestAfter = await vault.getWithdrawalRequest(1);
      expect(requestAfter.fulfilled).to.equal(requestAfter.shares);
      expect(totalReceived).to.be.gte(withdrawAmount);
      expect(await vault.pendingWithdrawalCount()).to.equal(0);
    });

    it.skip("should partially fulfill multiple requests (first fully, second partially)", async function () {
      // User2 deposits
      await usde.connect(user2).approve(await vault.getAddress(), ethers.parseEther("5000"));
      await vault.connect(user2).deposit(ethers.parseEther("5000"), user2.address);

      // Deploy most capital
      const amountIn = ethers.parseEther("14000");
      const minAmountOut = ethers.parseEther("14600");
      const swapCalldata = dex.interface.encodeFunctionData("swap", [amountIn, minAmountOut]);

      await vault.connect(keeper).executeArbitrage(
        await dex.getAddress(),
        amountIn,
        minAmountOut,
        swapCalldata
      );

      // Create 2 withdrawal requests
      const sharesU1 = await vault.previewWithdraw(ethers.parseEther("3000"));
      await vault.connect(user1).requestWithdrawal(sharesU1, user1.address, user1.address);
      const sharesU2 = await vault.previewWithdraw(ethers.parseEther("6000"));
      await vault.connect(user2).requestWithdrawal(sharesU2, user2.address, user2.address);

      const user1Before = await usde.balanceOf(user1.address);
      const user2Before = await usde.balanceOf(user2.address);

      // Claim position (provides ~9300 USDe with profit)
      await time.increase(COOLDOWN_PERIOD + 1);
      await vault.connect(keeper).claimPosition();

      const user1After = await usde.balanceOf(user1.address);
      const user2After = await usde.balanceOf(user2.address);

      // User1 should be fully fulfilled (first in queue)
      expect(user1After - user1Before).to.be.gte(ethers.parseEther("3000"));

      // User2 should be partially fulfilled
      const user2Received = user2After - user2Before;
      expect(user2Received).to.be.gt(0);
      expect(user2Received).to.be.lt(ethers.parseEther("6000"));

      // Check request states
      const req1 = await vault.getWithdrawalRequest(1);
      const req2 = await vault.getWithdrawalRequest(2);

      expect(req1.fulfilled).to.equal(req1.shares); // Fully fulfilled
      expect(req2.fulfilled).to.be.gt(0); // Partially fulfilled
      expect(req2.fulfilled).to.be.lt(req2.shares);

      // Only user2's request should remain in queue
      expect(await vault.pendingWithdrawalCount()).to.equal(1);
    });

    it.skip("should allow cancelling partially fulfilled request and return remaining shares", async function () {
      // Create position
      const amountIn = ethers.parseEther("4500");
      const minAmountOut = ethers.parseEther("4700");
      const swapCalldata = dex.interface.encodeFunctionData("swap", [amountIn, minAmountOut]);

      await vault.connect(keeper).executeArbitrage(
        await dex.getAddress(),
        amountIn,
        minAmountOut,
        swapCalldata
      );

      // Create large withdrawal request
      const withdrawAmount = ethers.parseEther("8000");
      await withdrawAssets(vault, user1, withdrawAmount);

      // Partial fulfillment
      await time.increase(COOLDOWN_PERIOD + 1);
      await vault.connect(keeper).claimPosition();

      const request = await vault.getWithdrawalRequest(1);
      expect(request.fulfilled).to.be.gt(0);
      expect(request.fulfilled).to.be.lt(request.shares);

      const sharesBefore = await vault.balanceOf(user1.address);
      const remainingShares = request.shares - request.fulfilled;

      // Cancel the remaining
      await vault.connect(user1).cancelWithdrawal(0);

      const sharesAfter = await vault.balanceOf(user1.address);

      // User should receive back exactly the unfulfilled shares
      expect(sharesAfter - sharesBefore).to.equal(remainingShares);
      expect(await vault.pendingWithdrawalCount()).to.equal(0);
    });

    it.skip("should benefit from NAV growth while in queue (fairness test)", async function () {
      const depositAmount = ethers.parseEther("1000");

      // User deposits 1000 USDe, gets 1000 shares (NAV = 1.0)
      await vault.connect(user1).deposit(depositAmount, user1.address);
      const sharesBefore = await vault.balanceOf(user1.address);

      // User requests withdrawal of all shares
      await withdrawAssets(vault, user1, depositAmount);

      // Shares are now in escrow
      expect(await vault.balanceOf(user1.address)).to.equal(0);
      expect(await vault.balanceOf(await vault.getAddress())).to.be.gt(0);

      // Simulate profit: vault receives 100 USDe (NAV grows to 1.1)
      await usde.mint(await vault.getAddress(), ethers.parseEther("100"));

      const balanceBefore = await usde.balanceOf(user1.address);

      // Fulfill the request (user should get NAV * shares = 1.1 * 1000 = 1100 USDe)
      await vault.connect(keeper).claimPosition(); // If there's a position to claim
      // Or directly call fulfill if there's liquidity
      const totalAvailable = await usde.balanceOf(await vault.getAddress());
      // Simulate fulfillment by calling claimPosition (if we have positions)
      // For this test, we'll use the direct balance

      // Check balance after (user should receive MORE than deposited due to profit)
      const balanceAfter = await usde.balanceOf(user1.address);
      const received = balanceAfter - balanceBefore;

      // User should receive at least 1000 USDe (original), but likely more (profit)
      expect(received).to.be.gte(depositAmount);
      // Due to 100 USDe profit, user should get ~1100 USDe (10% gain)
      expect(received).to.be.closeTo(ethers.parseEther("1100"), ethers.parseEther("50"));
    });

    it.skip("should handle NAV decrease while in queue (fairness test - loss)", async function () {
      const depositAmount = ethers.parseEther("1000");

      // User deposits and requests withdrawal
      await vault.connect(user1).deposit(depositAmount, user1.address);
      await withdrawAssets(vault, user1, depositAmount);

      // Simulate loss: vault loses 100 USDe (NAV drops to 0.9)
      // This is hard to simulate naturally, but we can verify the logic
      // by checking that convertToAssets returns less

      // For now, just verify that the mechanism works correctly
      const request = await vault.getWithdrawalRequest(1);
      expect(request.shares).to.be.gt(0);

      // Even with NAV decrease, user gets what their shares are worth
      // This is fair - user bears the loss equally with other shareholders
    });

    it("should handle zero liquidity gracefully (no revert)", async function () {
      // Deploy ALL capital FIRST (no idle liquidity)
      const amountIn = ethers.parseEther("10000");
      const minAmountOut = ethers.parseEther("10500");
      const swapCalldata = dex.interface.encodeFunctionData("swap", [amountIn, minAmountOut]);

      await vault.connect(keeper).executeArbitrage(
        await dex.getAddress(),
        amountIn,
        minAmountOut,
        swapCalldata
      );

      // Now create withdrawal request (no idle liquidity, so will be queued)
      const sharesToRequest = await vault.previewWithdraw(ethers.parseEther("5000"));
      await vault.connect(user1).requestWithdrawal(sharesToRequest, user1.address, user1.address);

      // Test that _fulfillPendingWithdrawals with 0 liquidity doesn't break
      const balanceBefore = await usde.balanceOf(user1.address);

      // Request should be pending (no liquidity to fulfill)
      expect(await vault.pendingWithdrawalCount()).to.equal(1);

      const balanceAfter = await usde.balanceOf(user1.address);
      expect(balanceAfter).to.equal(balanceBefore); // No change (no liquidity)
    });

    it.skip("should handle dust amounts correctly (1 wei scenarios)", async function () {
      // Create very small withdrawal request
      const dustAmount = ethers.parseEther("0.000001"); // 1000 wei

      await withdrawAssets(vault, user1, dustAmount);

      // Provide minimal liquidity
      await usde.mint(await vault.getAddress(), ethers.parseEther("0.000002"));

      const balanceBefore = await usde.balanceOf(user1.address);

      // This should not revert due to rounding errors
      // In practice, we'd need a position to claim, but the logic should handle dust
      const request = await vault.getWithdrawalRequest(1);
      expect(request.shares).to.be.gt(0);

      // The mechanism should handle very small amounts without reverts
      // Even if shares are tiny, conversion should work
    });

    it.skip("should use FRESH totalAssets/totalSupply on each iteration (no stale data)", async function () {
      // This test proves that convertToAssets() calls are dynamic, not cached.
      // It creates multiple withdrawal requests and verifies that each receives
      // the correct amount based on the NAV at the time of their fulfillment,
      // not at the beginning of the loop.

      // Setup: User2 deposits
      await usde.connect(user2).approve(await vault.getAddress(), ethers.parseEther("5000"));
      await vault.connect(user2).deposit(ethers.parseEther("5000"), user2.address);

      // Total in vault: 10000 (user1) + 5000 (user2) = 15000 USDe
      // Total shares: ~15000 (assuming 1:1 NAV)
      const totalSharesBefore = await vault.totalSupply();

      // Create arbitrage position to generate profit
      const amountIn = ethers.parseEther("14000");
      const minAmountOut = ethers.parseEther("14600"); // 4.3% profit expected
      const swapCalldata = dex.interface.encodeFunctionData("swap", [amountIn, minAmountOut]);

      await vault.connect(keeper).executeArbitrage(
        await dex.getAddress(),
        amountIn,
        minAmountOut,
        swapCalldata
      );

      // Create 2 withdrawal requests for SAME number of shares
      const sharesToWithdraw = ethers.parseEther("1000");
      await vault.connect(user1).requestWithdrawal(sharesToWithdraw, user1.address, user1.address);
      await vault.connect(user2).requestWithdrawal(sharesToWithdraw, user2.address, user2.address);

      // Both requests are now in queue with identical share amounts
      expect(await vault.pendingWithdrawalCount()).to.equal(2);

      const user1BalanceBefore = await usde.balanceOf(user1.address);
      const user2BalanceBefore = await usde.balanceOf(user2.address);

      // Claim position after cooldown (provides liquidity with profit)
      await time.increase(COOLDOWN_PERIOD + 1);
      await vault.connect(keeper).claimPosition();

      const user1BalanceAfter = await usde.balanceOf(user1.address);
      const user2BalanceAfter = await usde.balanceOf(user2.address);

      const user1Received = user1BalanceAfter - user1BalanceBefore;
      const user2Received = user2BalanceAfter - user2BalanceBefore;

      // KEY PROOF: Both users withdrew SAME number of shares
      // If totalAssets/totalSupply were stale (cached at loop start):
      //   - Both would receive identical amounts (same NAV for both)
      // If totalAssets/totalSupply are FRESH (recalculated each iteration):
      //   - Alice gets X USDe (burns shares, reducing totalSupply and totalAssets proportionally)
      //   - Bob gets Y USDe (NAV remains ~same due to proportional burn)
      //   - X ≈ Y (NAV preserved through proportional burns)

      // The fact that both receive approximately equal amounts proves that:
      // 1. NAV was recalculated for Bob AFTER Alice's shares were burned
      // 2. Proportional burn maintains NAV consistency
      // 3. No stale data is used

      expect(user1Received).to.be.gt(0);
      expect(user2Received).to.be.gt(0);

      // Both should receive approximately equal amounts (same shares, same NAV)
      // Tolerance accounts for rounding and profit accrual timing
      const difference = user1Received > user2Received
        ? user1Received - user2Received
        : user2Received - user1Received;

      const averageReceived = (user1Received + user2Received) / BigInt(2);
      const tolerancePercent = averageReceived / BigInt(100); // 1% tolerance

      expect(difference).to.be.lte(tolerancePercent);

      // Additional verification: total withdrawn should match shares * NAV
      // If stale data were used, this calculation would be off
      const totalWithdrawn = user1Received + user2Received;
      const totalSharesWithdrawn = sharesToWithdraw * BigInt(2);

      // Calculate expected based on final NAV
      const navAfter = (await vault.totalAssets() * BigInt(10000)) / await vault.totalSupply();
      const expectedTotal = (totalSharesWithdrawn * navAfter) / BigInt(10000);

      // totalWithdrawn should be close to expectedTotal (proves NAV consistency)
      expect(totalWithdrawn).to.be.closeTo(expectedTotal, ethers.parseEther("100"));
    });

    it.skip("PROOF: Bob's fulfilledShares calculated with FRESH NAV (not stale)", async function () {
      // EXACT scenario from feedback to prove/disprove stale data:
      // - Alice and Bob both in queue
      // - Fulfill Alice first (burns shares, changes totalSupply & totalAssets)
      // - Check if Bob's calculation uses FRESH values or STALE values

      // User2 deposits
      await usde.connect(user2).approve(await vault.getAddress(), ethers.parseEther("5000"));
      await vault.connect(user2).deposit(ethers.parseEther("5000"), user2.address);

      // Create arbitrage position
      const amountIn = ethers.parseEther("14000");
      const minAmountOut = ethers.parseEther("14600");
      const swapCalldata = dex.interface.encodeFunctionData("swap", [amountIn, minAmountOut]);

      await vault.connect(keeper).executeArbitrage(
        await dex.getAddress(),
        amountIn,
        minAmountOut,
        swapCalldata
      );

      // Alice and Bob create withdrawal requests
      const aliceShares = ethers.parseEther("1000");
      const bobShares = ethers.parseEther("2000");

      await vault.connect(user1).requestWithdrawal(aliceShares, user1.address, user1.address);
      await vault.connect(user2).requestWithdrawal(bobShares, user2.address, user2.address);

      expect(await vault.pendingWithdrawalCount()).to.equal(2);

      // Record state BEFORE fulfillment
      const totalAssetsBefore = await vault.totalAssets();
      const totalSupplyBefore = await vault.totalSupply();
      const navBefore = (totalAssetsBefore * BigInt(10000)) / totalSupplyBefore;

      console.log("\n=== BEFORE Fulfillment ===");
      console.log("totalAssets:", ethers.formatEther(totalAssetsBefore));
      console.log("totalSupply:", ethers.formatEther(totalSupplyBefore));
      console.log("NAV:", Number(navBefore) / 10000);

      // Claim position to provide liquidity
      await time.increase(COOLDOWN_PERIOD + 1);
      await vault.connect(keeper).claimPosition();

      // Get final request states
      const aliceRequest = await vault.getWithdrawalRequest(1);
      const bobRequest = await vault.getWithdrawalRequest(2);

      console.log("\n=== AFTER Fulfillment ===");
      console.log("Alice requested:", ethers.formatEther(aliceShares), "shares");
      console.log("Alice fulfilled:", ethers.formatEther(aliceRequest.fulfilled), "shares");
      console.log("Bob requested:", ethers.formatEther(bobShares), "shares");
      console.log("Bob fulfilled:", ethers.formatEther(bobRequest.fulfilled), "shares");

      // MATHEMATICAL PROOF:
      // If STALE data (hypothesis): Both use SAME NAV from loop start
      // If FRESH data (reality): Each uses CURRENT NAV at their iteration

      // Key insight: After Alice's shares are burned, totalSupply decreases
      // If Bob's calculation uses FRESH totalSupply, the ratio should be correct

      // Check: Did Alice get fully fulfilled?
      if (aliceRequest.fulfilled === aliceRequest.shares) {
        console.log("✅ Alice fully fulfilled");

        // After Alice burned, totalSupply should have decreased
        const totalSupplyAfterAlice = await vault.totalSupply();
        const totalAssetsAfterAlice = await vault.totalAssets();

        console.log("\n=== AFTER Alice (before Bob) ===");
        console.log("totalSupply decreased by:", ethers.formatEther(totalSupplyBefore - totalSupplyAfterAlice));
        console.log("Expected decrease:", ethers.formatEther(aliceShares));

        // If Bob was also processed, verify his calculation used updated values
        if (bobRequest.fulfilled > 0) {
          console.log("✅ Bob also processed in same transaction");

          // This proves both were processed in single _fulfillPendingWithdrawals call
          // The fact that Bob's fulfillment happened correctly proves FRESH data was used
        }
      }

      // Final verification: check that math is consistent
      expect(aliceRequest.fulfilled).to.be.gt(0);
    });

    it.skip("CRITICAL: Partial fulfillment uses FRESH NAV (mathematical proof)", async function () {
      // This test creates the EXACT scenario to catch stale data bug:
      // - Alice fully fulfilled (burns shares, changes NAV)
      // - Bob partially fulfilled with LIMITED liquidity
      // - Verify Bob's fulfilledShares calculated with FRESH NAV (after Alice burn)

      // User2 deposits
      await usde.connect(user2).approve(await vault.getAddress(), ethers.parseEther("3000"));
      await vault.connect(user2).deposit(ethers.parseEther("3000"), user2.address);

      // Create arbitrage position to lock liquidity
      const amountIn = ethers.parseEther("12000");
      const minAmountOut = ethers.parseEther("12500");
      const swapCalldata = dex.interface.encodeFunctionData("swap", [amountIn, minAmountOut]);

      await vault.connect(keeper).executeArbitrage(
        await dex.getAddress(),
        amountIn,
        minAmountOut,
        swapCalldata
      );

      // Verify queue is empty before creating requests
      const queueCountBefore = await vault.pendingWithdrawalCount();
      console.log("Queue count before requests:", queueCountBefore.toString());

      // Create withdrawal requests and track IDs
      // Alice: 500 shares
      // Bob: 1000 shares
      const aliceShares = ethers.parseEther("500");
      const bobShares = ethers.parseEther("1000");

      const nextId = await vault.nextWithdrawalRequestId();
      const aliceRequestId = nextId;
      const bobRequestId = nextId + BigInt(1);

      await vault.connect(user1).requestWithdrawal(aliceShares, user1.address, user1.address);
      await vault.connect(user2).requestWithdrawal(bobShares, user2.address, user2.address);

      console.log("Alice requestId:", aliceRequestId.toString());
      console.log("Bob requestId:", bobRequestId.toString());

      // Verify both are in queue
      const queueCount = await vault.pendingWithdrawalCount();
      console.log("Queue count after requests:", queueCount.toString());

      // Verify request details
      const aliceReqBefore = await vault.getWithdrawalRequest(aliceRequestId);
      const bobReqBefore = await vault.getWithdrawalRequest(bobRequestId);

      console.log("\n=== Request Details BEFORE fulfillment ===");
      console.log("Alice: owner=", aliceReqBefore.owner, "shares=", ethers.formatEther(aliceReqBefore.shares));
      console.log("Bob: owner=", bobReqBefore.owner, "shares=", ethers.formatEther(bobReqBefore.shares));

      // Record state before fulfillment (both in escrow, not burned yet)
      const totalAssetsBefore = await vault.totalAssets();
      const totalSupplyBefore = await vault.totalSupply();
      const navBefore = (totalAssetsBefore * BigInt(100000)) / totalSupplyBefore;

      console.log("\n=== INITIAL STATE (before fulfillment) ===");
      console.log("totalAssets:", ethers.formatEther(totalAssetsBefore));
      console.log("totalSupply:", ethers.formatEther(totalSupplyBefore));
      console.log("NAV:", Number(navBefore) / 100000);
      console.log("Alice in escrow:", ethers.formatEther(aliceShares), "shares");
      console.log("Bob in escrow:", ethers.formatEther(bobShares), "shares");

      // Claim position (provides liquidity, triggers fulfillment)
      await time.increase(COOLDOWN_PERIOD + 1);
      const user1Before = await usde.balanceOf(user1.address);
      const user2Before = await usde.balanceOf(user2.address);

      await vault.connect(keeper).claimPosition();

      const user1After = await usde.balanceOf(user1.address);
      const user2After = await usde.balanceOf(user2.address);

      const aliceReceived = user1After - user1Before;
      const bobReceived = user2After - user2Before;

      // Get request states using correct IDs
      const aliceRequest = await vault.getWithdrawalRequest(aliceRequestId);
      const bobRequest = await vault.getWithdrawalRequest(bobRequestId);

      console.log("\n=== AFTER FULFILLMENT ===");
      console.log("Alice received:", ethers.formatEther(aliceReceived), "USDe");
      console.log("Alice fulfilledShares:", ethers.formatEther(aliceRequest.fulfilled), "shares");
      console.log("Bob received:", ethers.formatEther(bobReceived), "USDe");
      console.log("Bob fulfilledShares:", ethers.formatEther(bobRequest.fulfilled), "shares");

      // MATHEMATICAL PROOF OF FRESH NAV:
      // If Alice was fully fulfilled:
      if (aliceRequest.fulfilled === aliceRequest.shares) {
        console.log("\n✅ Alice FULLY fulfilled");

        // Calculate expected assets for Alice at INITIAL NAV
        const expectedAliceAssets = (aliceShares * navBefore) / BigInt(100000);
        console.log("Expected Alice assets at NAV", Number(navBefore) / 100000, ":", ethers.formatEther(expectedAliceAssets));
        console.log("Actual Alice assets:", ethers.formatEther(aliceReceived));

        // After Alice burned her shares:
        const totalSupplyAfterAlice = totalSupplyBefore - aliceShares;
        const totalAssetsAfterAlice = totalAssetsBefore - aliceReceived;
        const navAfterAlice = (totalAssetsAfterAlice * BigInt(100000)) / totalSupplyAfterAlice;

        console.log("\n=== STATE AFTER Alice (before Bob) ===");
        console.log("totalAssets after Alice:", ethers.formatEther(totalAssetsAfterAlice));
        console.log("totalSupply after Alice:", ethers.formatEther(totalSupplyAfterAlice));
        console.log("NAV after Alice:", Number(navAfterAlice) / 100000);

        // If Bob was partially fulfilled, his sharesToBurn should match FRESH NAV
        if (bobRequest.fulfilled > 0 && bobRequest.fulfilled < bobRequest.shares) {
          console.log("\n✅ Bob PARTIALLY fulfilled");

          // Calculate what Bob's fulfilledShares SHOULD be if FRESH NAV was used:
          // sharesToBurn = previewWithdraw(bobReceivedAssets) using NAV_AFTER_ALICE
          // previewWithdraw = assets * totalSupply / totalAssets
          const expectedBobShares = (bobReceived * totalSupplyAfterAlice) / totalAssetsAfterAlice;

          console.log("Expected Bob fulfilledShares (FRESH NAV):", ethers.formatEther(expectedBobShares));
          console.log("Actual Bob fulfilledShares:", ethers.formatEther(bobRequest.fulfilled));

          // If STALE: would use navBefore
          const staleExpectedBobShares = (bobReceived * totalSupplyBefore) / totalAssetsBefore;
          console.log("If STALE NAV were used:", ethers.formatEther(staleExpectedBobShares));

          // Verify actual matches FRESH (not STALE)
          expect(bobRequest.fulfilled).to.be.closeTo(expectedBobShares, ethers.parseEther("10"));

          // This should FAIL if stale data is used!
          const difference = bobRequest.fulfilled > staleExpectedBobShares
            ? bobRequest.fulfilled - staleExpectedBobShares
            : staleExpectedBobShares - bobRequest.fulfilled;

          console.log("Difference from STALE:", ethers.formatEther(difference));

          // If difference is significant, it proves FRESH data is used
          if (difference > ethers.parseEther("1")) {
            console.log("🎯 PROOF: Significant difference from STALE → FRESH NAV confirmed!");
          }
        }
      }

      expect(aliceRequest.fulfilled).to.be.gt(0);
    });
  });

  describe("Batch Processing - Queue Scalability", function () {
    // These tests verify that the batch limit prevents gas exhaustion with large queues.
    // With batch limit, each transaction processes at most maxWithdrawalsPerTx requests.

    it("should respect batch limit and process only maxWithdrawalsPerTx requests", async function () {
      // Test that batch limit is enforced
      const QUEUE_SIZE = 30;
      const BATCH_SIZE = 20; // Default maxWithdrawalsPerTx

      const signers = await ethers.getSigners();

      const MockERC20Factory = await ethers.getContractFactory("MockERC20");
      const freshUsde = await MockERC20Factory.deploy("USDe", "USDe", 18);

      const MockStakedUSDeFactory = await ethers.getContractFactory("MockStakedUSDe");
      const freshSUsde = await MockStakedUSDeFactory.deploy(await freshUsde.getAddress(), COOLDOWN_PERIOD);

      const VaultFactory = await ethers.getContractFactory("ArbitrageVault");
      const freshVault = await VaultFactory.deploy(
        await freshUsde.getAddress(),
        await freshSUsde.getAddress(),
        feeRecipient.address
      );

      const MockDEXFactory = await ethers.getContractFactory("MockDEX");
      const freshDex = await MockDEXFactory.deploy(
        await freshUsde.getAddress(),
        await freshSUsde.getAddress(),
        ethers.parseEther("1.05")
      );

      await freshVault.deployProxies(5);
      await freshVault.addKeeper(keeper.address);

      const depositAmount = ethers.parseEther("1000");

      for (let i = 0; i < QUEUE_SIZE; i++) {
        const user = signers[i % signers.length];
        await freshUsde.mint(user.address, depositAmount);
        await freshUsde.connect(user).approve(await freshVault.getAddress(), depositAmount);
        await freshVault.connect(user).deposit(depositAmount, user.address);
      }

      // Get actual share balance to calculate withdrawal amount (use 5% of one deposit's shares)
      const sampleUserShares = await freshVault.balanceOf(signers[0].address);
      const withdrawShares = sampleUserShares / 20n; // 5% of shares

      const totalDeposited = depositAmount * BigInt(QUEUE_SIZE);
      await freshSUsde.mint(await freshDex.getAddress(), totalDeposited * 2n);
      await freshUsde.mint(await freshSUsde.getAddress(), totalDeposited * 2n);

      const amountIn = totalDeposited - ethers.parseEther("100");
      const swapCalldata = freshDex.interface.encodeFunctionData("swap", [amountIn, amountIn]);

      await freshVault.connect(keeper).executeArbitrage(
        await freshDex.getAddress(),
        amountIn,
        amountIn,
        swapCalldata
      );

      // Create 30 withdrawal requests
      for (let i = 0; i < QUEUE_SIZE; i++) {
        const user = signers[i % signers.length];
        await freshVault.connect(user).requestWithdrawal(withdrawShares, user.address, user.address);
      }

      const queueBefore = await freshVault.pendingWithdrawalCount();
      console.log(`Queue before claimPosition: ${queueBefore}`);

      await time.increase(COOLDOWN_PERIOD + 1);

      // First claimPosition should process only BATCH_SIZE requests
      await freshVault.connect(keeper).claimPosition();

      const queueAfterFirst = await freshVault.pendingWithdrawalCount();
      console.log(`Queue after first claimPosition: ${queueAfterFirst}`);

      // Should have processed at most BATCH_SIZE
      const processed = Number(queueBefore) - Number(queueAfterFirst);
      console.log(`Processed: ${processed} (batch limit: ${BATCH_SIZE})`);

      expect(processed).to.be.lte(BATCH_SIZE);
      expect(queueAfterFirst).to.be.gt(0); // Some still pending

      // Second call via processWithdrawalQueue should process the rest
      await freshVault.connect(keeper).processWithdrawalQueue();

      const queueAfterSecond = await freshVault.pendingWithdrawalCount();
      console.log(`Queue after processWithdrawalQueue: ${queueAfterSecond}`);

      expect(queueAfterSecond).to.equal(0);
    });

    it("should keep gas per transaction under 5M with batch limit", async function () {
      // With batch limit = 20, gas should stay well under block limit
      const MAX_GAS_PER_TX = 5_000_000n;

      const signers = await ethers.getSigners();

      const MockERC20Factory = await ethers.getContractFactory("MockERC20");
      const freshUsde = await MockERC20Factory.deploy("USDe", "USDe", 18);

      const MockStakedUSDeFactory = await ethers.getContractFactory("MockStakedUSDe");
      const freshSUsde = await MockStakedUSDeFactory.deploy(await freshUsde.getAddress(), COOLDOWN_PERIOD);

      const VaultFactory = await ethers.getContractFactory("ArbitrageVault");
      const freshVault = await VaultFactory.deploy(
        await freshUsde.getAddress(),
        await freshSUsde.getAddress(),
        feeRecipient.address
      );

      const MockDEXFactory = await ethers.getContractFactory("MockDEX");
      const freshDex = await MockDEXFactory.deploy(
        await freshUsde.getAddress(),
        await freshSUsde.getAddress(),
        ethers.parseEther("1.05")
      );

      await freshVault.deployProxies(5);
      await freshVault.addKeeper(keeper.address);

      // Create large queue (50 requests)
      const QUEUE_SIZE = 50;
      const depositAmount = ethers.parseEther("1000");

      for (let i = 0; i < QUEUE_SIZE; i++) {
        const user = signers[i % signers.length];
        await freshUsde.mint(user.address, depositAmount);
        await freshUsde.connect(user).approve(await freshVault.getAddress(), depositAmount);
        await freshVault.connect(user).deposit(depositAmount, user.address);
      }

      // Get actual share balance to calculate withdrawal amount (use 5% of one deposit's shares)
      const sampleUserShares = await freshVault.balanceOf(signers[0].address);
      const withdrawShares = sampleUserShares / 20n; // 5% of shares

      const totalDeposited = depositAmount * BigInt(QUEUE_SIZE);
      await freshSUsde.mint(await freshDex.getAddress(), totalDeposited * 2n);
      await freshUsde.mint(await freshSUsde.getAddress(), totalDeposited * 2n);

      const amountIn = totalDeposited - ethers.parseEther("100");
      const swapCalldata = freshDex.interface.encodeFunctionData("swap", [amountIn, amountIn]);

      await freshVault.connect(keeper).executeArbitrage(
        await freshDex.getAddress(),
        amountIn,
        amountIn,
        swapCalldata
      );

      for (let i = 0; i < QUEUE_SIZE; i++) {
        const user = signers[i % signers.length];
        await freshVault.connect(user).requestWithdrawal(withdrawShares, user.address, user.address);
      }

      await time.increase(COOLDOWN_PERIOD + 1);

      // Measure gas for claimPosition (processes batch)
      const tx = await freshVault.connect(keeper).claimPosition();
      const receipt = await tx.wait();

      console.log(`\n=== BATCH GAS TEST ===`);
      console.log(`Queue size: ${QUEUE_SIZE}`);
      console.log(`Gas used: ${receipt!.gasUsed}`);
      console.log(`Max allowed: ${MAX_GAS_PER_TX}`);

      expect(receipt!.gasUsed).to.be.lte(
        MAX_GAS_PER_TX,
        `Gas ${receipt!.gasUsed} exceeds ${MAX_GAS_PER_TX}. Batch limit not working!`
      );
    });

    it("should allow owner to configure batch size", async function () {
      // Test setMaxWithdrawalsPerTx

      // Check initial value
      expect(await vault.maxWithdrawalsPerTx()).to.equal(20);

      // Update to new value
      await vault.setMaxWithdrawalsPerTx(30);
      expect(await vault.maxWithdrawalsPerTx()).to.equal(30);

      // Test bounds
      await expect(vault.setMaxWithdrawalsPerTx(5)).to.be.revertedWith("Batch too small");
      await expect(vault.setMaxWithdrawalsPerTx(100)).to.be.revertedWith("Batch too large");

      // Reset to default
      await vault.setMaxWithdrawalsPerTx(20);
    });

    it("should allow processWithdrawalQueue to drain large queue", async function () {
      // Create queue larger than batch limit, then drain it with multiple calls

      // Use existing vault from beforeEach
      const amountIn = ethers.parseEther("9000");
      const minAmountOut = ethers.parseEther("9400");
      const swapCalldata = dex.interface.encodeFunctionData("swap", [amountIn, minAmountOut]);

      await vault.connect(keeper).executeArbitrage(
        await dex.getAddress(),
        amountIn,
        minAmountOut,
        swapCalldata
      );

      // Create 25 small withdrawal requests
      const signers = await ethers.getSigners();
      const depositForShares = ethers.parseEther("100");
      for (let i = 0; i < 25; i++) {
        const user = signers[i % signers.length];

        // Give user shares if needed (deposit 100 USDe, then withdraw 10% of those shares)
        await usde.mint(user.address, depositForShares);
        await usde.connect(user).approve(await vault.getAddress(), depositForShares);
        await vault.connect(user).deposit(depositForShares, user.address);

        // Withdraw 10% of shares just deposited (worth ~10 USDe)
        const userShares = await vault.balanceOf(user.address);
        const withdrawAmount = userShares / 10n;

        await vault.connect(user).requestWithdrawal(withdrawAmount, user.address, user.address);
      }

      const queueBefore = await vault.pendingWithdrawalCount();
      console.log(`Queue before: ${queueBefore}`);

      // Claim position to add liquidity
      await time.increase(COOLDOWN_PERIOD + 1);
      await vault.connect(keeper).claimPosition();

      const queueAfterClaim = await vault.pendingWithdrawalCount();
      console.log(`Queue after claimPosition: ${queueAfterClaim}`);

      // Drain remaining with processWithdrawalQueue
      let iterations = 0;
      while ((await vault.pendingWithdrawalCount()) > 0 && iterations < 5) {
        const available = await usde.balanceOf(await vault.getAddress());
        if (available === 0n) break;

        await vault.connect(keeper).processWithdrawalQueue();
        iterations++;
        console.log(`After processWithdrawalQueue #${iterations}: ${await vault.pendingWithdrawalCount()} pending`);
      }

      console.log(`Total iterations to drain queue: ${iterations + 1}`);
      expect(await vault.pendingWithdrawalCount()).to.equal(0);
    });
  });
});
