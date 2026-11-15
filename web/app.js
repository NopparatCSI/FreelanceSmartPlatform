import {
  BrowserProvider, Contract, JsonRpcProvider, JsonRpcSigner, formatEther, getAddress, parseEther,
} from "/ethers.js";
import { readDiagnostic, trackWallet } from "/diagnostics.js";

const $ = (id) => document.getElementById(id);
const form = $("create-form");
const role = $("role");
const feedback = $("feedback");
const detail = $("job-detail");
const jobList = $("job-list");
const jobFilter = $("job-filter");
const createDialog = $("create-dialog");
const rpcUrl = location.origin + "/rpc";
const buildId = "__ESCROW_BUILD_ID__";
let buildOutdated = false;
let wallet;
const statuses = ["รอฝากเงิน", "พักเงินแล้ว", "ส่งงานแล้ว", "มีข้อพิพาท", "จ่ายแล้ว", "คืนเงินแล้ว"];
const statusClasses = ["created", "funded", "submitted", "disputed", "paid", "refunded"];
const errorMessages = {
  UnknownJob: "ไม่พบงานนี้บนเครือข่ายปัจจุบัน หากเพิ่งรีสตาร์ตเซิร์ฟเวอร์ ให้รีเฟรชหน้าเว็บและสร้างงานใหม่",
  InvalidArbiter: "Wallet ผู้ตัดสินไม่ถูกต้อง",
  InvalidParties: "Wallet คู่สัญญาต้องต่างกันและต้องไม่ใช่ Wallet ผู้ตัดสิน",
  InvalidFee: "ค่าจ้างต้องมากกว่า 0 ETH",
  InvalidDeadline: "กำหนดส่งต้องเป็นเวลาในอนาคต",
  InvalidText: "กรุณาระบุข้อความและตรวจสอบความยาว",
  Unauthorized: "Wallet นี้ไม่มีสิทธิ์ทำรายการ",
  InvalidStatus: "สถานะงานเปลี่ยนแล้ว กรุณารีเฟรชรายการ",
  DeadlinePassed: "เลยกำหนดส่งสำหรับรายการนี้แล้ว",
  IncorrectDeposit: "ยอดฝากต้องเท่ากับค่าจ้างของงาน",
  TransferFailed: "โอน ETH ไม่สำเร็จ เงินยังพักอยู่ใน Escrow",
};

let config;
let reader;
let signer;
let walletProvider;
let account;
let jobs = [];
let selectedId = null;
let busy = false;
let chainTime = 0;
let lastBlockHash;
let refreshQueue = Promise.resolve();

const dateFormat = new Intl.DateTimeFormat("th-TH-u-ca-gregory", {
  dateStyle: "medium", timeStyle: "medium",
});
const localDate = (timestamp) => dateFormat.format(new Date(Number(timestamp) * 1000));

function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}

function notice(message, isError = false) {
  feedback.textContent = message;
  feedback.classList.toggle("error", isError);
  $("create-feedback").textContent = createDialog.open ? message : "";
  $("create-feedback").classList.toggle("error", isError);
}

function contractErrorName(error) {
  const pending = [error];
  const visited = new Set();
  // Wallets can wrap revert bytes under data/originalError/info.error.
  // Do not inspect transaction calldata: it is not an error result.
  for (let index = 0; index < pending.length && index < 40; index++) {
    const value = pending[index];
    if (typeof value === "string") {
      if (/^0x(?:[0-9a-f]{2}){4,}$/i.test(value)) {
        try {
          const decoded = reader?.interface.parseError(value);
          if (decoded && Object.hasOwn(errorMessages, decoded.name)) return decoded.name;
        } catch { /* A provider can return unrelated or malformed data. */ }
      }
      continue;
    }
    if (!value || typeof value !== "object" || visited.has(value)) continue;
    visited.add(value);
    if (Object.hasOwn(errorMessages, value.revert?.name)) return value.revert.name;
    for (const key of ["data", "error", "originalError", "info", "cause"]) {
      if (value[key] !== undefined) pending.push(value[key]);
    }
  }
  return null;
}

