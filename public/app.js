const pairingTokenInput = document.getElementById("pairingToken");
const openclawTokenInput = document.getElementById("openclawToken");
const activityLog = document.getElementById("activityLog");
const candidateMeta = document.getElementById("candidateMeta");
const candidateButtons = document.getElementById("candidateButtons");
const hiveeStatusDot = document.getElementById("hiveeStatusDot");
const hiveeStatusText = document.getElementById("hiveeStatusText");
const openclawStatusDot = document.getElementById("openclawStatusDot");
const openclawStatusText = document.getElementById("openclawStatusText");
const pairButton = document.getElementById("pairButton");
const saveOpenclawConfigButton = document.getElementById("saveOpenclawConfigButton");
const dockerScanButton = document.getElementById("dockerScanButton");

let latestConfig = {
  baseUrl: "",
  discoveryCandidates: "",
  token: "",
  requestTimeoutMs: 20000
};

let dockerCandidates = [];
let selectedBaseUrl = "";
const LOG_MAX_ENTRIES = 80;
let logEntries = [];
let hiveeConnected = false;
let openclawConnected = false;

function setStatus(dot, textNode, state, label) {
  dot.className = "status-dot";
  if (state === "connected") {
    dot.classList.add("connected");
  } else if (state === "error") {
    dot.classList.add("error");
  }
  textNode.textContent = label;
}

function safeJson(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function setLog(target, payload) {
  target.textContent = typeof payload === "string" ? payload : safeJson(payload);
}

function appendLog(scope, payload) {
  const stamp = new Date().toLocaleTimeString("en-GB", { hour12: false });
  const header = `[${stamp}] [${scope}]`;
  const body = typeof payload === "string" ? payload : safeJson(payload);
  logEntries.push(`${header}\n${body}`);
  if (logEntries.length > LOG_MAX_ENTRIES) {
    logEntries = logEntries.slice(-LOG_MAX_ENTRIES);
  }
  setLog(activityLog, logEntries.join("\n\n"));
  activityLog.scrollTop = activityLog.scrollHeight;
}

function summarizeCandidate(candidate) {
  const endpoint = candidate?.endpoint || "metadata";
  if (endpoint === "metadata") return "Detected from Docker metadata";
  const modelCount = Array.isArray(candidate?.models) ? candidate.models.length : 0;
  return `${modelCount} model(s) via ${endpoint}`;
}

function unique(items) {
  return Array.from(new Set(items.filter(Boolean)));
}

function buildDiscoveryCandidates() {
  const fromDocker = dockerCandidates.map((item) => item.baseUrl);
  const fromConfig = String(latestConfig.discoveryCandidates || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return unique([selectedBaseUrl, latestConfig.baseUrl, ...fromDocker, ...fromConfig]);
}

function chooseCandidate(baseUrl) {
  selectedBaseUrl = baseUrl || "";
  renderCandidateButtons();
}

function syncCandidateMeta() {
  if (!candidateMeta) return;
  if (!dockerCandidates.length) {
    candidateMeta.textContent = "No candidate selected.";
    return;
  }
  const active = dockerCandidates.find((item) => item.baseUrl === selectedBaseUrl) || dockerCandidates[0];
  if (!selectedBaseUrl && active?.baseUrl) selectedBaseUrl = active.baseUrl;
  const picked = active?.baseUrl || "No candidate selected";
  candidateMeta.textContent = `${dockerCandidates.length} candidate(s). Selected: ${picked}`;
}

function renderCandidateButtons() {
  candidateButtons.innerHTML = "";

  if (!dockerCandidates.length) {
    const button = document.createElement("button");
    button.className = "candidate-btn";
    button.disabled = true;
    button.textContent = "No candidate yet";
    candidateButtons.appendChild(button);
    syncCandidateMeta();
    return;
  }

  for (const candidate of dockerCandidates) {
    const button = document.createElement("button");
    button.className = "candidate-btn";
    if (candidate.baseUrl === selectedBaseUrl) button.classList.add("active");
    button.type = "button";
    button.disabled = openclawConnected;
    button.innerHTML = `${candidate.baseUrl}<span class="candidate-sub">${summarizeCandidate(candidate)}</span>`;
    button.addEventListener("click", () => { if (!openclawConnected) chooseCandidate(candidate.baseUrl); });
    candidateButtons.appendChild(button);
  }

  syncCandidateMeta();
}

function syncFromStatus(status) {
  const pairing = status?.pairing || {};
  const openclaw = status?.openclaw || {};
  const config = status?.openclawConfig || {};

  latestConfig = {
    baseUrl: String(config.baseUrl || "").trim(),
    discoveryCandidates: String(config.discoveryCandidates || "").trim(),
    token: String(config.token || "").trim(),
    requestTimeoutMs: Number.isFinite(config.requestTimeoutMs) ? Number(config.requestTimeoutMs) : 20000
  };

  if (!pairingTokenInput.value && pairing.pairingToken) {
    pairingTokenInput.value = pairing.pairingToken;
  }
  if (document.activeElement !== openclawTokenInput) {
    openclawTokenInput.value = latestConfig.token || "";
  }

  hiveeConnected = pairing.status === "paired";
  openclawConnected = openclaw.healthy === true;

  if (hiveeConnected) {
    setStatus(hiveeStatusDot, hiveeStatusText, "connected", `Connected (${pairing.connectorId || "paired"})`);
  } else if (pairing.status === "error") {
    setStatus(hiveeStatusDot, hiveeStatusText, "error", pairing.lastError || "Connection error");
  } else if (pairing.status === "pairing") {
    setStatus(hiveeStatusDot, hiveeStatusText, "idle", "Connecting...");
  } else {
    setStatus(hiveeStatusDot, hiveeStatusText, "idle", "Disconnected");
  }

  if (openclawConnected) {
    setStatus(openclawStatusDot, openclawStatusText, "connected", `Connected (${openclaw.baseUrl || "OpenClaw"})`);
  } else if (openclaw.lastError) {
    setStatus(openclawStatusDot, openclawStatusText, "error", openclaw.lastError);
  } else {
    setStatus(openclawStatusDot, openclawStatusText, "idle", "Disconnected");
  }

  pairingTokenInput.disabled = hiveeConnected;
  pairButton.disabled = hiveeConnected;
  pairButton.textContent = hiveeConnected ? "Connected" : "Connect";

  openclawTokenInput.disabled = openclawConnected;
  saveOpenclawConfigButton.disabled = openclawConnected;
  saveOpenclawConfigButton.textContent = openclawConnected ? "Connected" : "Connect";
  dockerScanButton.disabled = openclawConnected;

  if (!selectedBaseUrl && latestConfig.baseUrl) {
    selectedBaseUrl = latestConfig.baseUrl;
  }
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body || {})
  });
  return await response.json();
}

