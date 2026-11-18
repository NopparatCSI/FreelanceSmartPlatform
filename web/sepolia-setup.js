import { getAddress, keccak256 } from "/ethers.js";

const $ = (id) => document.getElementById(id);
const feedback = $("feedback");
let plan;
let storageKey;
let active = false;

function notice(message, failed = false) {
  feedback.textContent = message;
  feedback.classList.toggle("error", failed);
}

async function waitForDeployment(hash) {
  $("transaction").href = "https://sepolia.etherscan.io/tx/" + hash;
  $("transaction").hidden = false;
  $("hash").value = hash;
  notice("รอ Receipt และการยืนยัน 2 บล็อกบน Sepolia…");
  for (let attempt = 0; attempt < 45; attempt++) {
    const response = await fetch("/deployment-receipt", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ hash }),
    });
    if (response.status === 200) {
      notice("บันทึกสัญญาแล้ว กำลังเปิดหน้า Escrow…");
      for (let retry = 0; retry < 30; retry++) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        const version = await fetch("/version").then((r) => r.ok ? r.json() : null).catch(() => null);
        if (version?.chainId === plan.chainId) {
          localStorage.removeItem(storageKey);
          location.replace("/");
          return;
        }
      }
      throw new Error("บันทึกสัญญาแล้ว กรุณารีเฟรชเพื่อเปิดหน้า Escrow");
    }
    if (response.status !== 202) {
      const result = await response.json();
      throw new Error(result.error || "ตรวจธุรกรรมไม่สำเร็จ");
    }
    await new Promise((resolve) => setTimeout(resolve, 4000));
  }
  throw new Error("ยังไม่พบ Receipt ที่ยืนยันแล้ว กดตรวจ Receipt อีกครั้งได้");
}

async function run(action) {
  if (active) return;
  active = true;
  $("deploy").disabled = true;
  $("register").disabled = true;
  try { await action(); }
  catch (error) {
    notice(error.code === 4001 ? "ยกเลิกคำขอใน MetaMask" : error.message, true);
  } finally {
    active = false;
    $("deploy").disabled = Boolean(localStorage.getItem(storageKey));
    $("register").disabled = false;
  }
}

async function init() {
  const response = await fetch("/deployment-plan", { cache: "no-store" });
  if (!response.ok) throw new Error("โหลดแผน Deploy ไม่สำเร็จ");
  plan = await response.json();
  if (plan.contractVersion === 2) {
    document.querySelector("h1").textContent = "ตั้งค่า Escrow V2";
    document.querySelector(".lead").textContent = "ยอมรับข้อตกลง ส่งแก้ และจ่ายค่าจ้างราย Milestone";
  }
  if (plan.chainId !== 11155111) throw new Error("แผน Deploy ต้องใช้ Sepolia");
  storageKey = "escrow-sepolia-deployment:" + keccak256(plan.data);
  const names = { client: "ผู้ว่าจ้าง", freelancer: "ฟรีแลนซ์", arbiter: "ผู้ตัดสิน" };
  for (const [role, address] of Object.entries(plan.roles)) {
    const item = document.createElement("div");
    const label = document.createElement("dt");
    const value = document.createElement("dd");
    label.textContent = names[role];
    value.className = "mono";
    value.textContent = address + " · " + plan.balances[role] + " ETH";
    item.append(label, value);
    $("roles").append(item);
  }

  $("deploy").addEventListener("click", () => run(async () => {
    const provider = window.ethereum;
    if (!provider?.request) throw new Error("เปิด URL นี้ในเบราว์เซอร์ที่ติดตั้ง MetaMask");
    await provider.request({ method: "eth_requestAccounts" });
    const chain = await provider.request({ method: "eth_chainId" });
    if (BigInt(chain) !== BigInt(plan.chainId)) {
      await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0xaa36a7" }] });
    }
    const [accounts, activeChain] = await Promise.all([
      provider.request({ method: "eth_accounts" }), provider.request({ method: "eth_chainId" }),
    ]);
    const from = accounts[0] ? getAddress(accounts[0]) : null;
    if (BigInt(activeChain) !== BigInt(plan.chainId)) throw new Error("เลือก Sepolia ใน MetaMask ก่อน Deploy");
    if (![plan.roles.client, plan.roles.freelancer].includes(from)) {
      throw new Error("เลือก Account 1 หรือ Account 2 ที่ได้รับอนุญาตให้เว็บไซต์นี้ใช้");
    }
    notice("ตรวจเครือข่าย Sepolia และค่า Gas ใน MetaMask แล้วจึงยืนยัน");
    const hash = await provider.request({ method: "eth_sendTransaction", params: [{ from, data: plan.data, value: "0x0" }] });
    localStorage.setItem(storageKey, hash);
    await waitForDeployment(hash);
  }));
  $("recover").addEventListener("submit", (event) => {
    event.preventDefault();
    run(() => waitForDeployment($("hash").value.trim()));
  });
  $("register").disabled = false;
  $("deploy").disabled = false;
  const pending = localStorage.getItem(storageKey);
  if (pending) await run(() => waitForDeployment(pending));
  else notice("เลือก Account 1 หรือ Account 2 ใน MetaMask แล้วกด Deploy");
}

init().catch((error) => notice(error.message, true));
