import { formatEther, parseEther } from "/ethers.js";

const $ = (id) => document.getElementById(id);
const milestoneStatuses = ["รอดำเนินการ", "รอตรวจงาน", "รอแก้ไข", "จ่ายแล้ว", "มีข้อพิพาท", "คืนเงินแล้ว"];

export function setupMilestoneForm() {
  $("legacy-payment").hidden = true;
  for (const control of $("legacy-payment").querySelectorAll("input")) {
    control.disabled = true;
    control.required = false;
  }
  $("milestone-fields").hidden = false;
  const list = $("milestone-inputs");
  function update() {
    let total = 0n;
    let valid = true;
    const rows = [...list.children];
    for (const [index, row] of rows.entries()) {
      row.querySelector("legend").textContent = "งวดที่ " + (index + 1);
      row.querySelector('[data-remove]').disabled = rows.length <= 1;
      try { total += parseEther(row.querySelector('[name="milestoneAmount"]').value || "0"); }
      catch { valid = false; }
    }
    $("milestone-total").textContent = valid
      ? "ค่าจ้างรวม " + formatEther(total) + " ETH"
      : "ตรวจรูปแบบค่าจ้างของแต่ละงวด";
    $("add-milestone").disabled = rows.length >= 12;
  }
  function add() {
    if (list.children.length >= 12) return;
    const row = $("milestone-template").content.firstElementChild.cloneNode(true);
    row.querySelector('[data-remove]').addEventListener("click", () => {
      if (list.children.length > 1) row.remove();
      update();
    });
    row.addEventListener("input", update);
    list.append(row);
    update();
  }
  $("add-milestone").addEventListener("click", add);
  $("create-form").addEventListener("reset", () => setTimeout(() => {
    list.replaceChildren();
    add();
  }, 0));
  add();
}

export function readMilestoneInputs(form, limit) {
  const rows = [...form.querySelectorAll(".milestone-input")];
  if (rows.length < 1 || rows.length > 12) throw new Error("กำหนด 1–12 งวดต่อโครงการ");
  let previous = Math.floor(Date.now() / 1000);
  return rows.map((row, index) => {
    const field = (name) => row.querySelector('[name="' + name + '"]').value;
    const title = limit(field("milestoneTitle"), 240, "ชื่องวดที่ " + (index + 1));
    const scope = limit(field("milestoneScope"), 1000, "ขอบเขตงาน");
    let amountWei;
    try { amountWei = parseEther(field("milestoneAmount").trim()); }
    catch { throw new Error("ค่าจ้างงวดที่ " + (index + 1) + " ต้องเป็น ETH เช่น 0.01"); }
    if (amountWei <= 0n) throw new Error("ค่าจ้างทุกงวดต้องมากกว่า 0");
    const deadline = Math.floor(new Date(field("milestoneDeadline")).getTime() / 1000);
    if (!Number.isSafeInteger(deadline) || deadline <= previous) {
      throw new Error("กำหนดส่งแต่ละงวดต้องเรียงลำดับและอยู่ในอนาคต");
    }
    previous = deadline;
    const maxRevisions = Number(field("milestoneRevisions"));
    if (!Number.isInteger(maxRevisions) || maxRevisions < 0 || maxRevisions > 10) {
      throw new Error("จำนวนรอบแก้ต้องอยู่ระหว่าง 0 ถึง 10");
    }
    return { title, scope, amountWei, deadline, maxRevisions };
  });
}

function localInput(timestamp) {
  const date = new Date(Number(timestamp) * 1000);
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
  return date.toISOString().slice(0, 16);
}

