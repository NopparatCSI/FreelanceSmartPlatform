const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash } = require("node:crypto");
const ethers = require("ethers");
const { loadDeployment, makeProvider } = require("./sepolia.cjs");
const root = path.resolve(__dirname, "..");
const { contractName, contractVersion } = require("./contract-version.cjs");

const host = "127.0.0.1";
const port = Number(process.env.PORT || 8787);
const origin = "http://" + host + ":" + port;
// MetaMask's extension sends RPC requests from its own origin, not the app's.
// It may read the chain and submit signed transactions, but never use demo signers.
const walletOrigin = "chrome-extension://nkbihfbeogaeaoehlefnkodbefgpgknn";
const mode = process.env.ESCROW_MODE || "sepolia";
if (!["demo", "wallet", "sepolia"].includes(mode)) throw new Error("Use ESCROW_MODE=demo, wallet or sepolia");

const staticFiles = {
  "/": ["web/index.html", "text/html; charset=utf-8"],
  "/diagnostics.js": ["web/diagnostics.js", "text/javascript; charset=utf-8"],
  "/milestones.js": ["web/milestones.js", "text/javascript; charset=utf-8"],
  "/app.js": ["web/app.js", "text/javascript; charset=utf-8"],
  "/styles.css": ["web/styles.css", "text/css; charset=utf-8"],
  "/ethers.js": ["node_modules/ethers/dist/ethers.min.js", "text/javascript; charset=utf-8"],
};
const readMethods = new Set([
  "eth_chainId", "net_version", "eth_blockNumber", "eth_call", "eth_getBalance",
  "eth_getCode", "eth_getBlockTransactionCountByNumber", "eth_getTransactionCount", "eth_getTransactionReceipt", "eth_getLogs",
  "eth_getBlockByNumber", "eth_getBlockByHash", "eth_getTransactionByHash", "eth_estimateGas",
  "eth_gasPrice", "eth_maxPriorityFeePerGas", "eth_feeHistory",
]);
const parserV1 = new ethers.Interface([
  "function createJob(address,uint256,uint64,string,string)",
  "function deposit(uint256) payable",
  "function submitWork(uint256,string)",
  "function approveAndPay(uint256)",
  "function openDispute(uint256,string)",
  "function submitDisputeResponse(uint256,string)",
  "function resolveDispute(uint256,bool,string)",
]);

async function readJson(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 128 * 1024) throw new Error("RPC request is too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(response, status, data) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(data));
}

async function attachLocal(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error("Invalid LOCAL_ATTACH_URL"); }
  if (url.protocol !== "http:" || url.hostname !== host || url.origin === origin ||
      url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("LOCAL_ATTACH_URL must be a different http://127.0.0.1:<port> origin");
  }
  const settings = await fetch(url.origin + "/config", { redirect: "error" });
  if (!settings.ok) throw new Error("Existing Local server did not return Contract configuration");
  const source = await settings.json();
  if (source.chainId !== 31337 || (source.contractVersion ?? 1) !== contractVersion || !Array.isArray(source.abi)) {
    throw new Error("Existing server is not an Ethereum Local deployment");
  }
  const address = ethers.getAddress(source.address);
  const arbiter = ethers.getAddress(source.arbiter);
  const walletRpcUrl = url.origin + "/rpc";
  const provider = new ethers.JsonRpcProvider(walletRpcUrl, 31337, { batchMaxCount: 1, cacheTimeout: -1 });
  try {
    const block = await provider.getBlock(source.deploymentBlock);
    if (!block || block.hash !== source.deploymentBlockHash ||
        await new ethers.Contract(address, source.abi, provider).arbiter() !== arbiter) {
      throw new Error("Existing Local deployment could not be verified");
    }
    return { provider, config: {
      address, arbiter, abi: source.abi, deploymentBlock: source.deploymentBlock,
      deploymentBlockHash: block.hash, chainId: 31337, networkName: "Ethereum Local", walletRpcUrl, mode, contractVersion,
    } };
  } catch (error) {
    provider.destroy();
    throw error;
  }
}