function walletErrorMessage(error) {
  const name = contractErrorName(error);
  if (name) return errorMessages[name];
  const pending = [error];
  const visited = new Set();
  const codes = new Set();
  const messages = [];
  for (let index = 0; index < pending.length && index < 40; index++) {
    const value = pending[index];
    if (!value || typeof value !== "object" || visited.has(value)) continue;
    visited.add(value);
    if (value.code !== undefined) codes.add(value.code);
    const message = value.shortMessage || value.message;
    if (typeof message === "string" && message.trim()) messages.push(message);
    for (const key of ["error", "data", "originalError", "info", "cause"]) {
      if (value[key] && typeof value[key] === "object") pending.push(value[key]);
    }
  }
  const combined = messages.join("\n");
  if (codes.has(4001) || codes.has("ACTION_REJECTED")) return "ยกเลิกรายการใน Wallet";
  if (codes.has("INSUFFICIENT_FUNDS") || /insufficient funds|not enough funds|doesn.t have enough funds|insufficient balance/i.test(combined)) {
    return "ETH บน " + (config?.networkName || "เครือข่ายที่เลือก") + " ไม่พอสำหรับรายการและค่า Gas กรุณาตรวจยอดของ Wallet ที่เชื่อมอยู่";
  }
  if (/nonce too (low|high)|nonce has already been used/i.test(combined) || codes.has("NONCE_EXPIRED")) {
    return "ลำดับธุรกรรม (nonce) ของ Wallet ไม่ตรงกับเครือข่าย กรุณาตรวจธุรกรรมค้างใน MetaMask ก่อนลองใหม่";
  }
  if (codes.has(-32002)) return "มีคำขอรออยู่ใน MetaMask กรุณาเปิด Wallet เพื่อดำเนินการกับคำขอเดิมก่อน";
  if (codes.has(4900) || codes.has(4901)) return "Wallet ยังไม่เชื่อมต่อเครือข่ายที่แสดงบนหน้าเว็บ กรุณาตรวจ RPC และเชื่อมต่อใหม่";
  const detail = [...messages].reverse().find((message) =>
    !/^(could not coalesce error|internal json-rpc error\.?|internal error\.?|execution reverted(?: \(unknown custom error\))?)$/i.test(message.trim())
  );
  if (detail) return detail.slice(0, 500);
  if (codes.has("CALL_EXCEPTION")) {
    return "Contract ปฏิเสธรายการ แต่ Wallet ไม่ส่งสาเหตุที่อ่านได้กลับมา กรุณาตรวจบัญชี สถานะงาน และรีเฟรชหน้าเว็บ";
  }
  const rpcCode = [...codes].find((code) => typeof code === "number");
  return "Wallet/RPC ปฏิเสธคำขอโดยไม่ส่งรายละเอียด" + (rpcCode === undefined ? "" : " (รหัส " + rpcCode + ")") + " กรุณาเปิด MetaMask เพื่อตรวจข้อความของรายการ";
}

const diagnosticIds = ["rpc-diagnostics", "create-diagnostics"];

function report(error) {
  notice(walletErrorMessage(error), true);
  const diagnostic = readDiagnostic(error, wallet, {
    buildId, origin: location.origin, expectedChainId: config?.chainId ?? null,
    from: account, contract: config?.address ?? null, contractError: contractErrorName(error),
  });
  for (const id of diagnosticIds) {
    const panel = $(id);
    panel.querySelector("pre").textContent = JSON.stringify(diagnostic, null, 2);
    panel.hidden = false;
  }
}

function clearDiagnostics() {
  wallet?.failures.clear();
  for (const id of diagnosticIds) {
    const panel = $(id);
    panel.open = false;
    panel.hidden = true;
    panel.querySelector("button").textContent = "คัดลอกรายละเอียด RPC";
  }
}

async function verifyBuild() {
  const response = await fetch("/version", { cache: "no-store" });
  const current = response.ok ? await response.json() : null;
  if (current?.buildId === buildId &&
      current.deploymentBlockHash === config.deploymentBlockHash && current.mode === config.mode) return;
  buildOutdated = true;
  renderControls();
  throw new Error("หน้าเว็บกับเซิร์ฟเวอร์ใช้ Build หรือ Contract คนละรุ่น กรุณารีเฟรช (" +
    buildId + " / " + (current?.buildId || "เซิร์ฟเวอร์ไม่ระบุเวอร์ชัน") + ")");
}

function badge(status) {
  return node("span", statuses[status], "badge " + statusClasses[status]);
}

