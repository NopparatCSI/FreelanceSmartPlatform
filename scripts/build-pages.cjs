const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { getAddress, isHexString } = require("ethers");

const root = path.resolve(__dirname, "..");
const output = path.join(root, "dist-pages");
const chainId = 11155111;
// Public endpoint served to browsers. Never use credentials in this URL.
const readRpcUrl = "https://ethereum-sepolia-rpc.publicnode.com";
const assets = {
  "index.html": "web/index.html",
  "app.js": "web/app.js",
  "milestones.js": "web/milestones.js",
  "styles.css": "web/styles.css",
  "diagnostics.js": "web/diagnostics.js",
  "ethers.js": "node_modules/ethers/dist/ethers.min.js",
};

async function renderSite(manifest, directory, otherVersionUrl) {
  if (manifest.chainId !== chainId || !Array.isArray(manifest.abi) ||
      !Number.isSafeInteger(manifest.deploymentBlock) || manifest.deploymentBlock < 1 ||
      !isHexString(manifest.deploymentBlockHash, 32)) {
    throw new Error("Expected a confirmed Sepolia deployment manifest");
  }
  const contractVersion = manifest.contractVersion ?? 1;
  if (contractVersion !== 1 && contractVersion !== 2) throw new Error("Unsupported Contract version");
  const roles = {};
  for (const role of ["client", "freelancer", "arbiter"]) roles[role] = getAddress(manifest.roles[role]);
  if (new Set(Object.values(roles)).size !== 3) throw new Error("Expected three distinct addresses in the manifest");
  const config = {
    mode: "sepolia", chainId, networkName: "Sepolia", contractVersion, otherVersionUrl,
    readRpcUrl, roles, abi: manifest.abi, address: getAddress(manifest.address), arbiter: roles.arbiter,
    deploymentBlock: manifest.deploymentBlock, deploymentBlockHash: manifest.deploymentBlockHash,
  };
  const files = new Map();
  const hash = createHash("sha256");
  hash.update(JSON.stringify(config));
  hash.update(await fs.readFile(__filename));
  for (const [name, source] of Object.entries(assets)) {
    const content = await fs.readFile(path.join(root, source));
    hash.update(name).update(content);
    files.set(name, content);
  }
  config.buildId = hash.digest("hex").slice(0, 16);
  const suffix = "?v=" + config.buildId;
  files.set("index.html", files.get("index.html").toString()
    .replace('href="/"', 'href="./"')
    .replace('"/styles.css"', '"./styles.css' + suffix + '"')
    .replace('"/app.js"', '"./app.js' + suffix + '"')
    .replaceAll("__ESCROW_BUILD_ID__", config.buildId));
  for (const module of ["app.js", "milestones.js"]) {
    let content = files.get(module).toString();
    for (const name of ["ethers.js", "diagnostics.js", "milestones.js"]) {
      content = content.replace('"/' + name + '"', '"./' + name + suffix + '"');
    }
    files.set(module, content
      .replaceAll('fetch("/config",', 'fetch("./config.json",')
      .replaceAll('fetch("/version",', 'fetch("./version.json",')
      .replaceAll("__ESCROW_BUILD_ID__", config.buildId));
  }
  files.set("config.json", JSON.stringify(config));
  const { mode, address, deploymentBlockHash, buildId } = config;
  files.set("version.json", JSON.stringify({ mode, chainId, address, deploymentBlockHash, buildId, contractVersion }));
  await fs.mkdir(directory, { recursive: true });
  await Promise.all([...files].map(([name, contents]) => fs.writeFile(path.join(directory, name), contents)));
  console.log("Built Escrow V" + contractVersion + " at " + directory + " (Build " + buildId + ")");
}

async function build() {
  const legacy = JSON.parse(await fs.readFile(path.join(root, "deployments/sepolia.json"), "utf8"));
  let latest = null;
  try {
    latest = JSON.parse(await fs.readFile(path.join(root, "deployments/sepolia-v2.json"), "utf8"));
    if (latest.contractVersion !== 2) throw new Error("Expected V2 deployment metadata");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  // The default URL keeps its existing contract. V2 has an explicit path and backlink.
  await renderSite(legacy, output, latest ? "./v2/" : null);
  if (latest) await renderSite(latest, path.join(output, "v2"), "../");
}

module.exports = { build, renderSite };
if (require.main === module) {
  build().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
