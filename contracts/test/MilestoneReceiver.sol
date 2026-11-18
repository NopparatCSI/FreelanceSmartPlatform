// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {FreelanceEscrowV2} from "../FreelanceEscrowV2.sol";

contract MilestoneReceiver {
    FreelanceEscrowV2 public escrow;
    bool public rejectPayment;
    bool public reentrySucceeded;
    uint256 private activeJob;

    function accept(FreelanceEscrowV2 target, uint256 jobId) external {
        escrow = target;
        activeJob = jobId;
        target.acceptAgreement(jobId);
    }

    function deliver(uint256 milestoneId, string calldata proof) external {
        escrow.submitWork(activeJob, milestoneId, proof);
    }

    function setReject(bool reject_) external {
        rejectPayment = reject_;
    }

    receive() external payable {
        require(!rejectPayment, "Rejecting payment");
        // Recipient is not the client and the settlement lock also rejects this call.
        try escrow.approveAndPay(activeJob, 0, 1) {
            reentrySucceeded = true;
        } catch {}
    }
}