function sameAddress(first, second) {
  return first?.toLowerCase() === second?.toLowerCase();
}

function money(value) {
  return formatEther(value).replace(/\.0$/, "") + " ETH";
}

function limit(text, bytes, field) {
  const value = text.trim();
  if (!value || new TextEncoder().encode(value).length > bytes) {
    throw new Error(field + " ต้องมีข้อมูลและยาวไม่เกิน " + bytes + " ไบต์");
  }
  return value;
}

function useDemo() {
  walletProvider = null;
  wallet = null;
  account = config.accounts[role.value];
  signer = new JsonRpcSigner(reader.runner, account);
}

function renderControls() {
  const isArbiter = sameAddress(account, config.arbiter);
  const activeRole = account && config.roles
    ? Object.keys(config.roles).find((key) => sameAddress(account, config.roles[key])) : null;
  const demoFreelancer = config.mode === "demo" && !walletProvider && role.value === "freelancer";
  const canCreate = config.mode === "sepolia" ? activeRole === "client" : Boolean(account) && !isArbiter && !demoFreelancer;
  const names = { client: "ผู้ว่าจ้าง", freelancer: "ฟรีแลนซ์", arbiter: "ผู้ตัดสิน" };
  $("wallet-role").hidden = config.mode !== "sepolia" || !account;
  $("wallet-role").textContent = names[activeRole] || "บัญชีนี้อยู่นอกชุดทดสอบ";
  $("open-create").disabled = busy || buildOutdated || !canCreate;
  $("create-fields").disabled = busy || buildOutdated || !canCreate;
  $("close-create").disabled = busy;
  role.disabled = busy || Boolean(walletProvider);
  $("connect").disabled = busy;
  $("refresh").disabled = busy;
  $("connect").textContent = walletProvider ? "ตัดการเชื่อมต่อในหน้าเว็บ" : "เชื่อม Wallet";
  $("wallet-address").textContent = account || "เชื่อม Wallet แล้วเลือกเครือข่าย " + config.networkName;
}

function shouldDeferRefresh() {
  return busy || [...detail.querySelectorAll("textarea")].some((field) => field.value.trim() || field === document.activeElement);
}

function reload(auto = false) {
  const task = refreshQueue.catch(() => {}).then(async () => {
    if (auto && shouldDeferRefresh()) return;
    const block = await reader.runner.getBlock("latest");
    if (auto && block.hash === lastBlockHash) return;
    await loadJobs(block, auto);
  });
  refreshQueue = task;
  return task;
}

async function loadJobs(block, auto) {
  const blockTag = block.number;
  const count = await reader.jobCount({ blockTag });
  const result = [];
  for (let start = 1n; start <= count; start += 25n) {
    const ids = [];
    for (let id = start; id <= count && id < start + 25n; id++) ids.push(id);
    const batch = await Promise.all(ids.map(async (id) => ({ id, data: await reader.getJob(id, { blockTag }) })));
    result.push(...batch);
  }
  if (auto && shouldDeferRefresh()) return;
  chainTime = block.timestamp;
  lastBlockHash = block.hash;
  jobs = result.reverse();
  if (!jobs.some(({ id }) => id === selectedId)) selectedId = null;
  $("job-count").textContent = count.toString();
  $("locked").textContent = money(jobs.reduce((sum, job) => sum + job.data.escrowWei, 0n));
  $("disputed").textContent = jobs.filter((job) => job.data.status === 3n).length;
  renderList();
  await renderDetail();
}

function renderList() {
  jobList.replaceChildren();
  const visibleJobs = jobs.filter(({ data }) => jobFilter.value === "all" || data.status.toString() === jobFilter.value);
  if (!visibleJobs.length) {
    jobList.append(node("p", jobs.length ? "ไม่พบงานในสถานะนี้" : "ยังไม่มีงาน สร้างข้อตกลงเพื่อเริ่มต้น", "empty"));
    return;
  }
  for (const { id, data } of visibleJobs) {
    const button = node("button", undefined, "job-button");
    button.type = "button";
    button.setAttribute("aria-pressed", String(selectedId === id));
    button.disabled = busy;
    const label = node("span", undefined, "job-label");
    label.append(node("strong", data.title), node("small", "#" + id + " · " + money(data.feeWei)));
    button.append(label, badge(Number(data.status)));
    button.addEventListener("click", () => {
      selectedId = id;
      renderList();
      renderDetail().catch(report);
      if (window.matchMedia("(max-width: 790px)").matches) detail.querySelector("h2")?.focus();
      else jobList.querySelector('[aria-pressed="true"]')?.focus();
    });
    jobList.append(button);
  }
}