async function getStatus() {
  const response = await fetch("/api/status");
  const status = await response.json();
  syncFromStatus(status);
  renderCandidateButtons();
  return status;
}

async function scanDockerCandidates() {
  appendLog("OpenClaw", "Scanning Docker candidates...");
  try {
    const data = await postJson("/api/openclaw/discover/docker", {
      token: openclawTokenInput.value.trim(),
      autoApply: true
    });
    appendLog("OpenClaw", data);

    dockerCandidates = Array.isArray(data?.scan?.healthyCandidates) ? data.scan.healthyCandidates : [];
    if (data?.scan?.recommendedBaseUrl) {
      selectedBaseUrl = data.scan.recommendedBaseUrl;
    } else if (!selectedBaseUrl && dockerCandidates[0]?.baseUrl) {
      selectedBaseUrl = dockerCandidates[0].baseUrl;
    }
    renderCandidateButtons();
    await getStatus();
  } catch (error) {
    appendLog("OpenClaw", `Error: ${error?.message || String(error)}`);
  }
}

async function connectHivee() {
  const token = pairingTokenInput.value.trim();
  if (!token) {
    appendLog("Hivee", "Hivee token is required.");
    return;
  }

  appendLog("Hivee", "Connecting to Hivee...");
  try {
    const data = await postJson("/api/pairing/start", { pairingToken: token });
    appendLog("Hivee", data);
    await getStatus();
  } catch (error) {
    appendLog("Hivee", `Error: ${error?.message || String(error)}`);
  }
}

async function connectOpenClaw() {
  const baseUrl = (selectedBaseUrl || latestConfig.baseUrl || "").trim();
  if (!baseUrl) {
    appendLog("OpenClaw", "Select or discover an OpenClaw candidate first.");
    return;
  }

  const payload = {
    baseUrl,
    discoveryCandidates: buildDiscoveryCandidates().join(","),
    token: openclawTokenInput.value.trim(),
    transport: "http",
    wsPath: "",
    requestTimeoutMs: latestConfig.requestTimeoutMs || 20000
  };

  appendLog("OpenClaw", "Saving OpenClaw connection...");
  try {
    const saveResult = await postJson("/api/openclaw/config", payload);
    if (!saveResult?.ok) {
      appendLog("OpenClaw", saveResult);
      await getStatus();
      return;
    }

    const discoverResult = await postJson("/api/openclaw/discover", {});
    appendLog("OpenClaw", { save: saveResult, discover: discoverResult });
    await getStatus();
  } catch (error) {
    appendLog("OpenClaw", `Error: ${error?.message || String(error)}`);
  }
}

document.getElementById("pairButton").addEventListener("click", connectHivee);
document.getElementById("dockerScanButton").addEventListener("click", scanDockerCandidates);
document.getElementById("saveOpenclawConfigButton").addEventListener("click", connectOpenClaw);
document.getElementById("refreshButton").addEventListener("click", getStatus);

await getStatus();
await scanDockerCandidates();