export function renderMilestones(context) {
  const {
    id, data, items, detail: work, agreement, openAgreement, isClient, isFreelancer, isArbiter, now, busy,
    node, money, localDate, actionButton, textAction, transact, limit,
  } = context;
  const status = Number(data.status);
  const currentId = Number(data.currentMilestone);
  const current = items[currentId];
  const progress = node("div", undefined, "milestone-progress");
  const paid = items.filter((item) => Number(item.status) === 3).length;
  progress.append(node("strong", "จ่ายแล้ว " + paid + " / " + items.length + " งวด"),
    actionButton("ดูขอบเขตทุกงวด", openAgreement, "text-button"));
  const meter = node("progress");
  meter.max = items.length;
  meter.value = paid;
  meter.setAttribute("aria-label", "งวดที่จ่ายแล้ว");
  work.append(progress, meter);
  if (Number(data.refundedWei) > 0) work.append(node("p", "คืนให้ผู้ว่าจ้างแล้ว " + money(data.refundedWei), "muted"));

  const taskLayout = node("div", undefined, "task-layout");
  const detail = node("div", undefined, "task-actions");
  if (current && status !== 4 && status !== 5) {
    const active = node("section", undefined, "current-milestone");
    active.append(node("p", "งวดที่กำลังดำเนินการ · " + (currentId + 1) + " / " + items.length, "section-kicker"),
      node("h3", current.title),
      node("p", money(current.amountWei) + " · ส่งภายใน " + localDate(current.deadline), "muted"),
      node("p", "รอบแก้ " + current.revisionsRequested + "/" + current.maxRevisions +
        " · ผลงานเวอร์ชัน " + current.submissionVersion, "muted"));
    const scope = node("details", undefined, "disclosure");
    scope.dataset.disclosure = "current-scope-" + currentId;
    scope.append(node("summary", "ขอบเขตและเกณฑ์รับงาน"), node("p", current.scope, "prewrap"));
    active.append(scope);
    for (const [label, value] of [
      ["หลักฐานส่งงานล่าสุด", current.workProof], ["สิ่งที่ขอแก้ล่าสุด", current.revisionFeedback],
      ["หลักฐานผู้เปิดข้อพิพาท", current.disputeEvidence], ["หลักฐานจากอีกฝ่าย", current.disputeResponse],
    ]) {
      if (!value) continue;
      const evidence = node("div", undefined, "milestone-evidence");
      evidence.append(node("h4", label), node("p", value, "prewrap mono"));
      active.append(evidence);
    }
    taskLayout.append(active);
  }
  taskLayout.append(detail);
  if (status !== 4 && status !== 5) work.append(taskLayout);

  const list = node("ol", undefined, "milestones");
  for (const [index, item] of items.entries()) {
    const row = node("li");
    const section = node("details", undefined, "milestone-card");
    section.dataset.disclosure = "milestone-" + index;
    const header = node("summary", undefined, "milestone-summary");
    const label = node("span", undefined, "milestone-label");
    label.append(node("strong", "งวด " + (index + 1) + " · " + item.title),
      node("small", money(item.amountWei) + " · แก้ได้ " + item.maxRevisions + " รอบ", "muted"));
    header.append(label, node("span", milestoneStatuses[Number(item.status)], "badge"));
    section.append(header, node("p", item.scope, "prewrap"),
      node("p", money(item.amountWei) + " · กำหนดส่ง " + localDate(item.deadline), "muted"),
      node("p", "ขอแก้แล้ว " + item.revisionsRequested + "/" + item.maxRevisions +
        " รอบ · ส่งงานเวอร์ชัน " + item.submissionVersion, "muted"));
    for (const [label, value] of [
      ["หลักฐานส่งงานล่าสุด", item.workProof],
      ["สิ่งที่ขอแก้ล่าสุด", item.revisionFeedback],
      ["หลักฐานผู้เปิดข้อพิพาท", item.disputeEvidence],
      ["หลักฐานจากอีกฝ่าย", item.disputeResponse],
      ["เหตุผลคำตัดสิน", item.rulingReason],
    ]) {
      if (value) {
        const group = node("div", undefined, "milestone-evidence");
        group.append(node("h4", label), node("p", value, "prewrap mono"));
        section.append(group);
      }
    }
    if (index === currentId && status !== 4 && status !== 5) {
      section.setAttribute("aria-current", "step");
    }
    row.append(section);
    list.append(row);
  }
  agreement.append(node("h3", "ขอบเขตและค่าจ้างรายงวด"), node("p", "กดแต่ละงวดเพื่ออ่านขอบเขต กำหนดส่ง และหลักฐาน", "muted"), list);

  if (status === 0) {
    detail.append(node("p", "ฟรีแลนซ์ต้องอ่านข้อตกลงและทุกรายงวดก่อนรับงาน ผู้ว่าจ้างจึงจะฝากค่าจ้างครบจำนวนได้", "muted"));
    if (isFreelancer && now < Number(items[0].deadline)) {
      detail.append(actionButton("ยอมรับข้อตกลงและรับงาน", () => {
        if (window.confirm("ยืนยันขอบเขตงาน ยอดเงิน กำหนดส่ง และจำนวนรอบแก้ของทุกงวด?")) {
          transact((contract) => contract.acceptAgreement(id));
        }
      }));
    }
  }
  if (status === 6 && isClient && now < Number(items[0].deadline)) {
    detail.append(actionButton("ฝากครบทุกงวด " + money(data.feeWei), () =>
      transact((contract) => contract.deposit(id, { value: data.feeWei }))));
  }
  if ((status === 0 || status === 6) && now >= Number(items[0].deadline)) {
    detail.append(node("p", "เลยกำหนดส่งงวดแรกแล้ว กรุณาสร้างข้อตกลงใหม่พร้อมกำหนดส่งที่เป็นปัจจุบัน", "muted"));
  }
  if (!current || status === 4 || status === 5) return;

  if ((status === 1 || status === 7) && isFreelancer && now <= Number(current.deadline)) {
    detail.append(textAction("URL หรือ Hash ผลงานงวด " + (currentId + 1),
      status === 7 ? "ส่งงานแก้ไข" : "บันทึกส่งงานงวดนี้",
      (contract, proof) => contract.submitWork(id, currentId, proof)));
  }
  if (status === 2 && isClient) {
    detail.append(actionButton("อนุมัติและจ่ายงวด " + (currentId + 1) + " · " + money(current.amountWei), () => {
      if (window.confirm("ยืนยันผลงานเวอร์ชัน " + current.submissionVersion + " และจ่าย " + money(current.amountWei) + " สำหรับงวดนี้?")) {
        transact((contract) => contract.approveAndPay(id, currentId, current.submissionVersion));
      }
    }));
    if (current.revisionsRequested < current.maxRevisions) {
      const form = node("form", undefined, "action-form");
      const feedbackField = node("label", "รายละเอียดที่ต้องแก้");
      const feedback = node("textarea");
      feedback.required = true;
      feedback.maxLength = 1000;
      feedback.rows = 2;
      feedback.disabled = busy;
      feedbackField.append(feedback);
      const dateField = node("label", "กำหนดส่งงานแก้ไข");
      const date = node("input");
      date.type = "datetime-local";
      date.required = true;
      date.disabled = busy;
      date.value = localInput(Math.max(Number(current.deadline), now + 3600));
      date.min = localInput(current.deadline);
      if (items[currentId + 1]) date.max = localInput(Number(items[currentId + 1].deadline) - 60);
      dateField.append(date);
      const submit = node("button", "ขอแก้ไขงาน", "secondary");
      submit.type = "submit";
      submit.disabled = busy;
      form.append(feedbackField, dateField,
        node("small", "คงกำหนดเดิมหรือขยายได้ โดยต้องอยู่ก่อนกำหนดงวดถัดไป", "muted"), submit);
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        transact((contract) => {
          const due = Math.floor(new Date(date.value).getTime() / 1000);
          if (!Number.isSafeInteger(due) || due < Number(current.deadline) || due <= Math.floor(Date.now() / 1000) ||
              items[currentId + 1] && due >= Number(items[currentId + 1].deadline)) {
            throw new Error("กำหนดแก้ไขต้องไม่สั้นกว่ากำหนดเดิม อยู่ในอนาคต และก่อนงวดถัดไป");
          }
          return contract.requestRevision(id, currentId, current.submissionVersion, limit(feedback.value, 1000, "รายละเอียดที่ต้องแก้"), due);
        });
      });
      const revision = node("details", undefined, "disclosure secondary-action");
      revision.dataset.disclosure = "revision-" + currentId;
      revision.append(node("summary", "ผลงานยังไม่ครบ? ขอแก้ไขงาน"), form);
      detail.append(revision);
    } else {
      detail.append(node("p", "ใช้รอบแก้ครบแล้ว สามารถอนุมัติหรือเปิดข้อพิพาทได้", "muted"));
    }
  }
  if ([1, 2, 7].includes(status) && (isClient || isFreelancer)) {
    const dispute = node("details", undefined, "disclosure secondary-action");
    dispute.dataset.disclosure = "dispute-" + currentId;
    dispute.append(node("summary", "มีปัญหากับงาน? เปิดข้อพิพาท"),
      textAction("เหตุผลหรือ Hash หลักฐานของงวดนี้", "เปิดข้อพิพาทงวดนี้",
        (contract, evidence) => contract.openDispute(id, currentId, evidence)));
    detail.append(dispute);
  }
  if ((status === 1 || status === 7) && now > Number(current.deadline)) {
    detail.append(node("p", "เลยกำหนดส่งงวดนี้แล้ว คู่สัญญาสามารถเปิดข้อพิพาทได้", "muted"));
  }
  if (status === 3) {
    if ((isClient || isFreelancer) &&
        context.sameAddress(context.account, current.disputeOpenedBy) === false && !current.disputeResponse) {
      detail.append(textAction("หลักฐานจากอีกฝ่าย", "ส่งหลักฐานเพิ่มเติม",
        (contract, proof) => contract.submitDisputeResponse(id, currentId, proof)));
    }
    if (isArbiter) {
      const form = node("form", undefined, "action-form");
      const label = node("label", "เหตุผลคำตัดสิน");
      const reason = node("textarea");
      reason.required = true;
      reason.maxLength = 1000;
      reason.rows = 2;
      reason.disabled = busy;
      label.append(reason);
      const actions = node("div", undefined, "actions");
      for (const [value, text] of [
        ["pay", "จ่ายงวดที่พิพาท " + money(current.amountWei)],
        ["refund", "คืนยอดที่เหลือและปิดงาน " + money(data.escrowWei)],
      ]) {
        const button = node("button", text, "secondary");
        button.type = "submit";
        button.value = value;
        button.disabled = busy;
        actions.append(button);
      }
      form.append(label, actions);
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        if (!event.submitter || !window.confirm("ยืนยัน" + event.submitter.textContent + "?")) return;
        const pay = event.submitter.value === "pay";
        transact((contract) => contract.resolveDispute(id, currentId, pay, limit(reason.value, 1000, "เหตุผลคำตัดสิน")));
      });
      detail.append(form);
    }
    detail.append(node("p", "จ่ายเฉพาะงวดที่พิพาทแล้วทำงวดถัดไปได้ หรือคืนยอดพักทั้งหมดเพื่อปิดงาน ผู้ตัดสินต้องเป็นผู้ชี้ขาด", "muted"));
  }
}

export function describeMilestoneLog(log, money) {
  const step = log.args.milestoneId === undefined ? "" : "งวด " + (log.args.milestoneId + 1n) + " · ";
  switch (log.name) {
    case "AgreementAccepted": return "ฟรีแลนซ์ยอมรับข้อตกลง";
    case "WorkSubmitted": return step + "ส่งเวอร์ชัน " + log.args.version + " · " + log.args.proof;
    case "RevisionRequested": return step + "ขอแก้รอบ " + log.args.round + " · " + log.args.feedback;
    case "MilestonePaid": return step + "จ่าย " + money(log.args.amount) + " ให้ " + log.args.recipient;
    case "RemainingRefunded": return "คืนยอดที่เหลือ " + money(log.args.amount) + " ให้ " + log.args.recipient;
    case "DisputeOpened": return step + "เปิดข้อพิพาท · " + log.args.evidence;
    case "EvidenceSubmitted": return step + "อีกฝ่ายส่งหลักฐาน · " + log.args.evidence;
    case "DisputeResolved": return step + "ผู้ตัดสินสั่ง" + (log.args.payFreelancer ? "จ่ายงวดนี้" : "คืนยอดที่เหลือ") + " · " + log.args.reason;
    default: return null;
  }
}