function actionButton(label, action, className = "primary") {
  const button = node("button", label, className);
  button.type = "button";
  button.disabled = busy;
  button.addEventListener("click", action);
  return button;
}

function textAction(label, buttonLabel, action) {
  const actionForm = node("form", undefined, "action-form");
  const field = node("label", label);
  const input = node("textarea");
  input.required = true;
  input.rows = 2;
  input.maxLength = 1000;
  input.disabled = busy;
  field.append(input);
  const button = node("button", buttonLabel, "secondary");
  button.type = "submit";
  button.disabled = busy;
  actionForm.append(field, button);
  actionForm.addEventListener("submit", (event) => {
    event.preventDefault();
    transact((contract) => action(contract, limit(input.value, 1000, label)));
  });
  return actionForm;
}

function describeLog(log) {
  switch (log.name) {
    case "JobCreated": return "สร้างข้อตกลง";
    case "Funded": return "ฝาก " + money(log.args.amount) + " เข้า Escrow";
    case "WorkSubmitted": return "บันทึกการส่งงาน";
    case "DisputeOpened": return "เปิดข้อพิพาท";
    case "EvidenceSubmitted": return "อีกฝ่ายส่งหลักฐาน";
    case "DisputeResolved": return "ผู้ตัดสินสั่ง" + (log.args.payFreelancer ? "จ่ายค่าจ้าง" : "คืนเงิน");
    case "Settled": return (log.args.outcome === 4n ? "จ่าย " : "คืน ") + money(log.args.amount) + " ให้ " + log.args.recipient;
    default: return log.name;
  }
}

