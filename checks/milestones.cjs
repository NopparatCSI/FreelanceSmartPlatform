const assert = require("node:assert/strict");
const { mkdirSync } = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const { Interface } = require("ethers");

const base = process.env.DEMO_URL || "http://127.0.0.1:8787";
const local = path.resolve(__dirname, "../.local");

function due(days) {
  const date = new Date(Date.now() + days * 86400000);
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
  return date.toISOString().slice(0, 16);
}

test("V2 browser accepts terms, revises versions, pays installments, and settles both dispute outcomes", { timeout: 90000 }, async () => {
  mkdirSync(local, { recursive: true });
  for (const key of ["TEMP", "TMP", "TMPDIR"]) process.env[key] = local;
  process.env.PLAYWRIGHT_BROWSERS_PATH ||= path.join(local, "browsers");
  const evidence = path.resolve(__dirname, "../evidence");
  if (process.env.CHECK_SCREENSHOTS === "1") mkdirSync(evidence, { recursive: true });
  const { chromium } = require("playwright-core");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1360, height: 960 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("dialog", (dialog) => dialog.accept());
    await page.goto(base);
    const config = await (await page.request.get(base + "/config")).json();
    assert.equal(config.contractVersion, 2);
    const iface = new Interface(config.abi);
    const roles = page.locator("#role");
    const detail = page.locator("#job-detail");

    async function transaction(button) {
      await button.click();
      await page.waitForFunction(() => {
        const status = document.querySelector("#feedback");
        return status.classList.contains("error") || status.textContent.startsWith("ยืนยันธุรกรรมแล้ว");
      });
      assert.equal(await page.locator("#feedback").evaluate((item) => item.classList.contains("error")), false,
        await page.locator("#feedback").textContent() + " " + await page.locator("#rpc-diagnostics pre").textContent());
      await page.waitForFunction(() => !document.querySelector("#refresh").disabled);
    }

    async function rpc(method, params) {
      const response = await page.request.post(base + "/rpc", {
        data: { jsonrpc: "2.0", id: 1, method, params },
      });
      const result = await response.json();
      if (result.error) throw new Error(result.error.message);
      return result.result;
    }

    async function job() {
      const data = await rpc("eth_call", [{ to: config.address, data: iface.encodeFunctionData("getJob", [selected]) }, "latest"]);
      return iface.decodeFunctionResult("getJob", data)[0];
    }

    let selected = 0;
    async function create(title) {
      await roles.selectOption("client");
      await page.locator("#open-create").click();
      await page.locator('[name="title"]').fill(title);
      await page.locator('[name="details"]').fill("ขอบเขตงานเว็บไซต์ 3 งวด");
      await page.locator("#demo-address").click();
      for (const [index, [name, amount]] of [["ออกแบบ", "0.02"], ["พัฒนา", "0.03"], ["ส่งมอบ", "0.05"]].entries()) {
        if (index) await page.locator("#add-milestone").click();
        const row = page.locator(".milestone-input").nth(index);
        await row.getByLabel("ชื่องวด", { exact: true }).fill(name);
        await row.getByLabel("ขอบเขตและเกณฑ์รับงาน").fill("เกณฑ์รับงานของ " + name);
        await row.getByLabel("ค่าจ้างงวดนี้ (ETH)", { exact: true }).fill(amount);
        await row.getByLabel("กำหนดส่งงวดนี้").fill(due(index + 1));
        await row.getByLabel("จำนวนรอบแก้ที่รวมในค่าจ้าง").fill("1");
      }
      await transaction(page.getByRole("button", { name: "สร้างข้อตกลง", exact: true }));
      await detail.getByRole("heading", { name: new RegExp(title) }).waitFor();
      selected++;
      assert.equal((await job()).status, 0n);
      assert.equal(await detail.getByRole("button", { name: /ฝากครบ/ }).count(), 0);
      await roles.selectOption("freelancer");
      await transaction(detail.getByRole("button", { name: "ยอมรับข้อตกลงและรับงาน", exact: true }));
      assert.equal((await job()).status, 6n);
      await roles.selectOption("client");
      await transaction(detail.getByRole("button", { name: "ฝากครบทุกงวด 0.1 ETH", exact: true }));
      assert.equal((await job()).status, 1n);
    }

    async function submit(step, proof = "หลักฐานงาน") {
      await roles.selectOption("freelancer");
      await detail.getByLabel("URL หรือ Hash ผลงานงวด " + step, { exact: true }).fill(proof);
      await transaction(detail.getByRole("button", { name: /^(บันทึกส่งงานงวดนี้|ส่งงานแก้ไข)$/ }));
    }

    async function pay(step, amount) {
      await roles.selectOption("client");
      await transaction(detail.getByRole("button", { name: "อนุมัติและจ่ายงวด " + step + " · " + amount + " ETH", exact: true }));
    }

    async function dispute(payFreelancer) {
      await roles.selectOption("client");
      await detail.locator("summary").filter({ hasText: "มีปัญหากับงาน?" }).click();
      await detail.getByLabel("เหตุผลหรือ Hash หลักฐานของงวดนี้").fill("ตรวจหลักฐานงวดที่พิพาท");
      await transaction(detail.getByRole("button", { name: "เปิดข้อพิพาทงวดนี้", exact: true }));
      await roles.selectOption("freelancer");
      await detail.getByLabel("หลักฐานจากอีกฝ่าย", { exact: true }).fill("หลักฐานตอบกลับฟรีแลนซ์");
      await transaction(detail.getByRole("button", { name: "ส่งหลักฐานเพิ่มเติม", exact: true }));
      await roles.selectOption("arbiter");
      await detail.getByLabel("เหตุผลคำตัดสิน", { exact: true }).fill("ตรวจขอบเขตและหลักฐานแล้ว");
      await transaction(detail.getByRole("button", { name: payFreelancer ? /^จ่ายงวดที่พิพาท/ : /^คืนยอดที่เหลือและปิดงาน/ }));
    }

    await create("งานส่งแก้และจ่ายครบ");
    await submit(1, "v1-navigation");
    await roles.selectOption("client");
    assert.ok((await detail.getByRole("button", { name: /^อนุมัติและจ่ายงวด/ }).boundingBox()).y < 960,
      "The primary review action is visible in the desktop viewport");
    if (process.env.CHECK_SCREENSHOTS === "1") {
      await page.screenshot({ path: path.join(evidence, "10-v2-review.png"), fullPage: true });
    }
    await detail.locator("summary").filter({ hasText: "ผลงานยังไม่ครบ?" }).click();
    await detail.getByLabel("รายละเอียดที่ต้องแก้", { exact: true }).fill("แก้เมนูให้ตรงข้อตกลง");
    await transaction(detail.getByRole("button", { name: "ขอแก้ไขงาน", exact: true }));
    assert.equal((await job()).status, 7n);
    assert.equal((await job()).paidWei, 0n);
    await submit(1, "v2-navigation-fixed");
    await roles.selectOption("client");
    assert.equal(await detail.getByRole("button", { name: "ขอแก้ไขงาน", exact: true }).count(), 0);
    await pay(1, "0.02");
    assert.equal((await job()).paidWei, 20000000000000000n);
    assert.equal((await job()).escrowWei, 80000000000000000n);
    await submit(2);
    await pay(2, "0.03");
    await submit(3);
    await pay(3, "0.05");
    assert.equal((await job()).status, 4n);
    assert.equal((await job()).escrowWei, 0n);
    await detail.getByRole("tab", { name: "ประวัติ", exact: true }).click();
    await detail.locator(".history").getByText(/v1-navigation/).waitFor();
    await detail.locator(".history").getByText(/v2-navigation-fixed/).waitFor();
    if (process.env.CHECK_SCREENSHOTS === "1") {
      await page.screenshot({ path: path.join(evidence, "11-v2-revision-history.png"), fullPage: true });
    }

    await create("งานคืนเฉพาะยอดที่เหลือ");
    await submit(1);
    await pay(1, "0.02");
    await dispute(false);
    assert.equal((await job()).paidWei, 20000000000000000n);
    assert.equal((await job()).refundedWei, 80000000000000000n);
    assert.equal((await job()).escrowWei, 0n);
    assert.equal((await job()).status, 5n);
    assert.equal(await detail.locator(".milestone-card").getByText("คืนเงินแล้ว", { exact: true }).count(), 2);
    if (process.env.CHECK_SCREENSHOTS === "1") {
      await page.screenshot({ path: path.join(evidence, "12-v2-refund.png"), fullPage: true });
    }

    await create("งานผู้ตัดสินสั่งจ่ายงวด");
    await dispute(true);
    assert.equal((await job()).paidWei, 20000000000000000n);
    assert.equal((await job()).escrowWei, 80000000000000000n);
    assert.equal((await job()).currentMilestone, 1n);
    await submit(2);
    await pay(2, "0.03");
    await submit(3);
    await pay(3, "0.05");
    assert.equal((await job()).status, 4n);
    assert.equal(await rpc("eth_getBalance", [config.address, "latest"]), "0x0");

    // Search and tab keyboard navigation remain usable after a full payment flow.
    await page.locator("#job-search").fill("คืนเฉพาะ");
    assert.equal(await page.locator(".job-button").count(), 1);
    await page.locator("#job-search").fill("#99999");
    await page.getByText("ไม่พบงาน ลองเปลี่ยนคำค้นหาหรือสถานะ", { exact: true }).waitFor();
    await page.locator("#job-search").fill("");
    assert.equal(await page.locator(".job-button").count(), 3);
    const workTab = detail.getByRole("tab", { name: "ดำเนินงาน", exact: true });
    await workTab.focus();
    await page.keyboard.press("ArrowRight");
    assert.equal(await detail.getByRole("tab", { name: "ข้อตกลง", exact: true }).getAttribute("aria-selected"), "true");
    assert.equal(await detail.locator(".milestone-card[open]").count(), 0);
    await detail.locator(".milestone-summary").first().click();
    await detail.getByText("เกณฑ์รับงานของ ออกแบบ", { exact: true }).waitFor();
    await roles.selectOption("freelancer");
    assert.equal(await detail.getByRole("tab", { name: "ข้อตกลง", exact: true }).getAttribute("aria-selected"), "true");
    assert.equal(await detail.locator(".milestone-card[open]").count(), 1);
    await workTab.click();
    await page.setViewportSize({ width: 1920, height: 1080 });
    const box = await detail.boundingBox();
    assert.ok(box.width > 1100, "Large screens reserve a wide detail workspace");
    assert.ok(box.height < 500, "Completed work is concise by default");
    await page.setViewportSize({ width: 375, height: 850 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.equal(await page.locator(".jobs-panel").isVisible(), false);
    await detail.getByRole("button", { name: "← รายการงาน", exact: true }).click();
    assert.equal(await page.locator(".jobs-panel").isVisible(), true);
    await page.locator(".job-button").first().click();
    assert.equal(await page.locator(".jobs-panel").isVisible(), false);
    assert.equal(await detail.isVisible(), true);
    await roles.selectOption("client");
    await page.locator("#open-create").click();
    assert.ok(await page.evaluate(() => document.querySelector("#create-dialog").scrollWidth <= document.querySelector("#create-dialog").clientWidth));
    await page.keyboard.press("Escape");
    assert.equal(await page.locator("#create-dialog").isVisible(), false);
    assert.deepEqual(errors, []);
    if (process.env.CHECK_SCREENSHOTS === "1") {
      await page.screenshot({ path: path.join(evidence, "14-v2-mobile.png"), fullPage: true });
      await page.setViewportSize({ width: 1360, height: 960 });
      await page.screenshot({ path: path.join(evidence, "13-v2-completed.png"), fullPage: true });
    }
  } finally { await browser.close(); }
});
