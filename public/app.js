const CLOUD_BASE_URL = "https://hivee.cloud/";

const pairingTokenInput = document.getElementById("pairingToken");
const openclawTokenInput = document.getElementById("openclawToken");
const pairingLog = document.getElementById("pairingResult");
const openclawLog = document.getElementById("openclawResult");
const candidateButtons = document.getElementById("candidateButtons");
const hiveeStatusDot = document.getElementById("hiveeStatusDot");
const hiveeStatusText = document.getElementById("hiveeStatusText");
const openclawStatusDot = document.getElementById("openclawStatusDot");
const openclawStatusText = document.getElementById("openclawStatusText");

let latestConfig = {
  baseUrl: "",
  discoveryCandidates: "",
  token: "",
  requestTimeoutMs: 20000
};

let dockerCandidates = [];
let selectedBaseUrl = "";

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

function summarizeCandidate(candidate) {
  const modelCount = Array.isArray(candidate?.models) ? candidate.models.length : 0;
  const endpoint = candidate?.endpoint || "/v1/models";
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

function renderCandidateButtons() {
  candidateButtons.innerHTML = "";

  if (!dockerCandidates.length) {
    const button = document.createElement("button");
    button.className = "candidate-btn";
    button.disabled = true;
    button.textContent = "No candidate yet";
    candidateButtons.appendChild(button);
    return;
  }

  for (const candidate of dockerCandidates) {
    const button = document.createElement("button");
    button.className = "candidate-btn";
    if (candidate.baseUrl === selectedBaseUrl) {
      button.classList.add("active");
    }
    button.type = "button";
    button.innerHTML = `${candidate.baseUrl}<span class="candidate-sub">${summarizeCandidate(candidate)}</span>`;
    button.addEventListener("click", () => chooseCandidate(candidate.baseUrl));
    candidateButtons.appendChild(button);
  }
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

  if (pairing.status === "paired") {
    setStatus(hiveeStatusDot, hiveeStatusText, "connected", `Connected (${pairing.connectorId || "paired"})`);
  } else if (pairing.status === "error") {
    setStatus(hiveeStatusDot, hiveeStatusText, "error", pairing.lastError || "Connection error");
  } else if (pairing.status === "pairing") {
    setStatus(hiveeStatusDot, hiveeStatusText, "idle", "Connecting...");
  } else {
    setStatus(hiveeStatusDot, hiveeStatusText, "idle", "Disconnected");
  }

  if (openclaw.healthy) {
    setStatus(openclawStatusDot, openclawStatusText, "connected", `Connected (${openclaw.baseUrl || "OpenClaw"})`);
  } else if (openclaw.lastError) {
    setStatus(openclawStatusDot, openclawStatusText, "error", openclaw.lastError);
  } else {
    setStatus(openclawStatusDot, openclawStatusText, "idle", "Disconnected");
  }

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
  setLog(openclawLog, "Scanning Docker candidates...");
  const data = await postJson("/api/openclaw/discover/docker", {});
  setLog(openclawLog, data);

  dockerCandidates = Array.isArray(data?.scan?.healthyCandidates) ? data.scan.healthyCandidates : [];
  if (data?.scan?.recommendedBaseUrl) {
    selectedBaseUrl = data.scan.recommendedBaseUrl;
  } else if (!selectedBaseUrl && dockerCandidates[0]?.baseUrl) {
    selectedBaseUrl = dockerCandidates[0].baseUrl;
  }
  renderCandidateButtons();
}

async function connectHivee() {
  const token = pairingTokenInput.value.trim();
  if (!token) {
    setLog(pairingLog, "Hivee token is required.");
    return;
  }

  setLog(pairingLog, "Connecting to Hivee...");
  const data = await postJson("/api/pairing/start", {
    cloudBaseUrl: CLOUD_BASE_URL,
    pairingToken: token
  });
  setLog(pairingLog, data);
  await getStatus();
}

async function connectOpenClaw() {
  const baseUrl = (selectedBaseUrl || latestConfig.baseUrl || "").trim();
  if (!baseUrl) {
    setLog(openclawLog, "Select or discover an OpenClaw candidate first.");
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

  setLog(openclawLog, "Saving OpenClaw connection...");
  const saveResult = await postJson("/api/openclaw/config", payload);
  if (!saveResult?.ok) {
    setLog(openclawLog, saveResult);
    await getStatus();
    return;
  }

  const discoverResult = await postJson("/api/openclaw/discover", {});
  setLog(openclawLog, {
    save: saveResult,
    discover: discoverResult
  });
  await getStatus();
}

document.getElementById("pairButton").addEventListener("click", connectHivee);
document.getElementById("dockerScanButton").addEventListener("click", scanDockerCandidates);
document.getElementById("saveOpenclawConfigButton").addEventListener("click", connectOpenClaw);
document.getElementById("refreshButton").addEventListener("click", getStatus);

await getStatus();
await scanDockerCandidates();