async function renderDetail() {
  const job = jobs.find(({ id }) => id === selectedId);
  detail.replaceChildren();
  detail.hidden = !job;
  $("job-guide").hidden = Boolean(job);
  if (!job) return;

  const { id, data } = job;
  const status = Number(data.status);
  const isClient = sameAddress(account, data.client);
  const isFreelancer = sameAddress(account, data.freelancer);
  const isArbiter = sameAddress(account, config.arbiter);
  const now = Math.max(chainTime, Math.floor(Date.now() / 1000));

  const title = node("div", undefined, "row");
  const heading = node("h2", "#" + id + " · " + data.title);
  heading.tabIndex = -1;
  title.append(heading, badge(status));
  const facts = node("dl", undefined, "job-data");
  for (const [name, value, className] of [
    ["ค่าจ้าง", money(data.feeWei)],
    ["เงินที่พักอยู่", money(data.escrowWei)],
    ["กำหนดส่ง (เวลาเครื่อง)", localDate(data.deadline)],
    ["ผู้ว่าจ้าง", data.client, "mono"],
    ["ฟรีแลนซ์", data.freelancer, "mono"],
  ]) {
    const item = node("div");
    item.append(node("dt", name), node("dd", value, className));
    facts.append(item);
  }
  const nextSteps = [
    now < Number(data.deadline) ? "ผู้ว่าจ้างฝากค่าจ้างเต็มจำนวน" : "หมดเวลาฝากค่าจ้าง",
    now <= Number(data.deadline) ? "ฟรีแลนซ์บันทึกหลักฐานส่งงาน" : "คู่สัญญาเปิดข้อพิพาทได้",
    "ผู้ว่าจ้างตรวจผลงานและอนุมัติจ่าย",
    "ผู้ตัดสินตรวจหลักฐานและบันทึกคำตัดสิน",
    "โอนค่าจ้างให้ฟรีแลนซ์เรียบร้อย",
    "คืนค่าจ้างให้ผู้ว่าจ้างเรียบร้อย",
  ];
  const nextStep = node("p", undefined, "next-step");
  nextStep.append(node("strong", status < 4 ? "ขั้นตอนถัดไป" : "ผลการชำระเงิน"), node("span", nextSteps[status]));
  detail.append(title, nextStep, node("p", data.details, "prewrap"), facts);
  for (const [label, value] of [
    ["หลักฐานส่งงาน", data.workProof],
    ["หลักฐานผู้เปิดข้อพิพาท", data.disputeEvidence],
    ["หลักฐานจากอีกฝ่าย", data.disputeResponse],
    ["เหตุผลคำตัดสิน", data.rulingReason],
  ]) {
    if (value) detail.append(node("h3", label), node("p", value, "mono prewrap"));
  }

  const actions = node("div", undefined, "actions");
  if (status === 0 && isClient && now < Number(data.deadline)) {
    actions.append(actionButton("ฝาก " + money(data.feeWei), () => transact(
      (contract) => contract.deposit(id, { value: data.feeWei }),
    )));
  }
  if (status === 1 && isFreelancer && now <= Number(data.deadline)) {
    detail.append(textAction("URL หรือ Hash ผลงาน", "บันทึกส่งงาน",
      (contract, proof) => contract.submitWork(id, proof),
    ));
  }
  if (status === 2 && isClient) {
    actions.append(actionButton("อนุมัติและจ่าย " + money(data.feeWei), () => {
      if (window.confirm("ยืนยันโอน " + money(data.feeWei) + " ให้ฟรีแลนซ์?")) {
        transact((contract) => contract.approveAndPay(id));
      }
    }));
  }
  if (status === 3 && isArbiter) {
    const ruling = node("form", undefined, "action-form");
    const label = node("label", "เหตุผลคำตัดสิน");
    const reason = node("textarea");
    reason.required = true;
    reason.rows = 2;
    reason.disabled = busy;
    reason.maxLength = 1000;
    label.append(reason);
    const choices = node("div", undefined, "actions");
    for (const [pay, title] of [[true, "จ่ายให้ฟรีแลนซ์"], [false, "คืนให้ผู้ว่าจ้าง"]]) {
      const button = node("button", title, pay ? "primary" : "secondary danger");
      button.type = "submit";
      button.value = String(pay);
      button.disabled = busy;
      choices.append(button);
    }
    ruling.append(label, choices);
    ruling.addEventListener("submit", (event) => {
      event.preventDefault();
      if (!event.submitter) return;
      if (!window.confirm("ยืนยัน" + event.submitter.textContent + " " + money(data.escrowWei) + "?")) return;
      const pay = event.submitter.value === "true";
      transact((contract) => contract.resolveDispute(id, pay, limit(reason.value, 1000, "เหตุผลคำตัดสิน")));
    });
    detail.append(ruling);
  }
  if (actions.children.length) detail.append(actions);
  if ((status === 1 || status === 2) && (isClient || isFreelancer)) {
    detail.append(textAction("เหตุผลหรือ Hash หลักฐาน", "เปิดข้อพิพาท",
      (contract, evidence) => contract.openDispute(id, evidence),
    ));
  }
  if (status === 3) {
    if ((isClient || isFreelancer) && !sameAddress(account, data.disputeOpenedBy) && !data.disputeResponse) {
      detail.append(textAction("หลักฐานจากอีกฝ่าย", "ส่งหลักฐานเพิ่มเติม",
        (contract, evidence) => contract.submitDisputeResponse(id, evidence),
      ));
    }
    detail.append(node("p", "เงินจะพักอยู่จนกว่าผู้ตัดสินจะชี้ขาด ระบบไม่กำหนดเวลาตัดสินหรือเปลี่ยนผู้ตัดสิน", "muted"));
  }
  if ((status === 0 || status === 1) && now > Number(data.deadline)) {
    detail.append(node("p", status === 1
      ? "เลยกำหนดส่งแล้ว คู่สัญญาเปิดข้อพิพาทเพื่อขอให้ผู้ตัดสินชี้ขาดได้"
      : "เลยกำหนดส่งแล้ว ข้อตกลงนี้ยังไม่มีเงินฝาก", "muted"));
  }

  const history = node("ol", undefined, "history");
  history.append(node("li", "กำลังอ่าน Event…"));
  detail.append(node("h3", "ประวัติธุรกรรม"), history);
  try {
    const jobTopic = "0x" + id.toString(16).padStart(64, "0");
    const logs = await reader.runner.getLogs({
      address: config.address,
      fromBlock: config.deploymentBlock,
      toBlock: "latest",
      topics: [null, jobTopic],
    });
    logs.sort((a, b) => a.blockNumber - b.blockNumber || a.index - b.index);
    const blocks = new Map();
    await Promise.all([...new Set(logs.map((log) => log.blockHash))].map(async (hash) => {
      const block = await reader.runner.getBlock(hash);
      if (block) blocks.set(hash, block.timestamp);
    }));
    history.replaceChildren();
    if (!logs.length) history.append(node("li", "ไม่พบธุรกรรมของงานนี้"));
    for (const log of logs) {
      const parsed = reader.interface.parseLog(log);
      if (!parsed) continue;
      const item = node("li", describeLog(parsed));
      const timestamp = blocks.get(log.blockHash);
      const meta = node("small", "Block " + log.blockNumber + " · ");
      if (timestamp !== undefined) {
        const time = node("time", localDate(timestamp));
        time.dateTime = new Date(timestamp * 1000).toISOString();
        meta.append(time, " · เวลาเครื่อง");
      }
      const hash = node("code", log.transactionHash, "mono");
      const copy = node("button", "คัดลอก Hash", "secondary copy");
      copy.type = "button";
      copy.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(log.transactionHash);
          copy.textContent = "คัดลอกแล้ว";
          notice("คัดลอก Transaction Hash แล้ว");
        } catch {
          notice("คัดลอกอัตโนมัติไม่ได้ กรุณาเลือกข้อความ Hash", true);
        }
      });
      const transaction = node("div", undefined, "transaction");
      transaction.append(hash, copy);
      if (config.mode === "sepolia") {
        const explorer = node("a", "Etherscan");
        explorer.href = "https://sepolia.etherscan.io/tx/" + log.transactionHash;
        explorer.target = "_blank";
        explorer.rel = "noopener noreferrer";
        transaction.append(explorer);
      }
      item.append(meta, transaction);
      history.append(item);
    }
  } catch {
    history.replaceChildren(node("li", "อ่านประวัติไม่ได้ กรุณากดรีเฟรช"));
  }
}

