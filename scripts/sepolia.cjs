const fs = require("node:fs/promises");
const path = require("node:path");
const { JsonRpcProvider, Contract, getAddress, ZeroAddress } = require("ethers");

const { contractVersion, manifestName } = require("./contract-version.cjs");
const chainId = 11155111;
const name = "Sepolia";
const root = path.resolve(__dirname, "..");
const manifestPath = path.join(root, "deployments", manifestName);
const clientAddress = "0x7753139708c1137ac9b75082fa03f3d597223b31";
const freelancerAddress = "0x7B5ad17248ec3CDDa65d387f0aF9de8D4424F7f9";
const arbiterAddress = "0x99eE1CB12249E5013c0c5CC090d333e75B53858E";

function confirmedRoles() {
  const inputs = {
    client: clientAddress,
    freelancer: freelancerAddress,
    arbiter: process.env.SEPOLIA_ARBITER ?? arbiterAddress,
  };
  return validateRoles(inputs);
}

function validateRoles(values) {
  const roles = {};
  for (const role of ["client", "freelancer", "arbiter"]) {
    const input = values?.[role];
    if (!input) throw new Error("Missing Sepolia Wallet for " + role);
    try { roles[role] = getAddress(input.trim()); }
    catch { throw new Error("Invalid Sepolia address for " + role); }
    if (roles[role] === ZeroAddress) throw new Error("Zero address is invalid for " + role);
  }
  if (roles.client !== getAddress(clientAddress)) throw new Error("Client does not match the confirmed address");
  if (roles.freelancer !== getAddress(freelancerAddress)) throw new Error("Freelancer does not match the confirmed address");
  if (new Set(Object.values(roles)).size !== 3) throw new Error("Client, freelancer and arbiter must be different Wallets");
  return roles;
}

function makeProvider() {
  const rpcUrl = process.env.SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com";
  let url;
  try { url = new URL(rpcUrl); } catch { throw new Error("Set SEPOLIA_RPC_URL to your HTTPS Sepolia RPC"); }
  if (url.protocol !== "https:") throw new Error("SEPOLIA_RPC_URL must use HTTPS");
  return new JsonRpcProvider(url.href, chainId, { batchMaxCount: 1, cacheTimeout: -1 });
}

async function verifyChain(provider) {
  if (BigInt(await provider.send("eth_chainId", [])) !== BigInt(chainId)) {
    throw new Error("The RPC does not report Sepolia chain ID 11155111");
  }
}

async function loadDeployment(provider, filePath = manifestPath) {
  let manifest;
  try { manifest = JSON.parse(await fs.readFile(filePath, "utf8")); }
  catch (error) {
    if (error.code === "ENOENT") throw new Error("No Escrow V" + contractVersion + " deployment. Run npm run " + (contractVersion === 2 ? "setup:sepolia:v2" : "setup:sepolia") + " first.");
    throw error;
  }
  if (manifest.chainId !== chainId || !Array.isArray(manifest.abi) ||
      !Number.isSafeInteger(manifest.deploymentBlock) || manifest.deploymentBlock < 1) {
    throw new Error("Invalid Sepolia deployment manifest");
  }
  const version = manifest.contractVersion ?? 1;
  if (version !== 1 && version !== 2) throw new Error("Unsupported Escrow contract version");
  if (filePath === manifestPath && version !== contractVersion) throw new Error("Deployment manifest belongs to a different Contract version");
  const roles = validateRoles(manifest.roles);
  const address = getAddress(manifest.address);
  await verifyChain(provider);
  const [block, receipt, code] = await Promise.all([
    provider.getBlock(manifest.deploymentBlock),
    provider.getTransactionReceipt(manifest.deploymentTransaction),
    provider.getCode(address),
  ]);
  if (block?.hash !== manifest.deploymentBlockHash || receipt?.status !== 1 ||
      receipt.blockHash !== manifest.deploymentBlockHash || receipt.contractAddress !== address || code === "0x") {
    throw new Error("Sepolia deployment receipt, block or bytecode failed verification");
  }
  const contract = new Contract(address, manifest.abi, provider);
  if (version === 2 && await contract.version() !== 2n) throw new Error("Expected an Escrow V2 contract");
  if (await contract.arbiter() !== roles.arbiter) throw new Error("Deployed contract has a different arbiter");
  return {
    address, chainId, networkName: name, contractVersion: version, abi: manifest.abi, roles,
    arbiter: roles.arbiter, deploymentBlock: manifest.deploymentBlock,
    deploymentBlockHash: manifest.deploymentBlockHash,
  };
}

module.exports = { chainId, confirmedRoles, loadDeployment, makeProvider, manifestPath, verifyChain };
