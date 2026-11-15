export function errorLayers(error) {
  const layers = [];
  const pending = [error];
  const seen = new Set();
  while (pending.length && seen.size < 32) {
    const item = pending.shift();
    if (!item || typeof item !== "object" || seen.has(item)) continue;
    seen.add(item);
    const row = {};
    if (["number", "string"].includes(typeof item.code)) row.code = item.code;
    const message = item.shortMessage || item.message;
    if (typeof message === "string") row.message = message.replace(/https?:\/\/[^\s"'<>]+/gi, "[URL]").slice(0, 500);
    if (typeof item.data === "string" && /^0x(?:[a-f0-9]{2})*$/i.test(item.data)) {
      row.revertData = item.data.slice(0, 4098);
    }
    if (Object.keys(row).length) layers.push(row);
    for (const key of ["data", "error", "originalError", "info", "cause"]) pending.push(item[key]);
  }
  return layers;
}

export function trackWallet(provider) {
  const state = { chainId: null, account: null, failures: new Map() };
  state.request = async ({ method, params }) => {
    try {
      const result = await provider.request({ method, ...(params ? { params } : {}) });
      if (method === "eth_chainId") state.chainId = Number(BigInt(result));
      if (["eth_accounts", "eth_requestAccounts"].includes(method)) state.account = result?.[0] || null;
      return result;
    } catch (error) {
      state.failures.set(method, { method, from: params?.[0]?.from, layers: errorLayers(error), error });
      throw error;
    }
  };
  return state;
}

export function readDiagnostic(error, wallet, context) {
  const method = error.info?.payload?.method || error.payload?.method;
  const raw = wallet?.failures.get(method) ||
    (!method ? [...(wallet?.failures.values() || [])].findLast((failure) => failure.error === error) : undefined);
  wallet?.failures.clear();
  const layers = errorLayers(error);
  const combined = [...(raw?.layers || []), ...layers];
  return {
    ...context,
    time: new Date().toISOString(),
    method: method || raw?.method || error.rpcMethod || null,
    errorCode: combined.find((layer) => typeof layer.code === "number")?.code ?? error.code ?? null,
    message: raw?.layers[0]?.message || layers[0]?.message || null,
    revertData: combined.find((layer) => layer.revertData)?.revertData ?? null,
    chainId: wallet?.chainId ?? context.expectedChainId,
    from: raw?.from || error.info?.payload?.params?.[0]?.from || context.from || wallet?.account || null,
    providerError: raw?.layers,
    ethersError: layers,
  };
}