async function transact(action, onSuccess) {
  if (busy || buildOutdated || !signer) return;
  clearDiagnostics();
  busy = true;
  renderControls();
  jobList.querySelectorAll("button").forEach((button) => { button.disabled = true; });
  detail.querySelectorAll("button, textarea").forEach((element) => { element.disabled = true; });
  notice("กำลังส่งธุรกรรม…");
  try {
    await verifyBuild();
    const activeSigner = signer;
    if (walletProvider) {
      const activeAddress = await activeSigner.getAddress();
      const [chain, accounts] = await Promise.all([
        wallet.request({ method: "eth_chainId" }),
        wallet.request({ method: "eth_accounts" }),
      ]);
      if (BigInt(chain) !== BigInt(config.chainId) || !sameAddress(accounts[0], activeAddress)) {
        throw new Error("บัญชีหรือเครือข่ายใน Wallet เปลี่ยนไป กรุณาเชื่อมต่อใหม่");
      }
      const block = await wallet.request({
        method: "eth_getBlockByNumber", params: ["0x" + config.deploymentBlock.toString(16), false],
      });
      if (block?.hash !== config.deploymentBlockHash) throw new Error("RPC ของ Wallet ไม่ตรงกับ Contract ที่หน้าเว็บกำลังใช้งาน");
    }
    const tx = await action(reader.connect(activeSigner));
    notice("กำลังรอยืนยัน · " + tx.hash);
    const receipt = await tx.wait();
    if (receipt.status !== 1) throw new Error("ธุรกรรมไม่สำเร็จ");
    onSuccess?.(receipt);
    notice("ยืนยันธุรกรรมแล้ว · " + receipt.hash);
  } catch (error) {
    report(error);
  } finally {
    busy = false;
    renderControls();
    try { await reload(); } catch (error) { report(error); }
  }
}

