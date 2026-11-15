// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice Escrows one ETH payment per job. The arbiter can settle disputed jobs only.
contract FreelanceEscrow {
    enum Status { Created, Funded, Submitted, Disputed, Paid, Refunded }

    struct Job {
        address client;
        address freelancer;
        uint256 feeWei;
        uint256 escrowWei;
        uint64 deadline;
        Status status;
        string title;
        string details;
        string workProof;
        address disputeOpenedBy;
        string disputeEvidence;
        string disputeResponse;
        string rulingReason;
    }

    error InvalidArbiter();
    error UnknownJob();
    error InvalidParties();
    error InvalidFee();
    error InvalidDeadline();
    error InvalidText();
    error Unauthorized();
    error InvalidStatus();
    error DeadlinePassed();
    error IncorrectDeposit();
    error TransferFailed();

    event JobCreated(uint256 indexed jobId, address indexed client, address indexed freelancer);
    event Funded(uint256 indexed jobId, address indexed actor, uint256 amount);
    event WorkSubmitted(uint256 indexed jobId, address indexed actor);
    event DisputeOpened(uint256 indexed jobId, address indexed actor);
    event EvidenceSubmitted(uint256 indexed jobId, address indexed actor);
    event DisputeResolved(uint256 indexed jobId, address indexed actor, bool payFreelancer);
    event Settled(uint256 indexed jobId, address indexed recipient, uint256 amount, Status outcome);

    address public immutable arbiter;
    uint256 public jobCount;
    mapping(uint256 => Job) private jobs;

    constructor(address arbiter_) {
        if (arbiter_ == address(0)) revert InvalidArbiter();
        arbiter = arbiter_;
    }

    function createJob(
        address freelancer,
        uint256 feeWei,
        uint64 deadline,
        string calldata title,
        string calldata details
    ) external returns (uint256 jobId) {
        if (
            freelancer == address(0) || freelancer == msg.sender ||
            freelancer == arbiter || msg.sender == arbiter
        ) revert InvalidParties();
        if (feeWei == 0) revert InvalidFee();
        if (deadline <= block.timestamp) revert InvalidDeadline();
        _checkText(title, 240);
        _checkText(details, 2400);

        jobId = ++jobCount;
        Job storage job = jobs[jobId];
        job.client = msg.sender;
        job.freelancer = freelancer;
        job.feeWei = feeWei;
        job.deadline = deadline;
        job.title = title;
        job.details = details;
        emit JobCreated(jobId, msg.sender, freelancer);
    }

    function deposit(uint256 jobId) external payable {
        Job storage job = _job(jobId);
        if (msg.sender != job.client) revert Unauthorized();
        if (job.status != Status.Created) revert InvalidStatus();
        if (block.timestamp >= job.deadline) revert DeadlinePassed();
        if (msg.value != job.feeWei) revert IncorrectDeposit();

        job.escrowWei = msg.value;
        job.status = Status.Funded;
        emit Funded(jobId, msg.sender, msg.value);
    }

    function submitWork(uint256 jobId, string calldata proof) external {
        Job storage job = _job(jobId);
        if (msg.sender != job.freelancer) revert Unauthorized();
        if (job.status != Status.Funded) revert InvalidStatus();
        if (block.timestamp > job.deadline) revert DeadlinePassed();
        _checkText(proof, 1000);

        job.workProof = proof;
        job.status = Status.Submitted;
        emit WorkSubmitted(jobId, msg.sender);
    }

    function approveAndPay(uint256 jobId) external {
        Job storage job = _job(jobId);
        if (msg.sender != job.client) revert Unauthorized();
        if (job.status != Status.Submitted) revert InvalidStatus();

        _settle(jobId, job, true);
    }

    function openDispute(uint256 jobId, string calldata evidence) external {
        Job storage job = _job(jobId);
        if (msg.sender != job.client && msg.sender != job.freelancer) revert Unauthorized();
        if (job.status != Status.Funded && job.status != Status.Submitted) revert InvalidStatus();
        _checkText(evidence, 1000);

        job.disputeOpenedBy = msg.sender;
        job.disputeEvidence = evidence;
        job.status = Status.Disputed;
        emit DisputeOpened(jobId, msg.sender);
    }

    function submitDisputeResponse(uint256 jobId, string calldata evidence) external {
        Job storage job = _job(jobId);
        if (msg.sender != job.client && msg.sender != job.freelancer) revert Unauthorized();
        if (msg.sender == job.disputeOpenedBy) revert Unauthorized();
        if (job.status != Status.Disputed || bytes(job.disputeResponse).length != 0) revert InvalidStatus();
        _checkText(evidence, 1000);

        job.disputeResponse = evidence;
        emit EvidenceSubmitted(jobId, msg.sender);
    }

    function resolveDispute(uint256 jobId, bool payFreelancer, string calldata reason) external {
        Job storage job = _job(jobId);
        if (msg.sender != arbiter) revert Unauthorized();
        if (job.status != Status.Disputed) revert InvalidStatus();

        _checkText(reason, 1000);
        job.rulingReason = reason;
        emit DisputeResolved(jobId, msg.sender, payFreelancer);
        _settle(jobId, job, payFreelancer);
    }

    function getJob(uint256 jobId) external view returns (Job memory) {
        return _job(jobId);
    }

    function _job(uint256 jobId) private view returns (Job storage job) {
        job = jobs[jobId];
        if (job.client == address(0)) revert UnknownJob();
    }

    function _settle(uint256 jobId, Job storage job, bool payFreelancer) private {
        address recipient = payFreelancer ? job.freelancer : job.client;
        Status outcome = payFreelancer ? Status.Paid : Status.Refunded;
        uint256 amount = job.escrowWei;

        job.escrowWei = 0;
        job.status = outcome;
        emit Settled(jobId, recipient, amount, outcome);
        (bool success, ) = recipient.call{value: amount}("");
        if (!success) revert TransferFailed();
    }

    function _checkText(string calldata value, uint256 maxBytes) private pure {
        uint256 length = bytes(value).length;
        if (length == 0 || length > maxBytes) revert InvalidText();
    }
}
