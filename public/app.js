const statusView = document.getElementById("statusView");
const pairingResult = document.getElementById("pairingResult");
const openclawResult = document.getElementById("openclawResult");
const commandResult = document.getElementById("commandResult");
const statusBadge = document.getElementById("status-badge");

function setInputValue(id, value) {
  const element = document.getElementById(id);
  if (!element) return;
  if (document.activeElement === element) return;
  const next = value ?? "";
  if (element.value !== next) element.value = next;
}

function applyOpenClawConfig(config) {
  if (!config) return;
  setInputValue("openclawBaseUrl", config.baseUrl || "");
  setInputValue("openclawDiscoveryCandidates", config.discoveryCandidates || "");
  setInputValue("openclawToken", config.token || "");
  setInputValue("openclawTransport", config.transport || "auto");
  setInputValue("openclawWsPath", config.wsPath || "");
  setInputValue("openclawTimeout", String(config.requestTimeoutMs || 20000));
}

function readOpenClawConfigForm() {
  const timeoutRaw = document.getElementById("openclawTimeout").value;
  const timeoutNum = Number(timeoutRaw);
  return {
    baseUrl: document.getElementById("openclawBaseUrl").value.trim(),
    discoveryCandidates: document.getElementById("openclawDiscoveryCandidates").value.trim(),
    token: document.getElementById("openclawToken").value.trim(),
    transport: document.getElementById("openclawTransport").value,
    wsPath: document.getElementById("openclawWsPath").value.trim(),
    requestTimeoutMs: Number.isFinite(timeoutNum) && timeoutNum > 0 ? Math.round(timeoutNum) : 20000
  };
}

async function getStatus() {
  const res = await fetch("/api/status");
  const data = await res.json();
  statusView.textContent = JSON.stringify(data, null, 2);
  applyOpenClawConfig(data?.openclawConfig);

  if (data?.pairing?.status === "paired") {
    statusBadge.textContent = "paired";
    statusBadge.className = "badge badge-ok";
  } else if (data?.pairing?.status === "error") {
    statusBadge.textContent = "error";
    statusBadge.className = "badge badge-err";
  } else {
    statusBadge.textContent = data?.pairing?.status || "unpaired";
    statusBadge.className = "badge badge-warn";
  }

  const cloudInput = document.getElementById("cloudBaseUrl");
  const tokenInput = document.getElementById("pairingToken");
  if (data?.pairing?.cloudBaseUrl && !cloudInput.value) cloudInput.value = data.pairing.cloudBaseUrl;
  if (data?.pairing?.pairingToken && !tokenInput.value) tokenInput.value = data.pairing.pairingToken;
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {})
  });
  return res.json();
}

document.getElementById("refreshButton").addEventListener("click", getStatus);

document.getElementById("saveOpenclawConfigButton").addEventListener("click", async () => {
  openclawResult.textContent = "Saving OpenClaw config...";
  const payload = readOpenClawConfigForm();
  const data = await postJson("/api/openclaw/config", payload);
  openclawResult.textContent = JSON.stringify(data, null, 2);
  applyOpenClawConfig(data?.config);
  await getStatus();
});

document.getElementById("resetOpenclawConfigButton").addEventListener("click", async () => {
  openclawResult.textContent = "Resetting OpenClaw config...";
  const data = await postJson("/api/openclaw/config/reset", {});
  openclawResult.textContent = JSON.stringify(data, null, 2);
  applyOpenClawConfig(data?.config);
  await getStatus();
});

document.getElementById("discoverButton").addEventListener("click", async () => {
  openclawResult.textContent = "Discovering...";
  const data = await postJson("/api/openclaw/discover", {});
  openclawResult.textContent = JSON.stringify(data, null, 2);
  await getStatus();
});

document.getElementById("pairButton").addEventListener("click", async () => {
  const cloudBaseUrl = document.getElementById("cloudBaseUrl").value.trim();
  const pairingToken = document.getElementById("pairingToken").value.trim();
  pairingResult.textContent = "Pairing...";
  const data = await postJson("/api/pairing/start", { cloudBaseUrl, pairingToken });
  pairingResult.textContent = JSON.stringify(data, null, 2);
  await getStatus();
});

document.getElementById("clearPairingButton").addEventListener("click", async () => {
  const data = await postJson("/api/pairing/clear", {});
  pairingResult.textContent = JSON.stringify(data, null, 2);
  await getStatus();
});

document.getElementById("commandButton").addEventListener("click", async () => {
  const type = document.getElementById("commandType").value;
  const payloadRaw = document.getElementById("commandPayload").value;
  let payload = {};
  try {
    payload = JSON.parse(payloadRaw || "{}");
  } catch (error) {
    commandResult.textContent = `Invalid JSON: ${error.message}`;
    return;
  }
  const data = await postJson("/api/commands/execute", {
    id: `manual_${Date.now()}`,
    type,
    payload
  });
  commandResult.textContent = JSON.stringify(data, null, 2);
  await getStatus();
});

getStatus();
