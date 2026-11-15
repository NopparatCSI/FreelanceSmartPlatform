// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {FreelanceEscrow} from "../FreelanceEscrow.sol";

/// @dev Test fixture with no payable receive or fallback function.
contract NonPayableFreelancer {
    function deliver(address escrow, uint256 jobId, string calldata proof) external {
        FreelanceEscrow(escrow).submitWork(jobId, proof);
    }
}
