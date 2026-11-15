const fs = require("node:fs/promises");
const path = require("node:path");
const { Wallet, ContractFactory, formatEther, getCreateAddress, Transaction } = require("ethers");
const { chainId, confirmedRoles, makeProvider, manifestPath, verifyChain } = require("./sepolia.cjs");

async function main() {
  const roles = confirmedRoles();
  console.table(roles);
  if (process.argv.includes("--check-roles")) return;
  if (process.env.CONFIRM_SEPOLIA_ROLES !== "yes") {
    throw new Error("Review the three addresses and set CONFIRM_SEPOLIA_ROLES=yes before deploying");
  }
  const provider = makeProvider();
  try {
    await verifyChain(provider);
    if (process.argv.includes("--finalize")) {
      const pending = JSON.parse(await fs.readFile(manifestPath, "utf8"));
      if (pending.state !== "pending" || pending.chainId !== chainId ||
          Object.keys(roles).some((key) => roles[key] !== pending.roles[key])) {
        throw new Error("The pending record does not match the confirmed roles and network");
      }
      return await finalize(provider, pending);
    }
    if (!process.env.SEPOLIA_DEPLOYER_KEY) throw new Error("Set SEPOLIA_DEPLOYER_KEY locally using a dedicated funded test account");
    const wallet = new Wallet(process.env.SEPOLIA_DEPLOYER_KEY, provider);
    const abiPath = path.join(__dirname, "../artifacts/contracts/FreelanceEscrow.sol/FreelanceEscrow.json");
    const { abi, bytecode } = JSON.parse(await fs.readFile(abiPath, "utf8"));
    const factory = new ContractFactory(abi, bytecode, wallet);
    const tx = await factory.getDeployTransaction(roles.arbiter);
    const [balance, gas, fee] = await Promise.all([
      provider.getBalance(wallet.address), wallet.estimateGas(tx), provider.getFeeData(),
    ]);
    const bid = fee.maxFeePerGas ?? fee.gasPrice;
    if (bid === null || balance < gas * bid) {
      throw new Error("Deployer needs sufficient Sepolia ETH. Current balance: " + formatEther(balance));
    }
    const populated = await wallet.populateTransaction({ ...tx, gasLimit: gas });
    const signed = await wallet.signTransaction(populated);
    const transaction = Transaction.from(signed);
    if (transaction.chainId !== BigInt(chainId)) throw new Error("Signed deployment has the wrong chain ID");
    const pending = {
      chainId, roles, abi, address: getCreateAddress({ from: wallet.address, nonce: transaction.nonce }),
      deploymentTransaction: transaction.hash, state: "pending",
    };
    await fs.mkdir(path.dirname(manifestPath), { recursive: true });
    // Save the hash exclusively before broadcast so an interrupted run is traceable.
    await fs.writeFile(manifestPath, JSON.stringify(pending, null, 2) + "\n", { flag: "wx" });
    console.log("Sepolia deployment hash: " + transaction.hash);
    await provider.broadcastTransaction(signed);
    await finalize(provider, pending);
  } finally { provider.destroy(); }
}

async function finalize(provider, pending) {
  const receipt = await provider.waitForTransaction(pending.deploymentTransaction, 2, 180000);
  if (receipt?.status !== 1 || receipt.contractAddress !== pending.address) throw new Error("Deployment receipt failed");
  const { state, ...record } = pending;
  const manifest = { ...record, deploymentBlock: receipt.blockNumber, deploymentBlockHash: receipt.blockHash };
  const temp = manifestPath + ".tmp";
  await fs.writeFile(temp, JSON.stringify(manifest, null, 2) + "\n");
  await fs.rename(temp, manifestPath);
  console.log("Sepolia contract " + manifest.address + " at block " + manifest.deploymentBlock);
}

// Avoid printing RPC credentials, signed raw transactions, or other provider payloads.
main().catch((error) => {
  const message = error.code === "EEXIST" ? "A deployment record exists. Inspect it before trying another deployment." :
    error.code === "INSUFFICIENT_FUNDS" ? "Insufficient Sepolia ETH for deployment" :
    error.code && error.code !== "ENOENT" ? "Deployment could not complete (" + error.code + "). Inspect the deployment record and transaction hash before retrying." :
    error.message;
  console.error(message);
  process.exitCode = 1;
});
