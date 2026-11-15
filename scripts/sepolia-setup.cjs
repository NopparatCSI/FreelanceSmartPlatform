const fs = require("node:fs/promises");
const path = require("node:path");
const http = require("node:http");
const { Contract, ContractFactory, formatEther } = require("ethers");
const { chainId, confirmedRoles, makeProvider, manifestPath, verifyChain } = require("./sepolia.cjs");

async function registerDeployment(provider, plan, hash, filePath = manifestPath) {
  if (typeof hash !== "string" || !/^0x[a-f0-9]{64}$/i.test(hash)) throw new Error("Invalid transaction hash");
  const [tx, receipt] = await Promise.all([provider.getTransaction(hash), provider.getTransactionReceipt(hash)]);
  if (!tx || !receipt) return null;
  if (tx.chainId !== BigInt(chainId) || tx.to !== null || tx.value !== 0n || tx.data !== plan.data ||
      ![plan.roles.client, plan.roles.freelancer].includes(tx.from) ||
      receipt.status !== 1 || !receipt.contractAddress || receipt.blockHash !== tx.blockHash) {
    throw new Error("Transaction does not match this Sepolia deployment plan");
  }
  if (await receipt.confirmations() < 2) return null;
  const contract = new Contract(receipt.contractAddress, plan.abi, provider);
  if (await contract.arbiter() !== plan.roles.arbiter) throw new Error("On-chain arbiter differs from the plan");
  const manifest = {
    chainId, roles: plan.roles, abi: plan.abi, address: receipt.contractAddress,
    deploymentTransaction: tx.hash, deploymentBlock: receipt.blockNumber, deploymentBlockHash: receipt.blockHash,
  };
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(manifest, null, 2) + "\n", { flag: "wx" });
  return manifest;
}

async function waitForWalletDeployment(host, port) {
  try {
    await fs.access(manifestPath);
    return;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const roles = confirmedRoles();
  const provider = makeProvider();
  const root = path.resolve(__dirname, "..");
  const origin = "http://" + host + ":" + port;
  try {
    await verifyChain(provider);
    const { abi, bytecode } = JSON.parse(await fs.readFile(path.join(
      root, "artifacts/contracts/FreelanceEscrow.sol/FreelanceEscrow.json"), "utf8"));
    const { data } = await new ContractFactory(abi, bytecode).getDeployTransaction(roles.arbiter);
    const plan = { roles, data, abi };
    const balances = Object.fromEntries(await Promise.all(Object.entries(roles).map(async ([role, address]) =>
      [role, formatEther(await provider.getBalance(address))]
    )));
    const pages = new Map([
      ["/", ["web/sepolia-setup.html", "text/html; charset=utf-8"]],
      ["/sepolia-setup.js", ["web/sepolia-setup.js", "text/javascript; charset=utf-8"]],
      ["/ethers.js", ["node_modules/ethers/dist/ethers.min.js", "text/javascript; charset=utf-8"]],
      ["/styles.css", ["web/styles.css", "text/css; charset=utf-8"]],
    ]);
    await new Promise((resolve, reject) => {
      let registering = false;
      const server = http.createServer(async (request, response) => {
        response.setHeader("Cache-Control", "no-store");
        response.setHeader("X-Content-Type-Options", "nosniff");
        response.setHeader("Content-Security-Policy", "default-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'");
        const json = (status, body) => {
          response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
          response.end(JSON.stringify(body));
        };
        if (request.headers.host !== host + ":" + port) return json(403, { error: "Use the exact setup URL" });
        try {
          if (request.method === "GET" && request.url === "/deployment-plan") {
            return json(200, { chainId, roles, data, balances });
          }
          if (request.method === "POST" && request.url === "/deployment-receipt") {
            if (request.headers.origin !== origin || !request.headers["content-type"]?.startsWith("application/json")) {
              return json(403, { error: "Open the setup page to register a transaction" });
            }
            if (registering) return json(409, { error: "Another receipt check is running" });
            registering = true;
            try {
              let body = "";
              for await (const chunk of request) {
                body += chunk;
                if (body.length > 1024) return json(413, { error: "Expected a transaction hash only" });
              }
              const { hash } = JSON.parse(body);
              const deployment = await registerDeployment(provider, plan, hash);
              if (!deployment) return json(202, { pending: true });
              console.log("Sepolia deployed:", deployment.address, "block", deployment.deploymentBlock);
              json(200, { address: deployment.address });
              server.close(resolve);
            } finally { registering = false; }
            return;
          }
          const file = request.method === "GET" && pages.get(request.url);
          if (!file) return json(404, { error: "Not found" });
          const contents = await fs.readFile(path.join(root, file[0]));
          response.writeHead(200, { "Content-Type": file[1] });
          response.end(contents);
        } catch (error) {
          const message = error.code ? "Request failed (" + error.code + ")" : error.message;
          if (!response.headersSent) json(400, { error: message });
        }
      });
      server.once("error", reject);
      server.listen(port, host, () => console.log("Sepolia setup:", origin));
    });
  } finally { provider.destroy(); }
}

module.exports = { registerDeployment, waitForWalletDeployment };
