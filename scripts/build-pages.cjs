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
  "styles.css": "web/styles.css",
  "diagnostics.js": "web/diagnostics.js",
  "ethers.js": "node_modules/ethers/dist/ethers.min.js",
};

async function build() {
  const manifest = JSON.parse(await fs.readFile(path.join(root, "deployments/sepolia.json"), "utf8"));
  if (manifest.chainId !== chainId || !Array.isArray(manifest.abi) ||
      !Number.isSafeInteger(manifest.deploymentBlock) || manifest.deploymentBlock < 1 ||
      !isHexString(manifest.deploymentBlockHash, 32)) {
    throw new Error("Expected a confirmed Sepolia deployment manifest");
  }

  const roles = {};
  for (const role of ["client", "freelancer", "arbiter"]) roles[role] = getAddress(manifest.roles[role]);
  if (new Set(Object.values(roles)).size !== 3) throw new Error("Expected three distinct addresses in the manifest");
  const config = {
    mode: "sepolia", chainId, networkName: "Sepolia", readRpcUrl, roles, abi: manifest.abi,
    address: getAddress(manifest.address), arbiter: roles.arbiter,
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
  files.set("app.js", files.get("app.js").toString()
    .replace('"/ethers.js"', '"./ethers.js' + suffix + '"')
    .replace('"/diagnostics.js"', '"./diagnostics.js' + suffix + '"')
    .replaceAll('fetch("/config",', 'fetch("./config.json",')
    .replaceAll('fetch("/version",', 'fetch("./version.json",')
    .replaceAll("__ESCROW_BUILD_ID__", config.buildId));
  files.set("config.json", JSON.stringify(config));
  const { mode, address, deploymentBlockHash, buildId } = config;
  files.set("version.json", JSON.stringify({ mode, chainId, address, deploymentBlockHash, buildId }));

  await fs.mkdir(output, { recursive: true });
  await Promise.all([...files].map(([name, contents]) => fs.writeFile(path.join(output, name), contents)));
  console.log("Built GitHub Pages site in dist-pages (Build " + buildId + ", Sepolia " + address + ")");
}

build().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