async function syncWallet() {
  if (!walletProvider) return;
  const provider = walletProvider;
  const [chainId, accounts] = await Promise.all([
    wallet.request({ method: "eth_chainId" }),
    wallet.request({ method: "eth_accounts" }),
  ]);
  let nextAccount = BigInt(chainId) === BigInt(config.chainId) ? accounts[0] : null;
  if (nextAccount) {
    const deployment = await wallet.request({
      method: "eth_getBlockByNumber", params: ["0x" + config.deploymentBlock.toString(16), false],
    });
    if (deployment?.hash !== config.deploymentBlockHash) nextAccount = null;
  }
  const nextSigner = nextAccount ? await provider.getSigner(nextAccount) : null;
  if (walletProvider !== provider) return;
  account = nextAccount || null;
  signer = nextSigner;
  if (!account) notice("เลือกบัญชีและเครือข่าย " + config.networkName + " ให้ตรงกับหน้านี้ (Chain ID " + config.chainId + ")" + (config.mode === "sepolia" ? "" : " · RPC " + (config.walletRpcUrl || rpcUrl)), true);
  renderControls();
  await renderDetail();
}

async function connectWallet() {
  if (walletProvider) {
    if (config.mode === "demo") useDemo();
    else {
      walletProvider = null;
      wallet = null;
      account = null;
      signer = null;
    }
    notice("");
    renderControls();
    await renderDetail();
    return;
  }
  if (!window.ethereum?.request) throw new Error("ไม่พบ Wallet Extension ในเบราว์เซอร์");
  clearDiagnostics();
  wallet = trackWallet(window.ethereum);
  await wallet.request({ method: "eth_requestAccounts" });
  const current = await wallet.request({ method: "eth_chainId" });
  if (BigInt(current) !== BigInt(config.chainId)) {
    const chainId = "0x" + config.chainId.toString(16);
    try {
      await wallet.request({ method: "wallet_switchEthereumChain", params: [{ chainId }] });
    } catch (error) {
      if (error.code !== 4902) throw error;
      if (config.mode === "sepolia") throw new Error("เปิด Show test networks ใน MetaMask แล้วเลือก Sepolia ก่อนเชื่อม Wallet", { cause: error });
      await wallet.request({
        method: "wallet_addEthereumChain",
        params: [{ chainId, chainName: "DigitalWork Local", rpcUrls: [config.walletRpcUrl || rpcUrl],
          nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 } }],
      });
      await wallet.request({ method: "wallet_switchEthereumChain", params: [{ chainId }] });
    }
  }
  walletProvider = new BrowserProvider({ request: wallet.request }, "any");
  notice("");
  await syncWallet();
}