async function localDeployment() {
  if (mode === "wallet" && process.env.LOCAL_ATTACH_URL) return attachLocal(process.env.LOCAL_ATTACH_URL);
  const { artifacts, ethers, network } = require("hardhat");
  const [client, freelancer, arbiter] = await ethers.getSigners();
  const arbiterAddress = mode === "wallet" && process.env.ESCROW_ARBITER
    ? ethers.getAddress(process.env.ESCROW_ARBITER)
    : arbiter.address;
  const escrow = await ethers.deployContract(contractName, [arbiterAddress]);
  const receipt = await escrow.deploymentTransaction().wait();
  const address = await escrow.getAddress();
  const { abi } = await artifacts.readArtifact(contractName);
  const accounts = { client: client.address, freelancer: freelancer.address, arbiter: arbiter.address };
  const config = {
    address, deploymentBlock: receipt.blockNumber, deploymentBlockHash: receipt.blockHash,
    abi, arbiter: arbiterAddress, chainId: 31337, networkName: "Ethereum Local",
    mode, contractVersion, ...(mode === "demo" ? { accounts } : {}),
  };

  return { config, provider: network.provider };
}

async function main() {
  if (mode === "sepolia" && process.argv.includes("--setup")) {
    const { waitForWalletDeployment } = require("./sepolia-setup.cjs");
    await waitForWalletDeployment(host, port);
  }
  const provider = mode === "sepolia" ? makeProvider() : null;
  let chain;
  try {
    chain = provider ? { config: { ...await loadDeployment(provider), mode }, provider } : await localDeployment();
  } catch (error) {
    provider?.destroy();
    if (provider && error.code && error.code !== "ENOENT") {
      throw new Error("Could not verify the Sepolia deployment (" + error.code + "). Check your RPC settings.");
    }
    throw error;
  }
  const { config } = chain;
  const parser = config.contractVersion === 2 ? new ethers.Interface(config.abi) : parserV1;
  // Pin bytes for this server instance so a file edit cannot mix two builds.
  const files = new Map();
  const hash = createHash("sha256");
  for (const [route, [relative, type]] of Object.entries(staticFiles)) {
    const bytes = await fs.readFile(path.join(root, relative));
    files.set(route, { bytes, type });
    hash.update(route).update(bytes);
  }
  for (const file of ["scripts/serve.cjs", "scripts/sepolia.cjs"]) {
    hash.update(await fs.readFile(path.join(root, file)));
  }
  const buildId = hash.digest("hex").slice(0, 16);
  config.buildId = buildId;
  const assetVersion = "?v=" + buildId;
  for (const route of ["/", "/app.js", "/milestones.js"]) {
    const entry = files.get(route);
    entry.bytes = Buffer.from(entry.bytes.toString()
      .replaceAll('"/app.js"', '"/app.js' + assetVersion + '"')
      .replaceAll('"/styles.css"', '"/styles.css' + assetVersion + '"')
      .replaceAll('"/milestones.js"', '"/milestones.js' + assetVersion + '"')
      .replaceAll('"/diagnostics.js"', '"/diagnostics.js' + assetVersion + '"')
      .replaceAll('"/ethers.js"', '"/ethers.js' + assetVersion + '"')
      .replaceAll("__ESCROW_BUILD_ID__", buildId));
  }
  const demoAddresses = new Set(Object.values(config.accounts || {}).map((account) => account.toLowerCase()));

  async function rpc(call, fromApp) {
    const id = call?.id ?? null;
    const { method, params = [] } = call ?? {};
    try {
      if (!readMethods.has(method) && !(method === "eth_sendRawTransaction" && mode !== "sepolia" && !config.walletRpcUrl)) {
        if (method !== "eth_sendTransaction" || mode !== "demo" || !fromApp) throw new Error("RPC method is unavailable");
        const tx = params[0];
        if (!demoAddresses.has(tx?.from?.toLowerCase()) || tx?.to?.toLowerCase() !== config.address.toLowerCase()) {
          throw new Error("The demo account can transact with this escrow only");
        }
        if (!parser.parseTransaction({ data: tx.data, value: tx.value })) {
          throw new Error("Unknown escrow action");
        }
      }
      const result = await chain.provider.send(method, params);
      return { jsonrpc: "2.0", id, result };
    } catch (error) {
      const upstream = error.info?.error;
      const result = upstream || error;
      const code = typeof result.code === "number" ? result.code : -32000;
      const detail = result.data ?? error.data;
      const message = upstream?.message || error.shortMessage || error.message;
      // Do not echo upstream transport URLs or request bodies.
      if (mode === "sepolia" && !upstream) {
        return { jsonrpc: "2.0", id, error: { code, message: "Sepolia RPC request failed (" + (error.code || code) + ")" } };
      }
      if (mode !== "sepolia" && ["eth_estimateGas", "eth_sendTransaction", "eth_sendRawTransaction"].includes(method)) {
        let from = params[0]?.from;
        if (method === "eth_sendRawTransaction") {
          try { from = ethers.Transaction.from(params[0]).from; } catch { /* Invalid signed payload. */ }
        }
        const revertData = typeof detail === "string" ? detail : detail?.data;
        console.warn(JSON.stringify({
          buildId, method, code, message: String(message).slice(0, 500),
          revertData: /^0x[0-9a-f]*$/i.test(revertData || "") ? revertData.slice(0, 4098) : null,
          chainId: config.chainId, from: ethers.isAddress(from || "") ? from : null,
        }));
      }
      return {
        jsonrpc: "2.0", id,
        error: { code, message, data: detail },
      };
    }
  }

  const server = http.createServer(async (request, response) => {
    response.setHeader("Cache-Control", "no-store, max-age=0, must-revalidate");
    response.setHeader("X-Escrow-Build", buildId);
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Content-Security-Policy", "default-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    if (request.headers.host !== host + ":" + port) {
      return sendJson(response, 403, { error: "Open the exact loopback URL printed by the server" });
    }
    try {
      if (request.url === "/rpc" && (request.method === "POST" || request.method === "OPTIONS")) {
        const fromApp = request.headers.origin === origin;
        const fromWallet = request.headers.origin === walletOrigin;
        if (request.headers.origin && !fromApp && !fromWallet) {
          return sendJson(response, 403, { error: "Origin is not allowed" });
        }
        response.setHeader("Vary", "Origin");
        if (fromApp || fromWallet) {
          response.setHeader("Access-Control-Allow-Origin", request.headers.origin);
        }
        if (request.method === "OPTIONS") {
          if (!fromApp && !fromWallet) return sendJson(response, 403, { error: "Origin is required" });
          const requestedHeaders = (request.headers["access-control-request-headers"] || "")
            .toLowerCase().split(",").map((header) => header.trim()).filter(Boolean);
          if (request.headers["access-control-request-method"] !== "POST" ||
              requestedHeaders.some((header) => header !== "content-type")) {
            return sendJson(response, 403, { error: "Preflight is not allowed" });
          }
          response.setHeader("Access-Control-Allow-Methods", "POST");
          response.setHeader("Access-Control-Allow-Headers", "Content-Type");
          response.writeHead(204);
          return response.end();
        }
        if (!request.headers["content-type"]?.startsWith("application/json")) {
          return sendJson(response, 415, { error: "Expected application/json" });
        }
        const body = await readJson(request);
        const result = Array.isArray(body)
          ? await Promise.all(body.map((call) => rpc(call, fromApp)))
          : await rpc(body, fromApp);
        return sendJson(response, 200, result);
      }
      if (request.method === "GET" && request.url === "/config") return sendJson(response, 200, config);
      if (request.method === "GET" && request.url === "/version") {
        return sendJson(response, 200, { buildId, mode, chainId: config.chainId, address: config.address,
          deploymentBlockHash: config.deploymentBlockHash, contractVersion: config.contractVersion });
      }
      const [route, query] = request.url.split("?", 2);
      const file = request.method === "GET" && files.get(route);
      if (file) {
        if (query !== undefined && query !== "v=" + buildId) {
          return sendJson(response, 409, { error: "Build changed. Reload the page.", buildId });
        }
        response.writeHead(200, { "Content-Type": file.type });
        return response.end(file.bytes);
      }
      return sendJson(response, 404, { error: "Not found" });
    } catch (error) {
      console.error(error.message);
      if (!response.headersSent) sendJson(response, 400, { error: "Request failed" });
    }
  });
  server.listen(port, host, () => {
    console.log("DigitalWork Escrow: " + origin);
    console.log("Build " + buildId + " | " + config.networkName + " (" + config.chainId + ") | " + mode + " | " + config.address);
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
