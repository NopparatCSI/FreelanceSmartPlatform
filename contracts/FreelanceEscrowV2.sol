// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice Fully funded, sequential milestones with explicit agreement acceptance.
contract FreelanceEscrowV2 {
    // First six values retain the V1 status meanings for the shared job list.
    enum Status { Created, Funded, Submitted, Disputed, Paid, Refunded, Accepted, RevisionRequested }
    enum MilestoneStatus { Pending, Submitted, RevisionRequested, Paid, Disputed, Refunded }

    struct MilestoneInput {
        string title;
        string scope;
        uint256 amountWei;
        uint64 deadline;
        uint8 maxRevisions;
    }

    struct Milestone {
        string title;
        string scope;
        uint256 amountWei;
        uint64 deadline;
        uint8 maxRevisions;
        uint8 revisionsRequested;
        uint16 submissionVersion;
        MilestoneStatus status;
        string workProof;
        string revisionFeedback;
        address disputeOpenedBy;
        string disputeEvidence;
        string disputeResponse;
        string rulingReason;
    }

    struct Job {
        address client;
        address freelancer;
        uint256 feeWei;
        uint256 escrowWei;
        uint64 deadline;
        Status status;
        string title;
        string details;
        uint256 currentMilestone;
        uint256 paidWei;
        uint256 refundedWei;
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
    error InvalidMilestones();
    error RevisionLimitReached();
    error ReentrantCall();

    event JobCreated(uint256 indexed jobId, address indexed client, address indexed freelancer);
    event AgreementAccepted(uint256 indexed jobId, address indexed actor);
    event Funded(uint256 indexed jobId, address indexed actor, uint256 amount);
    event WorkSubmitted(uint256 indexed jobId, uint256 indexed milestoneId, uint16 version, string proof);
    event RevisionRequested(uint256 indexed jobId, uint256 indexed milestoneId, uint8 round, string feedback, uint64 deadline);
    event DisputeOpened(uint256 indexed jobId, uint256 indexed milestoneId, address indexed actor, string evidence);
    event EvidenceSubmitted(uint256 indexed jobId, uint256 indexed milestoneId, address indexed actor, string evidence);
    event DisputeResolved(uint256 indexed jobId, uint256 indexed milestoneId, bool payFreelancer, string reason);
    event MilestonePaid(uint256 indexed jobId, uint256 indexed milestoneId, address indexed recipient, uint256 amount);
    event RemainingRefunded(uint256 indexed jobId, address indexed recipient, uint256 amount);

    address public immutable arbiter;
    uint256 public constant version = 2;
    uint256 public jobCount;
    bool private transferring;
    mapping(uint256 => Job) private jobs;
    mapping(uint256 => Milestone[]) private milestones;

    modifier nonReentrant() {
        if (transferring) revert ReentrantCall();
        transferring = true;
        _;
        transferring = false;
    }

    constructor(address arbiter_) {
        if (arbiter_ == address(0)) revert InvalidArbiter();
        arbiter = arbiter_;
    }

    function createJob(
        address freelancer,
        string calldata title,
        string calldata details,
        MilestoneInput[] calldata items
    ) external returns (uint256 jobId) {
        if (freelancer == address(0) || freelancer == msg.sender ||
            freelancer == arbiter || msg.sender == arbiter) revert InvalidParties();
        _checkText(title, 240);
        _checkText(details, 2400);
        if (items.length == 0 || items.length > 12) revert InvalidMilestones();

        jobId = ++jobCount;
        uint256 fee;
        uint64 previousDeadline = uint64(block.timestamp);
        for (uint256 i; i < items.length; i++) {
            MilestoneInput calldata item = items[i];
            _checkText(item.title, 240);
            _checkText(item.scope, 1000);
            if (item.amountWei == 0) revert InvalidFee();
            if (item.deadline <= previousDeadline) revert InvalidDeadline();
            if (item.maxRevisions > 10) revert InvalidMilestones();
            previousDeadline = item.deadline;
            fee += item.amountWei;
            Milestone storage milestone = milestones[jobId].push();
            milestone.title = item.title;
            milestone.scope = item.scope;
            milestone.amountWei = item.amountWei;
            milestone.deadline = item.deadline;
            milestone.maxRevisions = item.maxRevisions;
        }

        Job storage job = jobs[jobId];
        job.client = msg.sender;
        job.freelancer = freelancer;
        job.title = title;
        job.details = details;
        job.feeWei = fee;
        job.deadline = previousDeadline;
        emit JobCreated(jobId, msg.sender, freelancer);
    }

    function acceptAgreement(uint256 jobId) external {
        Job storage job = _job(jobId);
        if (msg.sender != job.freelancer) revert Unauthorized();
        if (job.status != Status.Created) revert InvalidStatus();
        if (block.timestamp >= milestones[jobId][0].deadline) revert DeadlinePassed();
        job.status = Status.Accepted;
        emit AgreementAccepted(jobId, msg.sender);
    }

    function deposit(uint256 jobId) external payable {
        Job storage job = _job(jobId);
        if (msg.sender != job.client) revert Unauthorized();
        if (job.status != Status.Accepted) revert InvalidStatus();
        if (block.timestamp >= milestones[jobId][0].deadline) revert DeadlinePassed();
        if (msg.value != job.feeWei) revert IncorrectDeposit();
        job.escrowWei = msg.value;
        job.status = Status.Funded;
        emit Funded(jobId, msg.sender, msg.value);
    }

    function submitWork(uint256 jobId, uint256 milestoneId, string calldata proof) external {
        Job storage job = _job(jobId);
        if (msg.sender != job.freelancer) revert Unauthorized();
        Milestone storage item = _current(jobId, job, milestoneId);
        if (job.status != Status.Funded && job.status != Status.RevisionRequested) revert InvalidStatus();
        if (block.timestamp > item.deadline) revert DeadlinePassed();
        _checkText(proof, 1000);
        item.submissionVersion++;
        item.workProof = proof;
        item.status = MilestoneStatus.Submitted;
        job.status = Status.Submitted;
        emit WorkSubmitted(jobId, milestoneId, item.submissionVersion, proof);
    }

    /// @notice Client sets an explicit revision deadline, without shortening the agreed deadline.
    function requestRevision(
        uint256 jobId, uint256 milestoneId, uint16 expectedVersion,
        string calldata feedback, uint64 revisedDeadline
    ) external {
        Job storage job = _job(jobId);
        if (msg.sender != job.client) revert Unauthorized();
        Milestone storage item = _current(jobId, job, milestoneId);
        _submitted(job, item, expectedVersion);
        if (item.revisionsRequested >= item.maxRevisions) revert RevisionLimitReached();
        _checkText(feedback, 1000);
        if (revisedDeadline < item.deadline || revisedDeadline <= block.timestamp ||
            (milestoneId + 1 < milestones[jobId].length &&
             revisedDeadline >= milestones[jobId][milestoneId + 1].deadline)) revert InvalidDeadline();

        item.revisionsRequested++;
        item.revisionFeedback = feedback;
        item.deadline = revisedDeadline;
        if (milestoneId + 1 == milestones[jobId].length) job.deadline = revisedDeadline;
        item.status = MilestoneStatus.RevisionRequested;
        job.status = Status.RevisionRequested;
        emit RevisionRequested(jobId, milestoneId, item.revisionsRequested, feedback, revisedDeadline);
    }

    function approveAndPay(uint256 jobId, uint256 milestoneId, uint16 expectedVersion) external nonReentrant {
        Job storage job = _job(jobId);
        if (msg.sender != job.client) revert Unauthorized();
        Milestone storage item = _current(jobId, job, milestoneId);
        _submitted(job, item, expectedVersion);
        _pay(jobId, job, item);
    }

    function openDispute(uint256 jobId, uint256 milestoneId, string calldata evidence) external {
        Job storage job = _job(jobId);
        if (msg.sender != job.client && msg.sender != job.freelancer) revert Unauthorized();
        Milestone storage item = _current(jobId, job, milestoneId);
        if (job.status != Status.Funded && job.status != Status.Submitted &&
            job.status != Status.RevisionRequested) revert InvalidStatus();
        _checkText(evidence, 1000);
        item.disputeOpenedBy = msg.sender;
        item.disputeEvidence = evidence;
        item.status = MilestoneStatus.Disputed;
        job.status = Status.Disputed;
        emit DisputeOpened(jobId, milestoneId, msg.sender, evidence);
    }

    function submitDisputeResponse(uint256 jobId, uint256 milestoneId, string calldata evidence) external {
        Job storage job = _job(jobId);
        if (msg.sender != job.client && msg.sender != job.freelancer) revert Unauthorized();
        Milestone storage item = _current(jobId, job, milestoneId);
        if (msg.sender == item.disputeOpenedBy) revert Unauthorized();
        if (job.status != Status.Disputed || bytes(item.disputeResponse).length != 0) revert InvalidStatus();
        _checkText(evidence, 1000);
        item.disputeResponse = evidence;
        emit EvidenceSubmitted(jobId, milestoneId, msg.sender, evidence);
    }

    function resolveDispute(
        uint256 jobId, uint256 milestoneId, bool payFreelancer, string calldata reason
    ) external nonReentrant {
        Job storage job = _job(jobId);
        if (msg.sender != arbiter) revert Unauthorized();
        Milestone storage item = _current(jobId, job, milestoneId);
        if (job.status != Status.Disputed) revert InvalidStatus();
        _checkText(reason, 1000);
        item.rulingReason = reason;
        emit DisputeResolved(jobId, milestoneId, payFreelancer, reason);
        if (payFreelancer) {
            _pay(jobId, job, item);
        } else {
            uint256 remaining = job.escrowWei;
            job.escrowWei = 0;
            job.refundedWei = remaining;
            job.status = Status.Refunded;
            // The array is bounded to at most 12 entries.
            for (uint256 i = job.currentMilestone; i < milestones[jobId].length; i++) {
                milestones[jobId][i].status = MilestoneStatus.Refunded;
            }
            emit RemainingRefunded(jobId, job.client, remaining);
            _transfer(job.client, remaining);
        }
    }

    function getJob(uint256 jobId) external view returns (Job memory) {
        return _job(jobId);
    }

    function getMilestones(uint256 jobId) external view returns (Milestone[] memory) {
        _job(jobId);
        return milestones[jobId];
    }

    function _job(uint256 jobId) private view returns (Job storage job) {
        job = jobs[jobId];
        if (job.client == address(0)) revert UnknownJob();
    }

    function _current(uint256 jobId, Job storage job, uint256 milestoneId) private view returns (Milestone storage) {
        if (milestoneId != job.currentMilestone || milestoneId >= milestones[jobId].length) revert InvalidStatus();
        return milestones[jobId][milestoneId];
    }

    function _submitted(Job storage job, Milestone storage item, uint16 expectedVersion) private view {
        if (job.status != Status.Submitted || item.submissionVersion != expectedVersion) revert InvalidStatus();
    }

    function _pay(uint256 jobId, Job storage job, Milestone storage item) private {
        uint256 amount = item.amountWei;
        uint256 milestoneId = job.currentMilestone;
        item.status = MilestoneStatus.Paid;
        job.escrowWei -= amount;
        job.paidWei += amount;
        job.currentMilestone++;
        job.status = job.currentMilestone == milestones[jobId].length ? Status.Paid : Status.Funded;
        emit MilestonePaid(jobId, milestoneId, job.freelancer, amount);
        _transfer(job.freelancer, amount);
    }

    function _transfer(address recipient, uint256 amount) private {
        (bool success, ) = recipient.call{value: amount}("");
        if (!success) revert TransferFailed();
    }

    function _checkText(string calldata value, uint256 maxBytes) private pure {
        if (bytes(value).length == 0 || bytes(value).length > maxBytes) revert InvalidText();
    }
}
