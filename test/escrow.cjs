const assert = require("node:assert/strict");
const { ethers, network } = require("hardhat");

const fee = ethers.parseEther("0.5");
const Status = { Created: 0n, Funded: 1n, Submitted: 2n, Disputed: 3n, Paid: 4n, Refunded: 5n };

async function confirmed(transaction) {
  return (await transaction).wait();
}

describe("FreelanceEscrow", function () {
  let client, freelancer, arbiter, stranger, escrow, deadline;

  beforeEach(async function () {
    [client, freelancer, arbiter, stranger] = await ethers.getSigners();
    escrow = await ethers.deployContract("FreelanceEscrow", [arbiter.address]);
    await escrow.waitForDeployment();
    deadline = (await ethers.provider.getBlock("latest")).timestamp + 600;
  });

  function create(recipient = freelancer.address, due = deadline) {
    return confirmed(escrow.connect(client).createJob(recipient, fee, due, "Website", "Project page"));
  }

  function deposit(id) {
    return confirmed(escrow.connect(client).deposit(id, { value: fee }));
  }

  async function submit(id) {
    return confirmed(escrow.connect(freelancer).submitWork(id, ethers.id("deliverable")));
  }

  async function state(id, expected, balance) {
    const job = await escrow.getJob(id);
    assert.equal(job.status, expected);
    assert.equal(job.escrowWei, balance);
  }

  it("pays the freelancer once, emits the settlement and preserves another job's ETH", async function () {
    await create();
    await create();
    await deposit(1);
    await deposit(2);
    await submit(1);
    const before = await ethers.provider.getBalance(freelancer.address);
    const receipt = await confirmed(escrow.connect(client).approveAndPay(1));
    const settlement = receipt.logs.find((log) => log.fragment?.name === "Settled");
    assert.equal(settlement.args.jobId, 1n);
    assert.equal(settlement.args.recipient, freelancer.address);
    assert.equal(settlement.args.amount, fee);
    assert.equal(settlement.transactionHash, receipt.hash);
    assert.equal(await ethers.provider.getBalance(freelancer.address), before + fee);
    await state(1, Status.Paid, 0n);
    await state(2, Status.Funded, fee);
    assert.equal(await ethers.provider.getBalance(await escrow.getAddress()), fee);
    await assert.rejects(escrow.connect(client).approveAndPay(1), /InvalidStatus/);
    await assert.rejects(escrow.connect(client).openDispute(1, "Closed"), /InvalidStatus/);
  });

  it("enforces wallet roles, exact deposit and valid lifecycle transitions", async function () {
    await create();
    await state(1, Status.Created, 0n);
    await assert.rejects(create(arbiter.address), /InvalidParties/);
    await assert.rejects(escrow.getJob(0), /UnknownJob/);
    await assert.rejects(escrow.connect(client).approveAndPay(1), /InvalidStatus/);
    await assert.rejects(escrow.connect(freelancer).openDispute(1, "Unfunded"), /InvalidStatus/);
    await assert.rejects(escrow.connect(stranger).deposit(1, { value: fee }), /Unauthorized/);
    await assert.rejects(escrow.connect(client).deposit(1, { value: fee - 1n }), /IncorrectDeposit/);
    await deposit(1);
    await assert.rejects(deposit(1), /InvalidStatus/);
    await assert.rejects(escrow.connect(stranger).submitWork(1, "proof"), /Unauthorized/);
    await assert.rejects(escrow.connect(arbiter).resolveDispute(1, true, "Reviewed both accounts"), /InvalidStatus/);
    await submit(1);
    await assert.rejects(escrow.connect(stranger).approveAndPay(1), /Unauthorized/);
    await assert.rejects(escrow.connect(stranger).openDispute(1, "Outsider"), /Unauthorized/);
    await state(1, Status.Submitted, fee);
  });

  it("freezes normal approval during a dispute and refunds only with the arbiter's decision", async function () {
    await create();
    await deposit(1);
    await submit(1);
    await confirmed(escrow.connect(freelancer).openDispute(1, "Awaiting acceptance"));
    await state(1, Status.Disputed, fee);
    await assert.rejects(escrow.connect(client).approveAndPay(1), /InvalidStatus/);
    await assert.rejects(escrow.connect(client).resolveDispute(1, false, "Reviewed both accounts"), /Unauthorized/);
    const before = await ethers.provider.getBalance(client.address);
    await confirmed(escrow.connect(arbiter).resolveDispute(1, false, "Reviewed both accounts"));
    assert.equal(await ethers.provider.getBalance(client.address), before + fee);
    await state(1, Status.Refunded, 0n);
    await assert.rejects(escrow.connect(arbiter).resolveDispute(1, true, "Reviewed both accounts"), /InvalidStatus/);
  });

  it("records both parties' evidence and the ruling, with one reply from the other party only", async function () {
    await create();
    await deposit(1);
    await assert.rejects(escrow.connect(freelancer).submitDisputeResponse(1, "Not disputed"), /InvalidStatus/);
    await confirmed(escrow.connect(client).openDispute(1, "Client evidence"));
    await assert.rejects(escrow.connect(client).submitDisputeResponse(1, "Repeat"), /Unauthorized/);
    await assert.rejects(escrow.connect(stranger).submitDisputeResponse(1, "Outsider"), /Unauthorized/);
    await confirmed(escrow.connect(freelancer).submitDisputeResponse(1, "Freelancer evidence"));
    await assert.rejects(escrow.connect(freelancer).submitDisputeResponse(1, "Repeat"), /InvalidStatus/);
    await assert.rejects(escrow.connect(arbiter).resolveDispute(1, true, ""), /InvalidText/);
    const reason = "Reviewed signed acceptance";
    await confirmed(escrow.connect(arbiter).resolveDispute(1, true, reason));
    const job = await escrow.getJob(1);
    assert.equal(job.disputeOpenedBy, client.address);
    assert.equal(job.disputeEvidence, "Client evidence");
    assert.equal(job.disputeResponse, "Freelancer evidence");
    assert.equal(job.rulingReason, reason);
    await assert.rejects(escrow.connect(freelancer).submitDisputeResponse(1, "Closed"), /InvalidStatus/);
  });

  it("lets the arbiter pay the freelancer after a dispute raised on a funded job", async function () {
    await create();
    await deposit(1);
    await confirmed(escrow.connect(client).openDispute(1, ethers.id("evidence")));
    const before = await ethers.provider.getBalance(freelancer.address);
    await confirmed(escrow.connect(arbiter).resolveDispute(1, true, "Reviewed both accounts"));
    assert.equal(await ethers.provider.getBalance(freelancer.address), before + fee);
    await state(1, Status.Paid, 0n);
  });

  it("rejects late deposits and submissions while preserving the dispute route", async function () {
    await create();
    await create();
    await deposit(1);
    await network.provider.send("evm_setNextBlockTimestamp", [deadline + 1]);
    await network.provider.send("evm_mine");
    await assert.rejects(submit(1), /DeadlinePassed/);
    await assert.rejects(deposit(2), /DeadlinePassed/);
    await confirmed(escrow.connect(client).openDispute(1, "Missed deadline"));
    await confirmed(escrow.connect(arbiter).resolveDispute(1, false, "Reviewed both accounts"));
    await state(1, Status.Refunded, 0n);
    await state(2, Status.Created, 0n);
  });

  it("rolls back status and escrow when the recipient cannot accept ETH", async function () {
    const receiver = await ethers.deployContract("NonPayableFreelancer");
    await receiver.waitForDeployment();
    await create(await receiver.getAddress());
    await deposit(1);
    await confirmed(receiver.deliver(await escrow.getAddress(), 1, "test file"));
    await assert.rejects(escrow.connect(client).approveAndPay(1), /TransferFailed/);
    await state(1, Status.Submitted, fee);
    assert.equal(await ethers.provider.getBalance(await escrow.getAddress()), fee);
  });
});
