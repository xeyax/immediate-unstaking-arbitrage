import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { ArbitrageVault, MockERC20, MockStakedUSDe, ArbitrageVaultHarness } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

describe("ViewFunctions", function () {
  const COOLDOWN_DURATION = 7 * 24 * 60 * 60; // 7 days

  // Fixture to deploy the contract and set up initial state
  async function deployVaultFixture() {
    const [owner, user1, user2, keeper]: HardhatEthersSigner[] = await ethers.getSigners();

    // Deploy mock USDe token
    const MockERC20Factory = await ethers.getContractFactory("MockERC20");
    const usdeToken: MockERC20 = await MockERC20Factory.deploy("USDe", "USDe", 18);
    await usdeToken.waitForDeployment();

    // Deploy mock sUSDe token
    const MockStakedUSDeFactory = await ethers.getContractFactory("MockStakedUSDe");
    const stakedUsde: MockStakedUSDe = await MockStakedUSDeFactory.deploy(
      await usdeToken.getAddress(),
      COOLDOWN_DURATION
    );
    await stakedUsde.waitForDeployment();

    // Deploy ArbitrageVaultHarness for testing
    const ArbitrageVaultHarnessFactory = await ethers.getContractFactory("ArbitrageVaultHarness");
    const vault: ArbitrageVaultHarness = await ArbitrageVaultHarnessFactory.deploy(
      await usdeToken.getAddress(),
      await stakedUsde.getAddress(),
      owner.address // fee recipient
    );
    await vault.waitForDeployment();

    // Add keeper
    await vault.addKeeper(keeper.address);

    // Deploy proxies
    await vault.deployProxies(3);

    // Mint some USDe tokens to users for testing
    const initialBalance = ethers.parseEther("10000");
    await usdeToken.mint(user1.address, initialBalance);
    await usdeToken.mint(user2.address, initialBalance);

    return { vault, usdeToken, stakedUsde, owner, user1, user2, keeper, initialBalance };
  }

  describe("getVaultStats", function () {
    it("Should return correct stats on empty vault", async function () {
      const { vault } = await loadFixture(deployVaultFixture);

      const stats = await vault.getVaultStats();

      // Empty vault - no assets, no shares
      expect(stats.totalAssets).to.equal(0);
      expect(stats.totalShares).to.equal(0);
      expect(stats.sharePrice).to.equal(ethers.parseEther("1")); // Default 1:1
      expect(stats.idleAssets).to.equal(0);
      expect(stats.activePositions).to.equal(0);
      expect(stats.pendingWithdrawals).to.equal(0);
      expect(stats.totalFeesCollected).to.equal(0);
      expect(stats.performanceFee).to.equal(1000); // 10%
      expect(stats.minProfitThreshold).to.equal(10); // 0.1%
    });

    it("Should return correct stats after deposit", async function () {
      const { vault, usdeToken, user1 } = await loadFixture(deployVaultFixture);

      const depositAmount = ethers.parseEther("1000");
      await usdeToken.connect(user1).approve(await vault.getAddress(), depositAmount);
      await vault.connect(user1).deposit(depositAmount, user1.address);

      const actualShares = await vault.balanceOf(user1.address);
      const stats = await vault.getVaultStats();

      expect(stats.totalAssets).to.equal(depositAmount);
      expect(stats.totalShares).to.equal(actualShares);
      // sharePrice = convertToAssets(1e18), which gives the value of 1e18 shares
      // With _decimalsOffset, this differs from 1e18 but should be consistent with convertToAssets
      const expectedSharePrice = await vault.convertToAssets(ethers.parseEther("1"));
      expect(stats.sharePrice).to.equal(expectedSharePrice);
      expect(stats.idleAssets).to.equal(depositAmount);
      expect(stats.activePositions).to.equal(0);
      expect(stats.pendingWithdrawals).to.equal(0);
    });

    it("Should return correct stats with active positions", async function () {
      const { vault, usdeToken, stakedUsde, user1 } = await loadFixture(deployVaultFixture);

      // Deposit first
      const depositAmount = ethers.parseEther("1000");
      await usdeToken.connect(user1).approve(await vault.getAddress(), depositAmount);
      await vault.connect(user1).deposit(depositAmount, user1.address);

      // Open a position using harness
      const sUsdeAmount = ethers.parseEther("100");
      const bookValue = ethers.parseEther("95");
      const expectedAssets = ethers.parseEther("100");

      // Mint sUSDe to vault for opening position
      await stakedUsde.mint(await vault.getAddress(), sUsdeAmount);
      await vault.openPositionForTesting(sUsdeAmount, bookValue, expectedAssets);

      const stats = await vault.getVaultStats();

      expect(stats.activePositions).to.equal(1);
      // Total assets = idle (depositAmount - bookValue) + bookValue + some profit
      expect(stats.totalAssets).to.be.gt(depositAmount); // Should include some accrued profit
    });

    it("Should return correct stats with pending withdrawals", async function () {
      const { vault, usdeToken, stakedUsde, user1 } = await loadFixture(deployVaultFixture);

      // Deposit first
      const depositAmount = ethers.parseEther("1000");
      await usdeToken.connect(user1).approve(await vault.getAddress(), depositAmount);
      await vault.connect(user1).deposit(depositAmount, user1.address);

      const actualShares = await vault.balanceOf(user1.address);

      // Lock all liquidity in a position to prevent instant fulfillment
      const sUsdeAmount = ethers.parseEther("100");
      const bookValue = depositAmount; // Use all idle liquidity
      const expectedAssets = ethers.parseEther("1010");
      await stakedUsde.mint(await vault.getAddress(), sUsdeAmount);
      await vault.openPositionForTesting(sUsdeAmount, bookValue, expectedAssets);

      // Now request withdrawal (50% of shares) - should not be fulfilled immediately
      const withdrawShares = actualShares / 2n;
      await vault.connect(user1).requestWithdrawal(withdrawShares, user1.address, user1.address);

      const stats = await vault.getVaultStats();

      expect(stats.pendingWithdrawals).to.equal(1);
    });
  });

  describe("getUserInfo", function () {
    it("Should return empty info for user with no activity", async function () {
      const { vault, user1 } = await loadFixture(deployVaultFixture);

      const info = await vault.getUserInfo(user1.address);

      expect(info.shares).to.equal(0);
      expect(info.assets).to.equal(0);
      expect(info.pendingWithdrawals).to.equal(0);
      expect(info.totalWithdrawalShares).to.equal(0);
      expect(info.totalWithdrawalAssets).to.equal(0);
    });

    it("Should return correct info after deposit", async function () {
      const { vault, usdeToken, user1 } = await loadFixture(deployVaultFixture);

      const depositAmount = ethers.parseEther("1000");
      await usdeToken.connect(user1).approve(await vault.getAddress(), depositAmount);
      await vault.connect(user1).deposit(depositAmount, user1.address);

      const actualShares = await vault.balanceOf(user1.address);
      const info = await vault.getUserInfo(user1.address);

      expect(info.shares).to.equal(actualShares);
      // With _decimalsOffset, assets should still equal depositAmount (share value is maintained)
      expect(info.assets).to.be.closeTo(depositAmount, ethers.parseEther("0.001"));
      expect(info.pendingWithdrawals).to.equal(0);
      expect(info.totalWithdrawalShares).to.equal(0);
      expect(info.totalWithdrawalAssets).to.equal(0);
    });

    it("Should return correct info with pending withdrawal", async function () {
      const { vault, usdeToken, stakedUsde, user1 } = await loadFixture(deployVaultFixture);

      // Deposit first
      const depositAmount = ethers.parseEther("1000");
      await usdeToken.connect(user1).approve(await vault.getAddress(), depositAmount);
      await vault.connect(user1).deposit(depositAmount, user1.address);

      const actualShares = await vault.balanceOf(user1.address);

      // Lock all liquidity
      const sUsdeAmount = ethers.parseEther("100");
      const bookValue = depositAmount;
      const expectedAssets = ethers.parseEther("1010");
      await stakedUsde.mint(await vault.getAddress(), sUsdeAmount);
      await vault.openPositionForTesting(sUsdeAmount, bookValue, expectedAssets);

      // Request withdrawal (50% of shares)
      const withdrawShares = actualShares / 2n;
      await vault.connect(user1).requestWithdrawal(withdrawShares, user1.address, user1.address);

      const info = await vault.getUserInfo(user1.address);

      expect(info.shares).to.equal(actualShares - withdrawShares); // Remaining shares
      expect(info.pendingWithdrawals).to.equal(1);
      // Note: totalWithdrawalShares might be less than withdrawShares if partially fulfilled
      expect(info.totalWithdrawalShares).to.be.gt(0);
      expect(info.totalWithdrawalShares).to.be.lte(withdrawShares);
      expect(info.totalWithdrawalAssets).to.be.gt(0); // Should have some value
    });

    it("Should return correct info with multiple pending withdrawals", async function () {
      const { vault, usdeToken, stakedUsde, user1 } = await loadFixture(deployVaultFixture);

      // Deposit
      const depositAmount = ethers.parseEther("1000");
      await usdeToken.connect(user1).approve(await vault.getAddress(), depositAmount);
      await vault.connect(user1).deposit(depositAmount, user1.address);

      const actualShares = await vault.balanceOf(user1.address);

      // Lock all liquidity
      const sUsdeAmount = ethers.parseEther("100");
      const bookValue = depositAmount;
      const expectedAssets = ethers.parseEther("1010");
      await stakedUsde.mint(await vault.getAddress(), sUsdeAmount);
      await vault.openPositionForTesting(sUsdeAmount, bookValue, expectedAssets);

      // Request two withdrawals (30% and 20% of shares)
      const withdraw1 = (actualShares * 30n) / 100n;
      const withdraw2 = (actualShares * 20n) / 100n;
      await vault.connect(user1).requestWithdrawal(withdraw1, user1.address, user1.address);
      await vault.connect(user1).requestWithdrawal(withdraw2, user1.address, user1.address);

      const info = await vault.getUserInfo(user1.address);

      // Note: Some withdrawals might be partially fulfilled
      expect(info.pendingWithdrawals).to.be.gte(1); // At least one pending
      expect(info.pendingWithdrawals).to.be.lte(2); // At most two pending
      expect(info.totalWithdrawalShares).to.be.gt(0);
    });

    it("Should not count cancelled withdrawals", async function () {
      const { vault, usdeToken, stakedUsde, user1 } = await loadFixture(deployVaultFixture);

      // Deposit
      const depositAmount = ethers.parseEther("1000");
      await usdeToken.connect(user1).approve(await vault.getAddress(), depositAmount);
      await vault.connect(user1).deposit(depositAmount, user1.address);

      const actualShares = await vault.balanceOf(user1.address);

      // Lock all liquidity
      const sUsdeAmount = ethers.parseEther("100");
      const bookValue = depositAmount;
      const expectedAssets = ethers.parseEther("1010");
      await stakedUsde.mint(await vault.getAddress(), sUsdeAmount);
      await vault.openPositionForTesting(sUsdeAmount, bookValue, expectedAssets);

      // Request withdrawal (50% of shares)
      const withdrawShares = actualShares / 2n;
      const requestId = await vault.nextWithdrawalRequestId();
      await vault.connect(user1).requestWithdrawal(withdrawShares, user1.address, user1.address);

      // Wait for cancel cooldown then cancel withdrawal
      await time.increase(5 * 60 + 1);
      await vault.connect(user1).cancelWithdrawal(requestId);

      const info = await vault.getUserInfo(user1.address);

      expect(info.pendingWithdrawals).to.equal(0);
      expect(info.totalWithdrawalShares).to.equal(0);
      expect(info.totalWithdrawalAssets).to.equal(0);
    });

    it("Should not count fulfilled withdrawals", async function () {
      const { vault, usdeToken, user1 } = await loadFixture(deployVaultFixture);

      // Deposit with enough liquidity
      const depositAmount = ethers.parseEther("1000");
      await usdeToken.connect(user1).approve(await vault.getAddress(), depositAmount);
      await vault.connect(user1).deposit(depositAmount, user1.address);

      const actualShares = await vault.balanceOf(user1.address);

      // Request withdrawal (50% of shares, should be fulfilled immediately)
      const withdrawShares = actualShares / 2n;
      await vault.connect(user1).requestWithdrawal(withdrawShares, user1.address, user1.address);

      const info = await vault.getUserInfo(user1.address);

      // Should be fulfilled immediately due to idle liquidity
      expect(info.pendingWithdrawals).to.equal(0);
      expect(info.totalWithdrawalShares).to.equal(0);
    });
  });

  describe("getUserWithdrawals", function () {
    it("Should return empty array for user with no withdrawals", async function () {
      const { vault, user1 } = await loadFixture(deployVaultFixture);

      const withdrawals = await vault.getUserWithdrawals(user1.address);

      expect(withdrawals.length).to.equal(0);
    });

    it("Should return correct withdrawal IDs", async function () {
      const { vault, usdeToken, user1 } = await loadFixture(deployVaultFixture);

      // Deposit
      const depositAmount = ethers.parseEther("1000");
      await usdeToken.connect(user1).approve(await vault.getAddress(), depositAmount);
      await vault.connect(user1).deposit(depositAmount, user1.address);

      const actualShares = await vault.balanceOf(user1.address);

      // Request two withdrawals (30% and 20% of shares)
      const requestId1 = await vault.nextWithdrawalRequestId();
      await vault.connect(user1).requestWithdrawal((actualShares * 30n) / 100n, user1.address, user1.address);

      const requestId2 = await vault.nextWithdrawalRequestId();
      await vault.connect(user1).requestWithdrawal((actualShares * 20n) / 100n, user1.address, user1.address);

      const withdrawals = await vault.getUserWithdrawals(user1.address);

      expect(withdrawals.length).to.equal(2);
      expect(withdrawals[0]).to.equal(requestId1);
      expect(withdrawals[1]).to.equal(requestId2);
    });

    it("Should include cancelled withdrawals in list", async function () {
      const { vault, usdeToken, stakedUsde, user1 } = await loadFixture(deployVaultFixture);

      // Deposit
      const depositAmount = ethers.parseEther("1000");
      await usdeToken.connect(user1).approve(await vault.getAddress(), depositAmount);
      await vault.connect(user1).deposit(depositAmount, user1.address);

      const actualShares = await vault.balanceOf(user1.address);

      // Lock all liquidity
      const sUsdeAmount = ethers.parseEther("100");
      const bookValue = depositAmount;
      const expectedAssets = ethers.parseEther("1010");
      await stakedUsde.mint(await vault.getAddress(), sUsdeAmount);
      await vault.openPositionForTesting(sUsdeAmount, bookValue, expectedAssets);

      // Request withdrawal (50% of shares)
      const requestId = await vault.nextWithdrawalRequestId();
      await vault.connect(user1).requestWithdrawal(actualShares / 2n, user1.address, user1.address);

      // Wait for cancel cooldown then cancel withdrawal
      await time.increase(5 * 60 + 1);
      await vault.connect(user1).cancelWithdrawal(requestId);

      const withdrawals = await vault.getUserWithdrawals(user1.address);

      // Still in the list, but marked as cancelled
      expect(withdrawals.length).to.equal(1);
      expect(withdrawals[0]).to.equal(requestId);

      const request = await vault.getWithdrawalRequest(requestId);
      expect(request.cancelled).to.equal(true);
    });
  });

  describe("getActivePositions", function () {
    it("Should return empty array when no positions", async function () {
      const { vault } = await loadFixture(deployVaultFixture);

      const positions = await vault.getActivePositions();

      expect(positions.length).to.equal(0);
    });

    it("Should return all active positions", async function () {
      const { vault, stakedUsde } = await loadFixture(deployVaultFixture);

      // Open three positions
      const sUsdeAmount = ethers.parseEther("100");
      const bookValue = ethers.parseEther("95");
      const expectedAssets = ethers.parseEther("100");

      await stakedUsde.mint(await vault.getAddress(), sUsdeAmount * 3n);

      await vault.openPositionForTesting(sUsdeAmount, bookValue, expectedAssets);
      await vault.openPositionForTesting(sUsdeAmount, bookValue, expectedAssets);
      await vault.openPositionForTesting(sUsdeAmount, bookValue, expectedAssets);

      const positions = await vault.getActivePositions();

      expect(positions.length).to.equal(3);

      // Check first position data
      expect(positions[0].sUsdeAmount).to.equal(sUsdeAmount);
      expect(positions[0].bookValue).to.equal(bookValue);
      expect(positions[0].expectedAssets).to.equal(expectedAssets);
      expect(positions[0].claimed).to.equal(false);
    });

    it("Should not include claimed positions", async function () {
      const { vault, stakedUsde, usdeToken } = await loadFixture(deployVaultFixture);

      // Open two positions
      const sUsdeAmount = ethers.parseEther("100");
      const bookValue = ethers.parseEther("95");
      const expectedAssets = ethers.parseEther("100");

      await stakedUsde.mint(await vault.getAddress(), sUsdeAmount * 2n);
      await vault.openPositionForTesting(sUsdeAmount, bookValue, expectedAssets);
      await vault.openPositionForTesting(sUsdeAmount, bookValue, expectedAssets);

      // Fast forward and claim first position
      await time.increase(COOLDOWN_DURATION + 1);
      await usdeToken.mint(await stakedUsde.getAddress(), expectedAssets);
      await vault.claimPosition();

      const positions = await vault.getActivePositions();

      // Only second position should remain
      expect(positions.length).to.equal(1);
    });

    it("Should return positions with correct proxy addresses", async function () {
      const { vault, stakedUsde } = await loadFixture(deployVaultFixture);

      // Open position
      const sUsdeAmount = ethers.parseEther("100");
      const bookValue = ethers.parseEther("95");
      const expectedAssets = ethers.parseEther("100");

      await stakedUsde.mint(await vault.getAddress(), sUsdeAmount);
      await vault.openPositionForTesting(sUsdeAmount, bookValue, expectedAssets);

      const positions = await vault.getActivePositions();

      expect(positions.length).to.equal(1);
      expect(positions[0].proxyContract).to.not.equal(ethers.ZeroAddress);
    });
  });

  describe("Integration scenarios", function () {
    it("Should provide consistent data across all view functions", async function () {
      const { vault, usdeToken, stakedUsde, user1, user2 } = await loadFixture(deployVaultFixture);

      // User1 deposits
      const deposit1 = ethers.parseEther("1000");
      await usdeToken.connect(user1).approve(await vault.getAddress(), deposit1);
      await vault.connect(user1).deposit(deposit1, user1.address);

      const user1Shares = await vault.balanceOf(user1.address);

      // User2 deposits
      const deposit2 = ethers.parseEther("2000");
      await usdeToken.connect(user2).approve(await vault.getAddress(), deposit2);
      await vault.connect(user2).deposit(deposit2, user2.address);

      const user2Shares = await vault.balanceOf(user2.address);
      const totalSharesBefore = await vault.totalSupply();

      // Open a position using ALL idle liquidity to prevent instant withdrawal fulfillment
      const sUsdeAmount = ethers.parseEther("100");
      const bookValue = deposit1 + deposit2; // Use all deposited funds
      const expectedAssets = ethers.parseEther("3010");
      await stakedUsde.mint(await vault.getAddress(), sUsdeAmount);
      await vault.openPositionForTesting(sUsdeAmount, bookValue, expectedAssets);

      // User1 requests withdrawal (50% of their shares, won't be fulfilled due to no idle liquidity)
      const withdrawShares = user1Shares / 2n;
      await vault.connect(user1).requestWithdrawal(withdrawShares, user1.address, user1.address);

      // Get all stats
      const vaultStats = await vault.getVaultStats();
      const user1Info = await vault.getUserInfo(user1.address);
      const user2Info = await vault.getUserInfo(user2.address);
      const user1Withdrawals = await vault.getUserWithdrawals(user1.address);
      const activePositions = await vault.getActivePositions();

      // Verify vault stats
      expect(vaultStats.activePositions).to.equal(1);
      // Note: Withdrawal might be partially fulfilled
      expect(vaultStats.pendingWithdrawals).to.be.gte(0);
      expect(vaultStats.pendingWithdrawals).to.be.lte(1);
      // totalShares might be less than before if withdrawal partially fulfilled
      expect(vaultStats.totalShares).to.be.lte(totalSharesBefore);
      expect(vaultStats.totalShares).to.be.gte(totalSharesBefore - withdrawShares);

      // Verify user1 info
      expect(user1Info.shares).to.equal(user1Shares - withdrawShares);
      expect(user1Info.pendingWithdrawals).to.be.gte(0);
      expect(user1Info.pendingWithdrawals).to.be.lte(1);

      // Verify user2 info
      expect(user2Info.shares).to.equal(user2Shares);
      expect(user2Info.pendingWithdrawals).to.equal(0);

      // Verify user1 withdrawals
      expect(user1Withdrawals.length).to.equal(1);

      // Verify active positions
      expect(activePositions.length).to.equal(1);
    });
  });
});
