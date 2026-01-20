import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { ArbitrageVault, MockERC20, MockStakedUSDe } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

describe("ArbitrageVault", function () {
  const COOLDOWN_DURATION = 7 * 24 * 60 * 60; // 7 days

  // Fixture to deploy the contract and set up initial state
  async function deployVaultFixture() {
    const [owner, user1, user2]: HardhatEthersSigner[] = await ethers.getSigners();

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

    // Deploy ArbitrageVault
    const ArbitrageVaultFactory = await ethers.getContractFactory("ArbitrageVault");
    const vault: ArbitrageVault = await ArbitrageVaultFactory.deploy(
      await usdeToken.getAddress(),
      await stakedUsde.getAddress(),
      owner.address // fee recipient
    );
    await vault.waitForDeployment();

    // Mint some USDe tokens to users for testing
    const initialBalance = ethers.parseEther("10000");
    await usdeToken.mint(user1.address, initialBalance);
    await usdeToken.mint(user2.address, initialBalance);

    return { vault, usdeToken, stakedUsde, owner, user1, user2, initialBalance };
  }

  describe("Deployment", function () {
    it("Should set the correct name and symbol", async function () {
      const { vault } = await loadFixture(deployVaultFixture);

      expect(await vault.name()).to.equal("Arbitrage Vault USDe");
      expect(await vault.symbol()).to.equal("avUSDe");
    });

    it("Should set the correct underlying asset", async function () {
      const { vault, usdeToken } = await loadFixture(deployVaultFixture);

      expect(await vault.asset()).to.equal(await usdeToken.getAddress());
    });

    it("Should set the correct owner", async function () {
      const { vault, owner } = await loadFixture(deployVaultFixture);

      expect(await vault.owner()).to.equal(owner.address);
    });

    it("Should revert if USDe token address is zero", async function () {
      const ArbitrageVaultFactory = await ethers.getContractFactory("ArbitrageVault");
      const { stakedUsde, owner } = await loadFixture(deployVaultFixture);

      await expect(
        ArbitrageVaultFactory.deploy(ethers.ZeroAddress, await stakedUsde.getAddress(), owner.address)
      ).to.be.revertedWith("ArbitrageVault: zero address");
    });

    it("Should revert if sUSDe token address is zero", async function () {
      const ArbitrageVaultFactory = await ethers.getContractFactory("ArbitrageVault");
      const { usdeToken, owner } = await loadFixture(deployVaultFixture);

      await expect(
        ArbitrageVaultFactory.deploy(await usdeToken.getAddress(), ethers.ZeroAddress, owner.address)
      ).to.be.revertedWith("ArbitrageVault: zero sUSDe address");
    });

    it("Should revert if fee recipient address is zero", async function () {
      const ArbitrageVaultFactory = await ethers.getContractFactory("ArbitrageVault");
      const { usdeToken, stakedUsde } = await loadFixture(deployVaultFixture);

      await expect(
        ArbitrageVaultFactory.deploy(await usdeToken.getAddress(), await stakedUsde.getAddress(), ethers.ZeroAddress)
      ).to.be.revertedWith("ArbitrageVault: zero fee recipient");
    });
  });

  describe("Deposits", function () {
    it("Should allow users to deposit USDe and receive shares", async function () {
      const { vault, usdeToken, user1 } = await loadFixture(deployVaultFixture);

      const depositAmount = ethers.parseEther("1000");

      // Approve vault to spend user's USDe
      await usdeToken.connect(user1).approve(await vault.getAddress(), depositAmount);

      // Deposit USDe
      const tx = await vault.connect(user1).deposit(depositAmount, user1.address);
      await tx.wait();

      // Check balances - shares are received (value may differ due to _decimalsOffset)
      const shares = await vault.balanceOf(user1.address);
      expect(shares).to.be.gt(0);
      expect(await usdeToken.balanceOf(await vault.getAddress())).to.equal(depositAmount);
      // Verify shares represent the same value
      expect(await vault.convertToAssets(shares)).to.be.closeTo(depositAmount, ethers.parseEther("0.001"));
    });

    it("Should not allow donation-based inflation to zero shares", async function () {
      const { vault, usdeToken, user1, user2 } = await loadFixture(deployVaultFixture);

      const attackerDeposit = 1n; // 1 wei
      const donation = ethers.parseEther("10000000"); // 10,000,000 USDe
      const victimDeposit = ethers.parseEther("1"); // 1 USDe

      await usdeToken.mint(user1.address, donation);

      await usdeToken.connect(user1).approve(await vault.getAddress(), attackerDeposit);
      await vault.connect(user1).deposit(attackerDeposit, user1.address);

      await usdeToken.connect(user1).transfer(await vault.getAddress(), donation);

      await usdeToken.connect(user2).approve(await vault.getAddress(), victimDeposit);
      const sharesBefore = await vault.balanceOf(user2.address);
      await vault.connect(user2).deposit(victimDeposit, user2.address);
      const sharesAfter = await vault.balanceOf(user2.address);

      const sharesMinted = sharesAfter - sharesBefore;
      expect(sharesMinted).to.be.gt(0);
    });

    it("Should emit Deposited event on deposit", async function () {
      const { vault, usdeToken, user1 } = await loadFixture(deployVaultFixture);

      const depositAmount = ethers.parseEther("1000");
      await usdeToken.connect(user1).approve(await vault.getAddress(), depositAmount);

      // Get expected shares before deposit
      const expectedShares = await vault.previewDeposit(depositAmount);

      await expect(
        vault.connect(user1).deposit(depositAmount, user1.address)
      )
        .to.emit(vault, "Deposited")
        .withArgs(user1.address, depositAmount, expectedShares);
    });

    it("Should mint correct shares on first deposit (value preserved)", async function () {
      const { vault, usdeToken, user1 } = await loadFixture(deployVaultFixture);

      const depositAmount = ethers.parseEther("1000");
      await usdeToken.connect(user1).approve(await vault.getAddress(), depositAmount);

      await vault.connect(user1).deposit(depositAmount, user1.address);

      // Shares should represent the deposited value (accounting for _decimalsOffset)
      const shares = await vault.balanceOf(user1.address);
      expect(await vault.convertToAssets(shares)).to.be.closeTo(depositAmount, ethers.parseEther("0.001"));
    });

    it("Should handle multiple deposits correctly", async function () {
      const { vault, usdeToken, user1, user2 } = await loadFixture(deployVaultFixture);

      const depositAmount1 = ethers.parseEther("1000");
      const depositAmount2 = ethers.parseEther("500");

      // User1 deposits
      await usdeToken.connect(user1).approve(await vault.getAddress(), depositAmount1);
      await vault.connect(user1).deposit(depositAmount1, user1.address);

      const user1Shares = await vault.balanceOf(user1.address);

      // User2 deposits
      await usdeToken.connect(user2).approve(await vault.getAddress(), depositAmount2);
      await vault.connect(user2).deposit(depositAmount2, user2.address);

      const user2Shares = await vault.balanceOf(user2.address);

      // Check share values represent deposited amounts
      expect(await vault.convertToAssets(user1Shares)).to.be.closeTo(depositAmount1, ethers.parseEther("0.001"));
      expect(await vault.convertToAssets(user2Shares)).to.be.closeTo(depositAmount2, ethers.parseEther("0.001"));
      expect(await vault.totalAssets()).to.equal(depositAmount1 + depositAmount2);
    });
  });

  describe("Withdrawals", function () {
    it.skip("Should allow users to withdraw USDe by burning shares", async function () {
      const { vault, usdeToken, user1 } = await loadFixture(deployVaultFixture);

      const depositAmount = ethers.parseEther("1000");
      const withdrawAmount = ethers.parseEther("500");

      // First deposit
      await usdeToken.connect(user1).approve(await vault.getAddress(), depositAmount);
      await vault.connect(user1).deposit(depositAmount, user1.address);

      // Then withdraw (convert assets to shares for redeem)
      const initialBalance = await usdeToken.balanceOf(user1.address);
      const sharesToRedeem = await vault.previewWithdraw(withdrawAmount);
      await vault.connect(user1).redeem(sharesToRedeem, user1.address, user1.address);

      // Check balances
      expect(await usdeToken.balanceOf(user1.address)).to.be.closeTo(
        initialBalance + withdrawAmount,
        ethers.parseEther("1")
      );
      const remainingShares = await vault.balanceOf(user1.address);
      expect(remainingShares).to.be.closeTo(depositAmount - withdrawAmount, ethers.parseEther("1"));
    });

    it.skip("Should emit Withdrawn event on withdrawal", async function () {
      const { vault, usdeToken, user1 } = await loadFixture(deployVaultFixture);

      const depositAmount = ethers.parseEther("1000");
      const withdrawAmount = ethers.parseEther("500");

      await usdeToken.connect(user1).approve(await vault.getAddress(), depositAmount);
      await vault.connect(user1).deposit(depositAmount, user1.address);

      const sharesToRedeem = await vault.previewWithdraw(withdrawAmount);
      await expect(
        vault.connect(user1).redeem(sharesToRedeem, user1.address, user1.address)
      )
        .to.emit(vault, "Withdrawn")
        .withArgs(user1.address, withdrawAmount, withdrawAmount);
    });

    it("Should not allow withdrawal of more assets than deposited", async function () {
      const { vault, usdeToken, user1 } = await loadFixture(deployVaultFixture);

      const depositAmount = ethers.parseEther("1000");
      const withdrawAmount = ethers.parseEther("1500");

      await usdeToken.connect(user1).approve(await vault.getAddress(), depositAmount);
      await vault.connect(user1).deposit(depositAmount, user1.address);

      const sharesToRedeem = await vault.previewWithdraw(withdrawAmount);
      await expect(
        vault.connect(user1).redeem(sharesToRedeem, user1.address, user1.address)
      ).to.be.reverted;
    });
  });

  describe("Redeeming", function () {
    it.skip("Should allow users to redeem shares for USDe", async function () {
      const { vault, usdeToken, user1 } = await loadFixture(deployVaultFixture);

      const depositAmount = ethers.parseEther("1000");
      const redeemShares = ethers.parseEther("500");

      // First deposit
      await usdeToken.connect(user1).approve(await vault.getAddress(), depositAmount);
      await vault.connect(user1).deposit(depositAmount, user1.address);

      // Then redeem
      const initialBalance = await usdeToken.balanceOf(user1.address);
      await vault.connect(user1).redeem(redeemShares, user1.address, user1.address);

      // Check balances
      expect(await usdeToken.balanceOf(user1.address)).to.equal(
        initialBalance + redeemShares
      );
      expect(await vault.balanceOf(user1.address)).to.equal(depositAmount - redeemShares);
    });

    it.skip("Should emit Withdrawn event on redeem", async function () {
      const { vault, usdeToken, user1 } = await loadFixture(deployVaultFixture);

      const depositAmount = ethers.parseEther("1000");
      const redeemShares = ethers.parseEther("500");

      await usdeToken.connect(user1).approve(await vault.getAddress(), depositAmount);
      await vault.connect(user1).deposit(depositAmount, user1.address);

      await expect(
        vault.connect(user1).redeem(redeemShares, user1.address, user1.address)
      ).to.emit(vault, "Withdrawn");
    });
  });

  describe("Total Assets", function () {
    it("Should correctly calculate total assets", async function () {
      const { vault, usdeToken, user1, user2 } = await loadFixture(deployVaultFixture);

      const deposit1 = ethers.parseEther("1000");
      const deposit2 = ethers.parseEther("2000");

      await usdeToken.connect(user1).approve(await vault.getAddress(), deposit1);
      await vault.connect(user1).deposit(deposit1, user1.address);

      await usdeToken.connect(user2).approve(await vault.getAddress(), deposit2);
      await vault.connect(user2).deposit(deposit2, user2.address);

      expect(await vault.totalAssets()).to.equal(deposit1 + deposit2);
    });

    it.skip("Should update total assets after withdrawals", async function () {
      const { vault, usdeToken, user1 } = await loadFixture(deployVaultFixture);

      const depositAmount = ethers.parseEther("1000");
      const withdrawAmount = ethers.parseEther("400");

      await usdeToken.connect(user1).approve(await vault.getAddress(), depositAmount);
      await vault.connect(user1).deposit(depositAmount, user1.address);

      const sharesToRedeem = await vault.previewWithdraw(withdrawAmount);
      await vault.connect(user1).redeem(sharesToRedeem, user1.address, user1.address);

      expect(await vault.totalAssets()).to.be.closeTo(depositAmount - withdrawAmount, ethers.parseEther("1"));
    });
  });

  describe("Share Pricing", function () {
    it("Should maintain correct share price (value preserved)", async function () {
      const { vault, usdeToken, user1 } = await loadFixture(deployVaultFixture);

      const depositAmount = ethers.parseEther("1000");

      await usdeToken.connect(user1).approve(await vault.getAddress(), depositAmount);
      await vault.connect(user1).deposit(depositAmount, user1.address);

      // With _decimalsOffset, shares != assets but value should be preserved
      const shares = await vault.balanceOf(user1.address);
      const assets = await vault.convertToAssets(shares);

      // Allow small tolerance for rounding
      expect(assets).to.be.closeTo(depositAmount, ethers.parseEther("0.001"));
    });
  });
});
