const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { artifacts, ethers } = require("hardhat");
const { confirmedRoles, loadDeployment } = require("../scripts/sepolia.cjs");
const { registerDeployment } = require("../scripts/sepolia-setup.cjs");

describe("Sepolia deployment attachment", function () {
  it("rejects missing or conflicting Wallet roles before using RPC", function () {
    const previous = process.env.SEPOLIA_ARBITER;
    try {
      delete process.env.SEPOLIA_ARBITER;
      assert.equal(confirmedRoles().arbiter, "0x99eE1CB12249E5013c0c5CC090d333e75B53858E");
      process.env.SEPOLIA_ARBITER = "0x7753139708c1137ac9b75082fa03f3d597223b31";
      assert.throws(confirmedRoles, /must be different/);
      process.env.SEPOLIA_ARBITER = "0x7B5ad17248ec3CDDa65d387f0aF9de8D4424F7f9";
      assert.throws(confirmedRoles, /must be different/);
    } finally {
      if (previous === undefined) delete process.env.SEPOLIA_ARBITER;
      else process.env.SEPOLIA_ARBITER = previous;
    }
  });

  it("registers only a confirmed Wallet deployment matching the creation data and roles", async function () {
    const [client, freelancer, arbiter] = await ethers.getSigners();
    const factory = await ethers.getContractFactory("FreelanceEscrow", freelancer);
    const contract = await factory.deploy(arbiter.address);
    const creation = contract.deploymentTransaction();
    const receipt = await creation.wait();
    const artifact = await artifacts.readArtifact("FreelanceEscrow");
    const plan = { roles: { client: client.address, freelancer: freelancer.address, arbiter: arbiter.address },
      data: creation.data, abi: artifact.abi };
    await ethers.provider.send("evm_mine", []);
    // Hardhat mines the receipt and contract. Substitute only the transaction chain ID.
    const provider = new Proxy(ethers.provider, {
      get(target, key) {
        if (key === "getTransaction") return async () => ({
          hash: creation.hash, from: creation.from, to: creation.to, value: creation.value,
          data: creation.data, blockHash: receipt.blockHash, chainId: 11155111n,
        });
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const folder = await fs.mkdtemp(path.resolve(".local", "wallet-deployment-"));
    const file = path.join(folder, "manifest.json");
    try {
      await assert.rejects(registerDeployment(provider, { ...plan, data: "0x00" }, creation.hash, file), /does not match/);
      const manifest = await registerDeployment(provider, plan, creation.hash, file);
      assert.equal(manifest.address, await contract.getAddress());
      assert.equal(manifest.deploymentBlockHash, receipt.blockHash);
      assert.equal(manifest.roles.arbiter, arbiter.address);
      assert.equal(JSON.parse(await fs.readFile(file, "utf8")).deploymentTransaction, creation.hash);
      await assert.rejects(registerDeployment(provider, plan, creation.hash, file), { code: "EEXIST" });
    } finally {
      await fs.unlink(file).catch((error) => { if (error.code !== "ENOENT") throw error; });
      await fs.rmdir(folder);
    }
  });

  it("reattaches to an existing contract and reads the same job and on-chain log", async function () {
    const [client, freelancer, arbiter] = await ethers.getSigners();
    const escrow = await ethers.deployContract("FreelanceEscrow", [arbiter.address]);
    const deployment = await escrow.deploymentTransaction().wait();
    const artifact = await artifacts.readArtifact("FreelanceEscrow");
    const manifest = {
      chainId: 11155111, address: await escrow.getAddress(), abi: artifact.abi,
      deploymentBlock: deployment.blockNumber, deploymentBlockHash: deployment.blockHash,
      deploymentTransaction: deployment.hash,
      roles: {
        client: "0x7753139708c1137ac9b75082fa03f3d597223b31",
        freelancer: "0x7B5ad17248ec3CDDa65d387f0aF9de8D4424F7f9",
        arbiter: arbiter.address,
      },
    };
    const folder = await fs.mkdtemp(path.resolve(".local", "attachment-"));
    const file = path.join(folder, "manifest.json");
    // Substitute only the chain ID check; receipts, blocks, state and logs are from Hardhat.
    const provider = new Proxy(ethers.provider, {
      get(target, key) {
        if (key === "send") return (method, args) => method === "eth_chainId" ? "0xaa36a7" : target.send(method, args);
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    try {
      await fs.writeFile(file, JSON.stringify(manifest));
      await assert.rejects(loadDeployment(ethers.provider, file), /does not report Sepolia/);
      const first = await loadDeployment(provider, file);
      const block = await ethers.provider.getBlock("latest");
      const tx = await escrow.connect(client).createJob(freelancer.address, 1, block.timestamp + 3600, "Persisted job", "Test detail");
      await tx.wait();
      const second = await loadDeployment(provider, file);
      assert.equal(first.address, second.address);
      assert.equal(first.deploymentBlockHash, second.deploymentBlockHash);
      const reopened = new ethers.Contract(second.address, second.abi, ethers.provider);
      assert.equal((await reopened.getJob(1)).title, "Persisted job");
      const logs = await reopened.queryFilter(reopened.filters.JobCreated(1), second.deploymentBlock);
      assert.equal(logs[0].transactionHash, tx.hash);
    } finally {
      await fs.unlink(file);
      await fs.rmdir(folder);
    }
  });
});