async function init() {
  const response = await fetch("/config", { cache: "no-store" });
  if (!response.ok) throw new Error("โหลดข้อมูล Contract ไม่สำเร็จ");
  config = await response.json();
  $("build-version").textContent = "Build " + buildId + " · server " + (config.buildId || "ไม่ระบุเวอร์ชัน");
  await verifyBuild();
  $("network-label").textContent = config.networkName + " · Chain ID " + config.chainId;
  $("scope").textContent = config.mode === "sepolia"
    ? "Sepolia Testnet · ETH ทดสอบ · เก็บรายการบนเชน"
    : "Ethereum Local · ETH จำลอง · ข้อมูลรีเซ็ตเมื่อเริ่มเซิร์ฟเวอร์ใหม่";
  for (const id of diagnosticIds) {
    const panel = $(id);
    const button = panel.querySelector("button");
    button.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(panel.querySelector("pre").textContent);
        button.textContent = "คัดลอกแล้ว";
      } catch { button.textContent = "เลือกและคัดลอกข้อความด้านบน"; }
    });
  }
  const provider = new JsonRpcProvider(rpcUrl, config.chainId, { batchMaxCount: 1, cacheTimeout: -1 });
  reader = new Contract(config.address, config.abi, provider);
  if (config.mode === "demo") {
    useDemo();
    role.hidden = false;
    $("demo-address").hidden = false;
    $("scope").append(" · โหมดสาธิตส่งธุรกรรมแทนบัญชีจำลอง");
  } else {
    $("scope").append(" · Wallet ต้องลงนามทุกธุรกรรม");
  }

  $("contract-address").textContent = "Contract · " + config.address;
  $("demo-address").addEventListener("click", () => {
    form.elements.freelancer.value = config.accounts.freelancer;
  });
  $("connect").addEventListener("click", async () => {
    $("connect").disabled = true;
    try { await connectWallet(); } catch (error) { report(error); }
    finally { renderControls(); }
  });
  $("refresh").addEventListener("click", () => reload().catch(report));
  $("open-create").addEventListener("click", () => {
    notice("");
    clearDiagnostics();
    if (config.mode === "sepolia") {
      if (!sameAddress(account, config.roles.client)) return;
      form.elements.freelancer.value = config.roles.freelancer;
      form.elements.freelancer.readOnly = true;
    }
    createDialog.showModal();
  });
  $("close-create").addEventListener("click", () => createDialog.close());
  createDialog.addEventListener("cancel", (event) => {
    if (busy) event.preventDefault();
  });
  jobFilter.addEventListener("change", () => {
    const job = jobs.find(({ id }) => id === selectedId);
    if (job && jobFilter.value !== "all" && job.data.status.toString() !== jobFilter.value) {
      selectedId = null;
      renderDetail().catch(report);
    }
    renderList();
  });
  role.addEventListener("change", () => {
    if (config.mode !== "demo") return;
    useDemo();
    notice("");
    renderControls();
    renderDetail().catch(report);
  });
  for (const event of ["chainChanged", "accountsChanged"]) {
    window.ethereum?.on?.(event, () => syncWallet().catch(report));
  }
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    transact(async (contract) => {
      const title = limit(form.elements.title.value, 240, "ชื่อโครงการ");
      const details = limit(form.elements.details.value, 2400, "รายละเอียดงาน");
      let freelancer;
      let fee;
      try { freelancer = getAddress(form.elements.freelancer.value.trim()); }
      catch { throw new Error("Wallet ฟรีแลนซ์ต้องเป็น Ethereum Address ที่ถูกต้อง"); }
      if (config.mode === "sepolia" &&
          (!sameAddress(await contract.runner.getAddress(), config.roles.client) || !sameAddress(freelancer, config.roles.freelancer))) {
        throw new Error("ใช้ Wallet ผู้ว่าจ้างและฟรีแลนซ์ที่กำหนดสำหรับการทดสอบ Sepolia");
      }
      if (sameAddress(freelancer, account)) {
        throw new Error("Wallet ฟรีแลนซ์ต้องเป็นคนละบัญชีกับผู้ว่าจ้างที่เชื่อมอยู่ กรุณาใช้ที่อยู่ของฟรีแลนซ์อีกบัญชี");
      }
      if (sameAddress(freelancer, config.arbiter) || sameAddress(account, config.arbiter)) {
        throw new Error("Wallet ผู้ตัดสินใช้เป็นผู้ว่าจ้างหรือฟรีแลนซ์ของงานไม่ได้");
      }
      if (freelancer === "0x0000000000000000000000000000000000000000") {
        throw new Error("Wallet ฟรีแลนซ์ต้องไม่ใช่ Zero Address");
      }
      try { fee = parseEther(form.elements.fee.value.trim()); }
      catch { throw new Error("กรอกค่าจ้างเป็น ETH เช่น 0.50"); }
      if (fee <= 0n) throw new Error("ค่าจ้างต้องมากกว่า 0 ETH");
      const deadline = Math.floor(new Date(form.elements.deadline.value).getTime() / 1000);
      if (!Number.isFinite(deadline) || deadline <= Math.floor(Date.now() / 1000)) {
        throw new Error("กำหนดส่งต้องเป็นเวลาในอนาคต");
      }
      const balance = await reader.runner.getBalance(await contract.runner.getAddress());
      if (balance === 0n) {
        throw Object.assign(new Error("insufficient funds"), { code: "INSUFFICIENT_FUNDS", rpcMethod: "eth_getBalance" });
      }
      return contract.createJob(freelancer, fee, deadline, title, details);
    }, (receipt) => {
      const creation = receipt.logs.filter((log) => sameAddress(log.address, config.address))
        .map((log) => reader.interface.parseLog(log))
        .find((log) => log?.name === "JobCreated" && sameAddress(log.args.client, receipt.from));
      if (!creation) throw new Error("ธุรกรรมยืนยันแล้วแต่ไม่พบ JobCreated กรุณาตรวจ Receipt " + receipt.hash + " ก่อนลองใหม่");
      form.reset();
      createDialog.close();
      jobFilter.value = "all";
      selectedId = creation.args.jobId;
    });
  });
  await reload();
  renderControls();
  setInterval(() => {
    if (document.visibilityState === "visible" && !buildOutdated && !busy) verifyBuild().then(() => reload(true)).catch((error) => {
      if (buildOutdated) report(error);
    });
  }, 4000);
}

init().catch(report);
