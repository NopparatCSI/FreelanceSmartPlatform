const assert = require("node:assert/strict");
const { mkdirSync } = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const { Interface, JsonRpcProvider, Wallet } = require("ethers");

const base = process.env.WALLET_URL || "http://127.0.0.1:8787";
const local = path.resolve(__dirname, "../.local");
// Public Hardhat development mnemonic. Use exclusively on the local test chain.
const client = Wallet.fromPhrase("test test test test test test test test test test test junk");

test("wallet-only mode rejects node signing and accepts an EIP-1193 wallet's signed transaction", { timeout: 30000 }, async () => {
  mkdirSync(local, { recursive: true });
  for (const key of ["TEMP", "TMP", "TMPDIR"]) process.env[key] = local;
  process.env.PLAYWRIGHT_BROWSERS_PATH ||= path.join(local, "browsers");
  const { chromium } = require("playwright-core");
  const browser = await chromium.launch();
  const rpc = new JsonRpcProvider(base + "/rpc", 31337, { batchMaxCount: 1, cacheTimeout: -1 });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(7000);
    const config = await (await page.request.get(base + "/config")).json();
    assert.equal(config.mode, "wallet");
    assert.equal(config.accounts, undefined);
    assert.equal(await rpc.getBlockNumber() >= config.deploymentBlock, true);
    const denied = await page.request.post(base + "/rpc", {
      headers: { Origin: base },
      data: { jsonrpc: "2.0", id: 1, method: "eth_sendTransaction",
        params: [{ from: client.address, to: config.address, data: "0x" }] },
    });
    assert.match((await denied.json()).error.message, /unavailable/);
    let connected = false;
    let failure = "rejected";
    const iface = new Interface(config.abi);
    const revertData = iface.encodeErrorResult("InvalidParties");
    let signedHash;
    await page.exposeFunction("localWalletRequest", async ({ method, params = [] }) => {
      if (method === "eth_requestAccounts") connected = true;
      if (method === "eth_requestAccounts" || method === "eth_accounts") {
        return connected ? [client.address.toLowerCase()] : [];
      }
      if (method === "eth_sendTransaction") {
        if (failure === "rejected") return { walletError: { code: 4001, message: "User rejected" } };
        if (failure === "nested") return { walletError: {
          code: -32603, message: "Internal JSON-RPC error.",
          data: { originalError: { code: -32000, message: "execution reverted", data: revertData } },
        } };
        const tx = params[0];
        assert.equal(tx.from.toLowerCase(), client.address.toLowerCase());
        assert.equal(tx.to.toLowerCase(), config.address.toLowerCase());
        const signed = await client.connect(rpc).sendTransaction({ to: tx.to, data: tx.data, value: tx.value });
        signedHash = signed.hash;
        return signed.hash;
      }
      return rpc.send(method, params);
    });
    await page.addInitScript(() => {
      window.ethereum = {
        async request(args) {
          const result = await window.localWalletRequest(args);
          if (result?.walletError) throw Object.assign(new Error(result.walletError.message), result.walletError);
          return result;
        },
      };
    });

    await page.goto(base);
    assert.equal(await page.locator("#role").isVisible(), false);
    const versionResponse = await page.request.get(base + "/version");
    assert.equal(versionResponse.headers()["x-escrow-build"], config.buildId);
    assert.equal((await versionResponse.json()).buildId, config.buildId);
    assert.match(await page.locator("#build-version").textContent(), new RegExp(config.buildId));
    const js = await page.request.get(base + "/app.js?v=" + config.buildId);
    assert.equal(js.ok(), true);
    assert.match(js.headers()["cache-control"], /no-store/);
    assert.equal((await page.request.get(base + "/app.js?v=old")).status(), 409);
    await page.getByRole("button", { name: "เชื่อม Wallet", exact: true }).click();
    await page.locator("#wallet-address").getByText(new RegExp("^" + client.address + "$", "i")).waitFor();
    await page.getByRole("button", { name: "สร้างข้อตกลงใหม่" }).click();
    await page.locator('[name="title"]').fill("ทดสอบลายเซ็นจาก Wallet");
    await page.locator('[name="details"]').fill("ส่งธุรกรรมที่ลงนามด้วยบัญชี Hardhat ผ่านโหมด Wallet");
    await page.locator('[name="freelancer"]').fill("0x70997970C51812dc3A010C7d01b50e0d17dc79C8");
    await page.locator('[name="fee"]').fill("0.5");
    const deadline = new Date(Date.now() + 86400000);
    deadline.setMinutes(deadline.getMinutes() - deadline.getTimezoneOffset());
    await page.locator('[name="deadline"]').fill(deadline.toISOString().slice(0, 16));
    const create = page.getByRole("button", { name: "สร้างข้อตกลง", exact: true });
    const before = await rpc.getTransactionCount(client.address);
    await create.click();
    await page.locator("#create-feedback").getByText("ยกเลิกรายการใน Wallet").waitFor();
    assert.equal(await rpc.getTransactionCount(client.address), before);

    failure = "nested";
    await create.click();
    await page.locator("#create-feedback").getByText("Wallet คู่สัญญาต้องต่างกันและต้องไม่ใช่ Wallet ผู้ตัดสิน").waitFor();
    const diagnostic = JSON.parse(await page.locator("#create-diagnostics pre").textContent());
    assert.equal(diagnostic.method, "eth_sendTransaction");
    assert.equal(diagnostic.errorCode, -32603);
    assert.equal(diagnostic.message, "Internal JSON-RPC error.");
    assert.equal(diagnostic.revertData, revertData);
    assert.equal(diagnostic.chainId, 31337);
    assert.equal(diagnostic.from.toLowerCase(), client.address.toLowerCase());
    assert.equal(diagnostic.providerError.some((layer) => layer.code === -32000), true);
    assert.equal(await rpc.getTransactionCount(client.address), before);

    failure = null;
    await create.click();
    await page.waitForFunction(() => document.querySelector("#feedback").textContent.startsWith("ยืนยันธุรกรรมแล้ว"));
    assert.ok(signedHash);
    await page.locator("#job-detail").getByRole("heading", { name: /ทดสอบลายเซ็นจาก Wallet/ }).waitFor();
    await page.locator(".history code").filter({ hasText: signedHash }).waitFor();
    const receipt = await rpc.getTransactionReceipt(signedHash);
    assert.equal(receipt.status, 1);
    assert.equal(receipt.from, client.address);
    const event = receipt.logs.find((log) => log.address === config.address && iface.parseLog(log)?.name === "JobCreated");
    assert.equal(iface.parseLog(event).args.client, client.address);
    if (process.env.CHECK_SCREENSHOTS === "1") {
      const evidence = path.resolve(__dirname, "../evidence");
      mkdirSync(evidence, { recursive: true });
      await page.screenshot({ path: path.join(evidence, "09-wallet-signed.png"), fullPage: true });
    }
  } finally {
    rpc.destroy();
    await browser.close();
  }
});
