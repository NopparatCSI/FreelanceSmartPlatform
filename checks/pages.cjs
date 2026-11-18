const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const http = require("node:http");
const { once } = require("node:events");
const { artifacts, ethers, network } = require("hardhat");
const { renderSite } = require("../scripts/build-pages.cjs");

async function main() {
  const local = path.resolve(".local");
  process.env.PLAYWRIGHT_BROWSERS_PATH ||= path.join(local, "browsers");
  const { chromium } = require("playwright-core");
  const [client, freelancer, arbiter] = await ethers.getSigners();
  const v1 = await ethers.deployContract("FreelanceEscrow", [arbiter.address]);
  const v2 = await ethers.deployContract("FreelanceEscrowV2", [arbiter.address]);
  const due = (await ethers.provider.getBlock("latest")).timestamp + 86400;
  await (await v1.createJob(freelancer.address, 1, due, "Legacy job", "Original agreement")).wait();
  await (await v2.createJob(freelancer.address, "Milestone job", "New agreement", [
    { title: "Design", scope: "Screen layout", amountWei: 1, deadline: due, maxRevisions: 1 },
    { title: "Files", scope: "Project files", amountWei: 2, deadline: due + 3600, maxRevisions: 1 },
  ])).wait();
  await (await v2.connect(freelancer).acceptAgreement(1)).wait();
  await (await v2.deposit(1, { value: 3 })).wait();
  await (await v2.connect(freelancer).submitWork(1, 0, "First submission")).wait();

  const directory = await fs.mkdtemp(path.join(local, "pages-"));
  for (const [contract, version, folder, otherVersionUrl] of [
    [v1, 1, directory, "./v2/"],
    [v2, 2, path.join(directory, "v2"), "../"],
  ]) {
    const receipt = await contract.deploymentTransaction().wait();
    const artifact = await artifacts.readArtifact(version === 2 ? "FreelanceEscrowV2" : "FreelanceEscrow");
    await renderSite({
      chainId: 11155111, contractVersion: version, address: await contract.getAddress(), abi: artifact.abi,
      deploymentBlock: receipt.blockNumber, deploymentBlockHash: receipt.blockHash,
      roles: { client: client.address, freelancer: freelancer.address, arbiter: arbiter.address },
    }, folder, otherVersionUrl);
  }

  const base = "/FreelanceSmartPlatform/";
  const server = http.createServer(async (request, response) => {
    const resource = new URL(request.url, "http://localhost").pathname;
    const allowed = /^(?:v2\/)?(?:index\.html|app\.js|milestones\.js|styles\.css|diagnostics\.js|ethers\.js|config\.json|version\.json)$/;
    let file = resource.startsWith(base) ? resource.slice(base.length) : null;
    if (file === "") file = "index.html";
    if (file === "v2/") file = "v2/index.html";
    if (!file || !allowed.test(file)) { response.writeHead(404); response.end(); return; }
    const type = { html: "text/html", js: "text/javascript", css: "text/css", json: "application/json" }[file.split(".").at(-1)];
    try {
      const content = await fs.readFile(path.join(directory, file));
      response.writeHead(200, { "Content-Type": type + "; charset=utf-8" });
      response.end(content);
    } catch { response.writeHead(404); response.end(); }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("response", (response) => {
      if (response.url().includes("127.0.0.1") && response.status() >= 400) errors.push(response.url());
    });
    // Read actual Hardhat state through the public RPC URL expected by the exported page.
    await page.route("https://ethereum-sepolia-rpc.publicnode.com/", async (route) => {
      const call = route.request().postDataJSON();
      const result = call.method === "eth_chainId" ? "0xaa36a7" : await network.provider.send(call.method, call.params);
      await route.fulfill({ json: { jsonrpc: "2.0", id: call.id, result } });
    });
    await page.goto("http://127.0.0.1:" + server.address().port + base);
    await page.locator(".job-button").filter({ hasText: "Legacy job" }).click();
    await page.getByRole("tab", { name: "ประวัติ", exact: true }).click();
    await page.locator(".history code").waitFor();
    await page.getByRole("link", { name: "เปิดงาน Milestone V2" }).click();
    await page.locator(".job-button").filter({ hasText: "Milestone job" }).click();
    await page.getByRole("tab", { name: "ประวัติ", exact: true }).click();
    await page.locator(".history").getByText(/First submission/).waitFor();
    assert.equal(await page.locator(".milestone-card").count(), 2);
    assert.equal(await page.locator(".history").getByRole("link", { name: "Etherscan" }).count(), 4);
    await page.getByRole("link", { name: "เปิดงานในสัญญา V1 เดิม" }).click();
    await page.locator(".job-button").filter({ hasText: "Legacy job" }).waitFor();
    assert.deepEqual(errors, []);
    console.log("Pages V1/V2 verified under /FreelanceSmartPlatform/, with isolated state, history, and navigation.");
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
