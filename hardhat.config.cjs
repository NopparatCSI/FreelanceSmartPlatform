require("@nomicfoundation/hardhat-ethers");
const { subtask } = require("hardhat/config");
const { TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD } = require("hardhat/builtin-tasks/task-names");

subtask(TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD).setAction(({ solcVersion }, _, runSuper) => {
  if (solcVersion !== "0.8.30") return runSuper();
  return {
    compilerPath: require.resolve("solc/soljson.js"),
    isSolcJs: true,
    version: solcVersion,
    longVersion: require("solc").version(),
  };
});

module.exports = {
  solidity: { version: "0.8.30", settings: { optimizer: { enabled: true, runs: 200 } } },
  networks: { hardhat: { chainId: 31337 } },
};
