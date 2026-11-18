const assert = require("node:assert/strict");
const { ethers, network } = require("hardhat");

const fee = (amount) => ethers.parseEther(amount);
const confirmed = async (tx) => (await tx).wait();

describe("FreelanceEscrowV2 milestones", function () {
  let client, freelancer, arbiter, stranger, contract, due, inputs;

  beforeEach(async function () {
    [client, freelancer, arbiter, stranger] = await ethers.getSigners();
    contract = await ethers.deployContract("FreelanceEscrowV2", [arbiter.address]);
    await contract.waitForDeployment();
    due = (await ethers.provider.getBlock("latest")).timestamp + 3600;
    inputs = [
      { title: "Design", scope: "Three screens", amountWei: fee("0.2"), deadline: due, maxRevisions: 1 },
      { title: "Delivery", scope: "Source files and tests", amountWei: fee("0.3"), deadline: due + 7200, maxRevisions: 2 },
    ];
  });

  const create = (recipient, items) => confirmed(contract.connect(client).createJob(
    recipient || freelancer.address, "Website", "Two milestone agreement", items || inputs,
  ));
  const accept = (id = 1) => confirmed(contract.connect(freelancer).acceptAgreement(id));
  const deposit = (id = 1) => confirmed(contract.connect(client).deposit(id, { value: fee("0.5") }));
  const submit = (id = 1, milestone = 0, proof = "v1 proof") => confirmed(contract.connect(freelancer).submitWork(id, milestone, proof));
  const pay = (id = 1, milestone = 0, version = 1) => confirmed(contract.connect(client).approveAndPay(id, milestone, version));

  async function funded() {
    await create();
    await accept();
    await deposit();
  }

  async function assertMoney(id, paid, escrow, refund) {
    const job = await contract.getJob(id);
    assert.equal(job.paidWei, fee(paid));
    assert.equal(job.escrowWei, fee(escrow));
    assert.equal(job.refundedWei, fee(refund));
    assert.equal(job.paidWei + job.escrowWei + job.refundedWei, job.feeWei);
  }

  it("requires freelancer acceptance before any deposit, and leaves the agreed terms immutable", async function () {
    await create();
    await assert.rejects(deposit(), /InvalidStatus/);
    await assert.rejects(contract.connect(client).acceptAgreement(1), /Unauthorized/);
    await assert.rejects(contract.connect(stranger).acceptAgreement(1), /Unauthorized/);
    await accept();
    await assert.rejects(accept(), /InvalidStatus/);
    await assert.rejects(contract.connect(client).deposit(1, { value: fee("0.2") }), /IncorrectDeposit/);
    await deposit();
    await assert.rejects(deposit(), /InvalidStatus/);
    const saved = await contract.getMilestones(1);
    assert.equal(saved[0].scope, inputs[0].scope);
    assert.equal(saved[0].amountWei, inputs[0].amountWei);
    assert.equal(saved[1].maxRevisions, 2n);
    await assertMoney(1, "0", "0.5", "0");
  });

  it("validates milestones, ordered dates, byte limits and account separation", async function () {
    await assert.rejects(create(undefined, []), /InvalidMilestones/);
    await assert.rejects(create(undefined, Array(13).fill(inputs[0])), /InvalidMilestones/);
    await assert.rejects(create(undefined, [{ ...inputs[0], amountWei: 0 }]), /InvalidFee/);
    await assert.rejects(create(undefined, [inputs[1], inputs[0]]), /InvalidDeadline/);
    await assert.rejects(create(undefined, [{ ...inputs[0], maxRevisions: 11 }]), /InvalidMilestones/);
    await assert.rejects(create(undefined, [{ ...inputs[0], scope: "ก".repeat(334) }]), /InvalidText/);
    await assert.rejects(create(client.address), /InvalidParties/);
    await assert.rejects(create(arbiter.address), /InvalidParties/);
    await assert.rejects(contract.getMilestones(0), /UnknownJob/);
    assert.equal(await contract.jobCount(), 0n);
  });

  it("tracks revision rounds and versions, rejecting stale approval and the wrong milestone", async function () {
    await funded();
    await assert.rejects(submit(1, 1), /InvalidStatus/);
    await submit();
    await assert.rejects(contract.connect(freelancer).requestRevision(1, 0, 1, "Fix", due), /Unauthorized/);
    await assert.rejects(contract.connect(client).requestRevision(1, 0, 1, "", due), /InvalidText/);
    await assert.rejects(contract.connect(client).requestRevision(1, 0, 1, "Fix", due - 1), /InvalidDeadline/);
    await assert.rejects(contract.connect(client).requestRevision(1, 0, 1, "Fix", inputs[1].deadline), /InvalidDeadline/);
    const revision = await confirmed(contract.connect(client).requestRevision(1, 0, 1, "Fix navigation", due + 300));
    assert.equal(revision.logs.find((log) => log.fragment?.name === "RevisionRequested").args.feedback, "Fix navigation");
    await assert.rejects(pay(), /InvalidStatus/);
    await submit(1, 0, "v2 corrected");
    const milestones = await contract.getMilestones(1);
    assert.equal(milestones[0].submissionVersion, 2n);
    assert.equal(milestones[0].revisionsRequested, 1n);
    assert.equal(milestones[0].workProof, "v2 corrected");
    assert.equal(milestones[0].revisionFeedback, "Fix navigation");
    await assert.rejects(pay(1, 0, 1), /InvalidStatus/);
    await assert.rejects(contract.connect(client).requestRevision(1, 0, 1, "Stale version", due + 300), /InvalidStatus/);
    await assert.rejects(contract.connect(client).requestRevision(1, 0, 2, "Again", due + 300), /RevisionLimitReached/);
    await pay(1, 0, 2);
    await assertMoney(1, "0.2", "0.3", "0");
    const events = await contract.queryFilter(contract.filters.WorkSubmitted(1, 0));
    assert.deepEqual(events.map((e) => e.args.proof), ["v1 proof", "v2 corrected"]);
  });

  it("pays each milestone exactly once, preserving money belonging to other jobs", async function () {
    await funded();
    await create();
    await accept(2);
    await deposit(2);
    await submit();
    const before = await ethers.provider.getBalance(freelancer.address);
    await assert.rejects(contract.connect(stranger).approveAndPay(1, 0, 1), /Unauthorized/);
    await pay();
    assert.equal(await ethers.provider.getBalance(freelancer.address), before + fee("0.2"));
    await assert.rejects(pay(), /InvalidStatus/);
    await assertMoney(1, "0.2", "0.3", "0");
    await assertMoney(2, "0", "0.5", "0");
    await submit(1, 1);
    const beforeFinal = await ethers.provider.getBalance(freelancer.address);
    await pay(1, 1);
    assert.equal(await ethers.provider.getBalance(freelancer.address), beforeFinal + fee("0.3"));
    await assertMoney(1, "0.5", "0", "0");
    assert.equal((await contract.getJob(1)).status, 4n);
    assert.equal(await ethers.provider.getBalance(await contract.getAddress()), fee("0.5"));
  });

  it("refunds only unpaid milestones after a dispute while preserving earlier payouts", async function () {
    await funded();
    await submit();
    await pay();
    await confirmed(contract.connect(freelancer).openDispute(1, 1, "Remaining work disputed"));
    await assert.rejects(submit(1, 1), /InvalidStatus/);
    await assert.rejects(contract.connect(client).resolveDispute(1, 1, false, "Refund"), /Unauthorized/);
    await confirmed(contract.connect(client).submitDisputeResponse(1, 1, "Client evidence"));
    const before = await ethers.provider.getBalance(client.address);
    await confirmed(contract.connect(arbiter).resolveDispute(1, 1, false, "Refund remaining"));
    assert.equal(await ethers.provider.getBalance(client.address), before + fee("0.3"));
    await assertMoney(1, "0.2", "0", "0.3");
    const items = await contract.getMilestones(1);
    assert.equal(items[0].status, 3n);
    assert.equal(items[1].status, 5n);
    assert.equal(items[1].rulingReason, "Refund remaining");
    await assert.rejects(contract.connect(arbiter).resolveDispute(1, 1, true, "Again"), /InvalidStatus/);
  });

  it("lets the arbiter pay only the disputed installment and then continue the next one", async function () {
    await funded();
    await submit();
    await confirmed(contract.connect(client).openDispute(1, 0, "Wrong result"));
    await assert.rejects(pay(), /InvalidStatus/);
    await confirmed(contract.connect(freelancer).submitDisputeResponse(1, 0, "Proof"));
    await assert.rejects(contract.connect(freelancer).submitDisputeResponse(1, 0, "Duplicate"), /InvalidStatus/);
    await confirmed(contract.connect(arbiter).resolveDispute(1, 0, true, "Delivered correctly"));
    await assertMoney(1, "0.2", "0.3", "0");
    assert.equal((await contract.getJob(1)).currentMilestone, 1n);
    await submit(1, 1);
    await pay(1, 1);
    await assertMoney(1, "0.5", "0", "0");
  });

  it("allows a new revision deadline after the original date and keeps a dispute exit for late work", async function () {
    await funded();
    await submit();
    await network.provider.send("evm_setNextBlockTimestamp", [due + 1]);
    await network.provider.send("evm_mine");
    await confirmed(contract.connect(client).requestRevision(1, 0, 1, "Fix after review", due + 600));
    await submit(1, 0, "Corrected after original deadline");
    await pay(1, 0, 2);
    await network.provider.send("evm_setNextBlockTimestamp", [due + 7201]);
    await network.provider.send("evm_mine");
    await assert.rejects(submit(1, 1), /DeadlinePassed/);
    await confirmed(contract.connect(client).openDispute(1, 1, "Late"));
    await confirmed(contract.connect(arbiter).resolveDispute(1, 1, false, "Refund"));
    await assertMoney(1, "0.2", "0", "0.3");
  });

  it("rejects late agreement acceptance and funding without locking any ETH", async function () {
    await create();
    await create();
    await accept(2);
    await network.provider.send("evm_setNextBlockTimestamp", [due]);
    await network.provider.send("evm_mine");
    await assert.rejects(accept(), /DeadlinePassed/);
    await assert.rejects(deposit(2), /DeadlinePassed/);
    assert.equal(await ethers.provider.getBalance(await contract.getAddress()), 0n);
  });

  it("rolls back failed transfers and resists recipient callbacks while keeping the next installment safe", async function () {
    const receiver = await ethers.deployContract("MilestoneReceiver");
    await create(await receiver.getAddress());
    await confirmed(receiver.accept(await contract.getAddress(), 1));
    await deposit();
    await confirmed(receiver.deliver(0, "Proof"));
    await confirmed(receiver.setReject(true));
    await assert.rejects(pay(), /TransferFailed/);
    await assertMoney(1, "0", "0.5", "0");
    assert.equal((await contract.getJob(1)).status, 2n);
    await confirmed(receiver.setReject(false));
    await pay();
    assert.equal(await receiver.reentrySucceeded(), false);
    await assertMoney(1, "0.2", "0.3", "0");
  });
});
