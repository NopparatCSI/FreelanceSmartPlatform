const assert = require("node:assert/strict");
const { mkdirSync } = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const base = process.env.DEMO_URL || "http://127.0.0.1:8787";
const local = path.resolve(__dirname, "../.local");
const deadline = () => {
  const date = new Date(Date.now() + 86400000);
  const offset = date.getTimezoneOffset() * 60000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
};

test("browser verifies direct payment and both dispute outcomes on Ethereum Local", async () => {
  mkdirSync(local, { recursive: true });
  for (const key of ["TEMP", "TMP", "TMPDIR"]) process.env[key] = local;
  process.env.PLAYWRIGHT_BROWSERS_PATH ||= path.join(local, "browsers");
  const { chromium } = require("playwright-core");
  const options = { headless: true, executablePath: process.env.BROWSER_PATH };
  const evidence = path.resolve(__dirname, "../evidence");
  if (process.env.CHECK_SCREENSHOTS === "1") mkdirSync(evidence, { recursive: true });
  const browser = await chromium.launch(options);
  try {
    const context = await browser.newContext({ viewport: { width: 1360, height: 960 }, permissions: ["clipboard-read", "clipboard-write"] });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("dialog", (dialog) => dialog.accept());
    await page.goto(base);
    const config = await (await page.request.get(base + "/config")).json();
    assert.equal(config.mode, "demo");
    const watch = await context.newPage();
    await watch.goto(base);
    await watch.getByText("ยังไม่มีงาน สร้างข้อตกลงเพื่อเริ่มต้น", { exact: true }).waitFor();
    await page.bringToFront();
    const detail = page.locator("#job-detail");
    const summary = page.locator("#feedback");
    const role = page.locator("#role");

    async function shot(name, target = page) {
      if (process.env.CHECK_SCREENSHOTS === "1") {
        await target.screenshot({ path: path.join(evidence, name + ".png"), ...(target === page ? { fullPage: true } : {}) });
      }
    }

    async function transaction(trigger) {
      await trigger.click();
      await page.waitForFunction(() => document.querySelector("#feedback").textContent.startsWith("ยืนยันธุรกรรมแล้ว"));
      await page.waitForFunction(() => !document.querySelector("#refresh").disabled);
    }

    async function create(title) {
      await role.selectOption("client");
      await page.getByRole("button", { name: "สร้างข้อตกลงใหม่" }).click();
      await page.locator('[name="title"]').fill(title);
      await page.locator('[name="details"]').fill("ทดสอบธุรกรรมบน Ethereum Local");
      await page.getByRole("button", { name: "ใช้ Wallet ฟรีแลนซ์สาธิต" }).click();
      await page.locator('[name="fee"]').fill("0.5");
      await page.locator('[name="deadline"]').fill(deadline());
      await transaction(page.getByRole("button", { name: "สร้างข้อตกลง", exact: true }));
      await detail.getByRole("heading", { name: new RegExp(title) }).waitFor();
      if (title === "ทดสอบจ่ายค่าจ้าง") await shot("01-created", detail);
      await transaction(detail.getByRole("button", { name: "ฝาก 0.5 ETH", exact: true }));
      await detail.getByText("พักเงินแล้ว", { exact: true }).waitFor();
      if (title === "ทดสอบจ่ายค่าจ้าง") await shot("02-funded", detail);
    }

    async function balance(address) {
      const response = await page.request.post(base + "/rpc", {
        data: { jsonrpc: "2.0", id: 1, method: "eth_getBalance", params: [address, "latest"] },
      });
      return BigInt((await response.json()).result);
    }

    await create("ทดสอบจ่ายค่าจ้าง");
    await watch.bringToFront();
    await watch.locator("#locked").getByText("0.5 ETH", { exact: true }).waitFor({ timeout: 12000 });
    await watch.close();
    await page.bringToFront();
    await role.selectOption("freelancer");
    await detail.getByLabel("URL หรือ Hash ผลงาน").fill("https://example.com/work");
    await transaction(detail.getByRole("button", { name: "บันทึกส่งงาน" }));
    await detail.getByText("ส่งงานแล้ว", { exact: true }).waitFor();
    await shot("03-submitted", detail);
    await role.selectOption("client");
    const freelancerBefore = await balance(config.accounts.freelancer);
    await transaction(detail.getByRole("button", { name: "อนุมัติและจ่าย 0.5 ETH" }));
    await detail.getByText("จ่ายแล้ว", { exact: true }).waitFor();
    await detail.getByRole("tab", { name: "ประวัติ", exact: true }).click();
    await detail.getByText("จ่าย 0.5 ETH ให้ " + config.accounts.freelancer, { exact: false }).waitFor();
    const paidHash = (await summary.textContent()).match(/0x[0-9a-f]{64}/i)[0];
    const paidEvent = detail.locator(".history li").filter({ hasText: paidHash });
    assert.equal(await paidEvent.locator("code").count(), 1);
    assert.ok(await paidEvent.locator("time").getAttribute("datetime"));
    await paidEvent.getByRole("button", { name: "คัดลอก Hash" }).click();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), paidHash);
    await shot("04-approved", detail);
    assert.equal(await balance(config.accounts.freelancer), freelancerBefore + 500000000000000000n);
    assert.equal(await detail.getByRole("button", { name: /อนุมัติและจ่าย/ }).count(), 0);

    await create("ทดสอบคืนเงิน");
    await detail.locator("summary").filter({ hasText: "มีปัญหากับงาน?" }).click();
    await detail.getByLabel("เหตุผลหรือ Hash หลักฐาน").fill("ตกลงยุติงาน");
    await transaction(detail.getByRole("button", { name: "เปิดข้อพิพาท" }));
    await detail.getByText("มีข้อพิพาท", { exact: true }).waitFor();
    assert.equal(await detail.getByRole("button", { name: "คืนให้ผู้ว่าจ้าง" }).count(), 0);
    await role.selectOption("freelancer");
    await detail.getByLabel("หลักฐานจากอีกฝ่าย").fill("รับทราบการยุติงาน");
    await transaction(detail.getByRole("button", { name: "ส่งหลักฐานเพิ่มเติม" }));
    await role.selectOption("arbiter");
    await detail.getByLabel("เหตุผลคำตัดสิน").fill("คู่สัญญาตกลงยุติงานก่อนส่งมอบ");
    const clientBefore = await balance(config.accounts.client);
    await transaction(detail.getByRole("button", { name: "คืนให้ผู้ว่าจ้าง" }));
    await detail.getByText("คืนเงินแล้ว", { exact: true }).waitFor();
    await detail.getByText("คู่สัญญาตกลงยุติงานก่อนส่งมอบ", { exact: true }).waitFor();
    await detail.getByRole("tab", { name: "ประวัติ", exact: true }).click();
    await detail.getByText("คืน 0.5 ETH ให้ " + config.accounts.client, { exact: false }).waitFor();
    assert.equal(await balance(config.accounts.client), clientBefore + 500000000000000000n);
    await detail.getByRole("tab", { name: "ดำเนินงาน", exact: true }).click();
    await shot("06-dispute-refunded", detail);

    await create("ทดสอบผู้ตัดสินสั่งจ่าย");
    await role.selectOption("freelancer");
    await detail.getByLabel("URL หรือ Hash ผลงาน").fill("https://example.com/delivered");
    await transaction(detail.getByRole("button", { name: "บันทึกส่งงาน" }));
    await detail.locator("summary").filter({ hasText: "มีปัญหากับงาน?" }).click();
    await detail.getByLabel("เหตุผลหรือ Hash หลักฐาน").fill("ส่งไฟล์แล้ว รอชำระค่าจ้าง");
    await transaction(detail.getByRole("button", { name: "เปิดข้อพิพาท" }));
    await role.selectOption("client");
    await detail.getByLabel("หลักฐานจากอีกฝ่าย").fill("ได้รับไฟล์ครบตามข้อตกลง");
    await transaction(detail.getByRole("button", { name: "ส่งหลักฐานเพิ่มเติม" }));
    await role.selectOption("arbiter");
    await detail.getByLabel("เหตุผลคำตัดสิน").fill("ตรวจหลักฐานแล้วว่าฟรีแลนซ์ส่งมอบครบ");
    const disputedPayBefore = await balance(config.accounts.freelancer);
    await transaction(detail.getByRole("button", { name: "จ่ายให้ฟรีแลนซ์" }));
    await detail.getByRole("tab", { name: "ประวัติ", exact: true }).click();
    await detail.getByText("ผู้ตัดสินสั่งจ่ายค่าจ้าง").waitFor();
    assert.equal(await balance(config.accounts.freelancer), disputedPayBefore + 500000000000000000n);
    await detail.getByRole("tab", { name: "ดำเนินงาน", exact: true }).click();
    await detail.getByText("ตรวจหลักฐานแล้วว่าฟรีแลนซ์ส่งมอบครบ", { exact: true }).waitFor();
    await shot("05-dispute-paid", detail);
    assert.equal(await balance(config.address), 0n);
    assert.equal(await page.locator("#locked").textContent(), "0 ETH");

    await shot("07-desktop");
    await page.setViewportSize({ width: 375, height: 850 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await shot("08-mobile");
    await detail.getByRole("button", { name: "← รายการงาน", exact: true }).click();
    await page.locator("#job-filter").selectOption("5");
    assert.equal(await page.locator(".job-button").count(), 1);
    await page.locator(".job-button").click();
    await detail.getByText("คืนเงินแล้ว", { exact: true }).waitFor();
    await role.selectOption("client");
    const openCreate = page.getByRole("button", { name: "สร้างข้อตกลงใหม่" });
    await openCreate.click();
    await page.keyboard.press("Escape");
    assert.equal(await page.locator("#create-dialog").isVisible(), false);
    assert.equal(await openCreate.evaluate((element) => element === document.activeElement), true);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
