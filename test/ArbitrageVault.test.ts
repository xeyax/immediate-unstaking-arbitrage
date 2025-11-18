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
      await stakedUsde.getAddress()
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
      const { stakedUsde } = await loadFixture(deployVaultFixture);

      await expect(
        ArbitrageVaultFactory.deploy(ethers.ZeroAddress, await stakedUsde.getAddress())
      ).to.be.revertedWith("ArbitrageVault: zero address");
    });

    it("Should revert if sUSDe token address is zero", async function () {
      const ArbitrageVaultFactory = await ethers.getContractFactory("ArbitrageVault");
      const { usdeToken } = await loadFixture(deployVaultFixture);

      await expect(
        ArbitrageVaultFactory.deploy(await usdeToken.getAddress(), ethers.ZeroAddress)
      ).to.be.revertedWith("ArbitrageVault: zero sUSDe address");
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

      // Check balances
      expect(await vault.balanceOf(user1.address)).to.equal(depositAmount);
      expect(await usdeToken.balanceOf(await vault.getAddress())).to.equal(depositAmount);
    });

    it("Should emit Deposited event on deposit", async function () {
      const { vault, usdeToken, user1 } = await loadFixture(deployVaultFixture);

      const depositAmount = ethers.parseEther("1000");
      await usdeToken.connect(user1).approve(await vault.getAddress(), depositAmount);

      await expect(
        vault.connect(user1).deposit(depositAmount, user1.address)
      )
        .to.emit(vault, "Deposited")
        .withArgs(user1.address, depositAmount, depositAmount);
    });

    it("Should mint correct shares on first deposit (1:1 ratio)", async function () {
      const { vault, usdeToken, user1 } = await loadFixture(deployVaultFixture);

      const depositAmount = ethers.parseEther("1000");
      await usdeToken.connect(user1).approve(await vault.getAddress(), depositAmount);

      await vault.connect(user1).deposit(depositAmount, user1.address);

      // First deposit should have 1:1 ratio
      expect(await vault.balanceOf(user1.address)).to.equal(depositAmount);
    });

    it("Should handle multiple deposits correctly", async function () {
      const { vault, usdeToken, user1, user2 } = await loadFixture(deployVaultFixture);

      const depositAmount1 = ethers.parseEther("1000");
      const depositAmount2 = ethers.parseEther("500");

      // User1 deposits
      await usdeToken.connect(user1).approve(await vault.getAddress(), depositAmount1);
      await vault.connect(user1).deposit(depositAmount1, user1.address);

      // User2 deposits
      await usdeToken.connect(user2).approve(await vault.getAddress(), depositAmount2);
      await vault.connect(user2).deposit(depositAmount2, user2.address);

      // Check balances
      expect(await vault.balanceOf(user1.address)).to.equal(depositAmount1);
      expect(await vault.balanceOf(user2.address)).to.equal(depositAmount2);
      expect(await vault.totalAssets()).to.equal(depositAmount1 + depositAmount2);
    });
  });

  describe("Minting", function () {
    it("Should allow users to mint shares", async function () {
      const { vault, usdeToken, user1 } = await loadFixture(deployVaultFixture);

      const sharesToMint = ethers.parseEther("1000");

      // Approve vault to spend user's USDe
      await usdeToken.connect(user1).approve(await vault.getAddress(), sharesToMint);

      // Mint shares
      await vault.connect(user1).mint(sharesToMint, user1.address);

      // Check balances
      expect(await vault.balanceOf(user1.address)).to.equal(sharesToMint);
    });

    it("Should emit Deposited event on mint", async function () {
      const { vault, usdeToken, user1 } = await loadFixture(deployVaultFixture);

      const sharesToMint = ethers.parseEther("1000");
      await usdeToken.connect(user1).approve(await vault.getAddress(), sharesToMint);

      await expect(
        vault.connect(user1).mint(sharesToMint, user1.address)
      ).to.emit(vault, "Deposited");
    });
  });

  describe("Withdrawals", function () {
    it("Should allow users to withdraw USDe by burning shares", async function () {
      const { vault, usdeToken, user1 } = await loadFixture(deployVaultFixture);

      const depositAmount = ethers.parseEther("1000");
      const withdrawAmount = ethers.parseEther("500");

      // First deposit
      await usdeToken.connect(user1).approve(await vault.getAddress(), depositAmount);
      await vault.connect(user1).deposit(depositAmount, user1.address);

      // Then withdraw
      const initialBalance = await usdeToken.balanceOf(user1.address);
      await vault.connect(user1).withdraw(withdrawAmount, user1.address, user1.address);

      // Check balances
      expect(await usdeToken.balanceOf(user1.address)).to.equal(
        initialBalance + withdrawAmount
      );
      expect(await vault.balanceOf(user1.address)).to.equal(depositAmount - withdrawAmount);
    });

    it("Should emit Withdrawn event on withdrawal", async function () {
      const { vault, usdeToken, user1 } = await loadFixture(deployVaultFixture);

      const depositAmount = ethers.parseEther("1000");
      const withdrawAmount = ethers.parseEther("500");

      await usdeToken.connect(user1).approve(await vault.getAddress(), depositAmount);
      await vault.connect(user1).deposit(depositAmount, user1.address);

      await expect(
        vault.connect(user1).withdraw(withdrawAmount, user1.address, user1.address)
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

      await expect(
        vault.connect(user1).withdraw(withdrawAmount, user1.address, user1.address)
      ).to.be.reverted;
    });
  });

  describe("Redeeming", function () {
    it("Should allow users to redeem shares for USDe", async function () {
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

    it("Should emit Withdrawn event on redeem", async function () {
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

    it("Should update total assets after withdrawals", async function () {
      const { vault, usdeToken, user1 } = await loadFixture(deployVaultFixture);

      const depositAmount = ethers.parseEther("1000");
      const withdrawAmount = ethers.parseEther("400");

      await usdeToken.connect(user1).approve(await vault.getAddress(), depositAmount);
      await vault.connect(user1).deposit(depositAmount, user1.address);

      await vault.connect(user1).withdraw(withdrawAmount, user1.address, user1.address);

      expect(await vault.totalAssets()).to.equal(depositAmount - withdrawAmount);
    });
  });

  describe("Share Pricing", function () {
    it("Should maintain correct share price (1:1 for Phase 1)", async function () {
      const { vault, usdeToken, user1 } = await loadFixture(deployVaultFixture);

      const depositAmount = ethers.parseEther("1000");

      await usdeToken.connect(user1).approve(await vault.getAddress(), depositAmount);
      await vault.connect(user1).deposit(depositAmount, user1.address);

      // In Phase 1 with no profit, share price should be 1:1
      const shares = await vault.balanceOf(user1.address);
      const assets = await vault.convertToAssets(shares);

      expect(assets).to.equal(depositAmount);
    });
  });
});
