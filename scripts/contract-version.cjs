const path = require("node:path");

const contractVersion = process.env.ESCROW_VERSION === "2" ? 2 : 1;
const contractName = contractVersion === 2 ? "FreelanceEscrowV2" : "FreelanceEscrow";
const manifestName = contractVersion === 2 ? "sepolia-v2.json" : "sepolia.json";
const artifactPath = path.join(__dirname, "../artifacts/contracts", contractName + ".sol", contractName + ".json");

module.exports = { artifactPath, contractName, contractVersion, manifestName };
