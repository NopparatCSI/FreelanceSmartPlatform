const { mkdirSync } = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const state = path.join(root, ".local");
mkdirSync(state, { recursive: true });
const env = {
  ...process.env,
  APPDATA: state,
  LOCALAPPDATA: state,
  XDG_CONFIG_HOME: state,
  XDG_CACHE_HOME: state,
  XDG_DATA_HOME: state,
  TEMP: state,
  TMP: state,
  TMPDIR: state,
  HARDHAT_DISABLE_TELEMETRY: "1",
};
const args = process.argv.slice(2);
if (args[0] === "--demo" || args[0] === "--local") {
  env.ESCROW_MODE = args[0] === "--demo" ? "demo" : "wallet";
  args.shift();
}
const result = spawnSync(process.execPath, [
  require.resolve("hardhat/internal/cli/bootstrap"), ...args,
], { cwd: root, env, stdio: "inherit" });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
