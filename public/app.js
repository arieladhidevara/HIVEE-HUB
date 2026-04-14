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
const pairEditButton = document.getElementById("pairEditButton");
const openclawEditButton = document.getElementById("openclawEditButton");

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const LOG_MAX_ENTRIES = 80;
const REFRESH_POLL_MS = 3000;
const DRAFT_CONNECTION_ID = "__draft__";

let activeConnectionId = null;
let logSequence = 0;
let latestRefreshRequest = 0;
let connectionsCache = [];

// Per-connection state keyed by connectionId
const connState = {};

function getState(id) {
  if (!connState[id]) {
    connState[id] = {
      latestConfig: { baseUrl: "", discoveryCandidates: "", token: "", requestTimeoutMs: 0 },
      dockerCandidates: [],
      selectedBaseUrl: "",
      clientLogs: [],
      serverLogs: [],
      hiveeConnected: false,
      openclawConnected: false
    };
  }
  return connState[id];
}

function currentConnectionKey() {
  return activeConnectionId || DRAFT_CONNECTION_ID;
}

function currentState() {
  return getState(currentConnectionKey());
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function setStatus(dot, textNode, state, label) {
  dot.className = "status-dot";
  if (state === "connected") dot.classList.add("connected");
  else if (state === "error") dot.classList.add("error");
  textNode.textContent = label;
}

function safeJson(value) {
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

function setLog(target, payload) {
  target.textContent = typeof payload === "string" ? payload : safeJson(payload);
}

function formatLogTime(timestamp) {
  return new Date(timestamp).toLocaleTimeString("en-GB", { hour12: false });
}

function buildLogEntry(key, timestamp, sequence, scope, payload) {
  const header = `[${formatLogTime(timestamp)}] [${scope}]`;
  const body = typeof payload === "string" ? payload : safeJson(payload);
  return { key, timestamp, sequence, text: `${header}\n${body}` };
}

function eventScope(event) {
  switch (event?.kind) {
    case "cloud.command.received":
    case "cloud.command.poll_error":
      return "Cloud -> OpenClaw";
    case "cloud.command.result":
    case "cloud.command.result_error":
    case "heartbeat.ok":
    case "heartbeat.error":
      return "OpenClaw -> Cloud";
    default:
      if (String(event?.kind || "").startsWith("pairing")) return "Hivee";
      if (String(event?.kind || "").startsWith("command.")) return "OpenClaw";
      if (String(event?.kind || "").startsWith("openclaw")) return "OpenClaw";
      return "Hub";
  }
}

function syncServerLogs(connectionId, recentEvents) {
  const s = getState(connectionId);
  const events = Array.isArray(recentEvents) ? recentEvents.slice().reverse() : [];
  s.serverLogs = events.map((event, index) =>
    buildLogEntry(
      `server:${event.id}`,
      Number.isFinite(event?.createdAt) ? Number(event.createdAt) : Date.now(),
      Number.isFinite(event?.id) ? Number(event.id) : index,
      eventScope(event),
      event?.meta ? `${event.message}\n${safeJson(event.meta)}` : event.message
    )
  );
}

function renderActivityLog(connectionId = currentConnectionKey()) {
  if (connectionId !== currentConnectionKey()) return;
  const s = getState(connectionId);
  const lines = [...s.serverLogs, ...s.clientLogs]
    .sort((a, b) => (a.timestamp - b.timestamp) || (a.sequence - b.sequence))
    .slice(-LOG_MAX_ENTRIES)
    .map((entry) => entry.text);

  setLog(activityLog, lines.length ? lines.join("\n\n") : "No activity yet.");
  activityLog.scrollTop = activityLog.scrollHeight;
}

function appendLog(scope, payload) {
  const s = currentState();
  s.clientLogs.push(buildLogEntry(`client:${++logSequence}`, Date.now(), logSequence, scope, payload));
  if (s.clientLogs.length > LOG_MAX_ENTRIES) s.clientLogs = s.clientLogs.slice(-LOG_MAX_ENTRIES);
  renderActivityLog(currentConnectionKey());
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

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

function apiBase(id) {
  return `/api/connections/${encodeURIComponent(id)}`;
}

async function parseJsonResponse(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { error: text };
  }
}

function getResponseError(response, payload) {
  if (payload && typeof payload === "object" && typeof payload.error === "string" && payload.error.trim()) {
    return payload.error;
  }
  return `Request failed (${response.status})`;
}

async function getJson(url) {
  const response = await fetch(url);
  const payload = await parseJsonResponse(response);
  if (!response.ok) throw new Error(getResponseError(response, payload));
  return payload;
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body || {})
  });
  const payload = await parseJsonResponse(response);
  if (!response.ok) throw new Error(getResponseError(response, payload));
  return payload;
}

async function deleteJson(url) {
  const response = await fetch(url, { method: "DELETE" });
  const payload = await parseJsonResponse(response);
  if (!response.ok) throw new Error(getResponseError(response, payload));
  return payload;
}

// ---------------------------------------------------------------------------
// Candidate helpers
// ---------------------------------------------------------------------------

function buildDiscoveryCandidates() {
  const s = currentState();
  const fromDocker = s.dockerCandidates.map((item) => item.baseUrl);
  const fromConfig = String(s.latestConfig.discoveryCandidates || "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
  return unique([s.selectedBaseUrl, s.latestConfig.baseUrl, ...fromDocker, ...fromConfig]);
}

function chooseCandidate(baseUrl) {
  const s = currentState();
  s.selectedBaseUrl = baseUrl || "";
  renderCandidateButtons();
}

function syncCandidateMeta() {
  if (!candidateMeta) return;
  const s = currentState();
  if (!s.dockerCandidates.length) {
    candidateMeta.textContent = "No candidate selected.";
    return;
  }
  const active = s.dockerCandidates.find((item) => item.baseUrl === s.selectedBaseUrl) || s.dockerCandidates[0];
  if (!s.selectedBaseUrl && active?.baseUrl) s.selectedBaseUrl = active.baseUrl;
  const picked = active?.baseUrl || "No candidate selected";
  candidateMeta.textContent = `${s.dockerCandidates.length} candidate(s). Selected: ${picked}`;
}

function renderCandidateButtons() {
  candidateButtons.innerHTML = "";
  const s = currentState();

  if (!s.dockerCandidates.length) {
    const button = document.createElement("button");
    button.className = "candidate-btn";
    button.disabled = true;
    button.textContent = "No candidate yet";
    candidateButtons.appendChild(button);
    syncCandidateMeta();
    return;
  }

  for (const candidate of s.dockerCandidates) {
    const button = document.createElement("button");
    button.className = "candidate-btn";
    if (candidate.baseUrl === s.selectedBaseUrl) button.classList.add("active");
    button.type = "button";
    button.disabled = s.openclawConnected;
    button.innerHTML = `${candidate.baseUrl}<span class="candidate-sub">${summarizeCandidate(candidate)}</span>`;
    button.addEventListener("click", () => { if (!s.openclawConnected) chooseCandidate(candidate.baseUrl); });
    candidateButtons.appendChild(button);
  }

  syncCandidateMeta();
}

// ---------------------------------------------------------------------------
// Workspace rendering from connection status
// ---------------------------------------------------------------------------

function syncWorkspaceFromStatus(status) {
  const id = status.connectionId || activeConnectionId;
  const s = getState(id);
  if (!activeConnectionId || id !== activeConnectionId) return; // only render if it's the active connection

  const pairing = status?.pairing || {};
  const openclaw = status?.openclaw || {};
  const config = status?.openclawConfig || {};

  s.latestConfig = {
    baseUrl: String(config.baseUrl || "").trim(),
    discoveryCandidates: String(config.discoveryCandidates || "").trim(),
    token: String(config.token || "").trim(),
    requestTimeoutMs: Number.isFinite(config.requestTimeoutMs) ? Number(config.requestTimeoutMs) : 0
  };

  if (!pairingTokenInput.value && pairing.pairingToken) {
    pairingTokenInput.value = pairing.pairingToken;
  }
  if (document.activeElement !== openclawTokenInput) {
    openclawTokenInput.value = s.latestConfig.token || "";
  }

  s.hiveeConnected = pairing.status === "paired";
  s.openclawConnected = openclaw.healthy === true;

  if (s.hiveeConnected) {
    setStatus(hiveeStatusDot, hiveeStatusText, "connected", `Connected (${pairing.connectorId || "paired"})`);
  } else if (pairing.status === "error") {
    setStatus(hiveeStatusDot, hiveeStatusText, "error", pairing.lastError || "Connection error");
  } else if (pairing.status === "pairing") {
    setStatus(hiveeStatusDot, hiveeStatusText, "idle", "Connecting...");
  } else {
    setStatus(hiveeStatusDot, hiveeStatusText, "idle", "Disconnected");
  }

  if (s.openclawConnected) {
    setStatus(openclawStatusDot, openclawStatusText, "connected", `Connected (${openclaw.baseUrl || "OpenClaw"})`);
  } else if (openclaw.lastError) {
    setStatus(openclawStatusDot, openclawStatusText, "error", openclaw.lastError);
  } else {
    setStatus(openclawStatusDot, openclawStatusText, "idle", "Disconnected");
  }

  pairingTokenInput.disabled = s.hiveeConnected;
  pairButton.disabled = s.hiveeConnected;
  pairButton.textContent = s.hiveeConnected ? "Connected" : "Connect";
  pairEditButton.hidden = !s.hiveeConnected;

  openclawTokenInput.disabled = s.openclawConnected;
  saveOpenclawConfigButton.disabled = s.openclawConnected;
  saveOpenclawConfigButton.textContent = s.openclawConnected ? "Connected" : "Connect";
  dockerScanButton.disabled = s.openclawConnected;
  openclawEditButton.hidden = !s.openclawConnected;

  if (!s.selectedBaseUrl && s.latestConfig.baseUrl) {
    s.selectedBaseUrl = s.latestConfig.baseUrl;
  }

  syncServerLogs(id, status?.recentEvents || []);
  renderActivityLog(id);
}

function renderEmptyWorkspace() {
  const s = currentState();
  s.hiveeConnected = false;
  s.openclawConnected = false;
  s.selectedBaseUrl = s.selectedBaseUrl || "";
  s.dockerCandidates = Array.isArray(s.dockerCandidates) ? s.dockerCandidates : [];

  setStatus(hiveeStatusDot, hiveeStatusText, "idle", "Disconnected");
  setStatus(openclawStatusDot, openclawStatusText, "idle", "Disconnected");

  pairingTokenInput.disabled = false;
  pairButton.disabled = false;
  pairButton.textContent = "Connect";
  pairEditButton.hidden = true;

  openclawTokenInput.disabled = false;
  saveOpenclawConfigButton.disabled = false;
  saveOpenclawConfigButton.textContent = "Connect";
  dockerScanButton.disabled = false;
  openclawEditButton.hidden = true;

  if (document.activeElement !== pairingTokenInput) {
    pairingTokenInput.value = "";
  }
  if (document.activeElement !== openclawTokenInput) {
    openclawTokenInput.value = "";
  }

  renderCandidateButtons();
  renderActivityLog(currentConnectionKey());
}

// ---------------------------------------------------------------------------
// Connections bar rendering
// ---------------------------------------------------------------------------

function renderConnectionsBar(connections) {
  const list = document.getElementById("connectionsList");
  if (!list) return;

  if (!connections.length) {
    list.innerHTML = '<div class="connection-empty">No active connections yet.</div>';
    return;
  }

  list.innerHTML = "";

  for (const conn of connections) {
    const pairing = conn.pairing || {};
    const openclaw = conn.openclaw || {};
    const hiveeOk = pairing.status === "paired";
    const openclawOk = openclaw.healthy === true;
    const bothConnected = hiveeOk && openclawOk;
    const isSelected = conn.id === activeConnectionId;
    const connectionName = String(conn.name || `Connection ${connections.indexOf(conn) + 1}`).trim();

    const connectorLabel = pairing.connectorId
      ? pairing.connectorId.slice(0, 14) + (pairing.connectorId.length > 14 ? "…" : "")
      : conn.name || conn.id;
    const openclawLabel = openclaw.baseUrl
      ? openclaw.baseUrl.replace(/^https?:\/\//, "").slice(0, 22)
      : "OpenClaw";

    const card = document.createElement("div");
    card.className = `connection-card${bothConnected ? " both-connected" : ""}${isSelected ? " selected" : ""}`;
    card.dataset.connId = conn.id;
    card.classList.add("has-delete");

    const badgeNum = connections.indexOf(conn) + 1;
    card.innerHTML = `
      <div class="connection-badge">${badgeNum}</div>
      <div class="connection-info">
        <div class="connection-name">${connectorLabel} · ${openclawLabel}</div>
        <div class="connection-dots">
          <span class="status-dot${hiveeOk ? " connected" : pairing.status === "error" ? " error" : ""}"></span>
          <span class="connection-dot-label">Hivee</span>
          <span class="status-dot${openclawOk ? " connected" : openclaw.lastError ? " error" : ""}"></span>
          <span class="connection-dot-label">OpenClaw</span>
        </div>
      </div>
      ${conn.id !== "default" ? '<button class="connection-delete-btn" title="Delete connection">×</button>' : ""}
    `;

    card.addEventListener("click", async (e) => {
      if (e.target.closest(".connection-delete-btn")) return;
      await switchToConnection(conn.id);
      flashWorkspace();
    });

    let deleteBtn = card.querySelector(".connection-delete-btn");
    if (!deleteBtn) {
      deleteBtn = document.createElement("button");
      deleteBtn.className = "connection-delete-btn";
      deleteBtn.type = "button";
      card.appendChild(deleteBtn);
    }
    const nameNode = card.querySelector(".connection-name");
    if (nameNode) {
      nameNode.textContent = `${connectionName} - ${openclawLabel}`;
    }
    if (deleteBtn) {
      deleteBtn.textContent = "x";
      deleteBtn.type = "button";
      deleteBtn.disabled = false;
      deleteBtn.title = "Delete connection";
      deleteBtn.setAttribute("aria-label", `Delete ${connectionName}`);
      deleteBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        await removeConnection(conn.id);
      });
    }

    list.appendChild(card);
  }
}

// ---------------------------------------------------------------------------
// Connection switching
// ---------------------------------------------------------------------------

async function switchToConnection(id) {
  activeConnectionId = id;

  // Reset workspace form state
  pairingTokenInput.value = "";
  openclawTokenInput.value = "";

  await refreshActiveConnection();
  renderCandidateButtons();
}

function nextConnectionName() {
  const used = new Set(
    connectionsCache
      .map((conn) => String(conn?.name || "").trim())
      .filter(Boolean)
  );
  let index = 1;
  while (used.has(`Connection ${index}`)) {
    index += 1;
  }
  return `Connection ${index}`;
}

async function ensureActiveConnection() {
  if (activeConnectionId) return activeConnectionId;

  const draft = getState(DRAFT_CONNECTION_ID);
  const data = await postJson("/api/connections", { name: nextConnectionName() });
  if (!data?.ok || !data?.id) {
    throw new Error("Could not create a new connection");
  }

  activeConnectionId = data.id;
  connState[data.id] = {
    latestConfig: { ...draft.latestConfig },
    dockerCandidates: [...draft.dockerCandidates],
    selectedBaseUrl: draft.selectedBaseUrl,
    clientLogs: [...draft.clientLogs],
    serverLogs: [...draft.serverLogs],
    hiveeConnected: draft.hiveeConnected,
    openclawConnected: draft.openclawConnected
  };

  await refreshConnectionsList();
  return data.id;
}

async function refreshActiveConnection(options = {}) {
  const { silent = false } = options;
  if (!activeConnectionId) {
    const connections = await refreshConnectionsList();
    if (connections[0]?.id) {
      activeConnectionId = connections[0].id;
      return await refreshActiveConnection(options);
    }
    renderEmptyWorkspace();
    return;
  }

  const requestId = ++latestRefreshRequest;
  try {
    const status = await getJson(`${apiBase(activeConnectionId)}/status`);
    if (requestId !== latestRefreshRequest) return;
    syncWorkspaceFromStatus(status);
    await refreshConnectionsList();
  } catch (error) {
    if (String(error?.message || error).includes("Connection not found")) {
      activeConnectionId = null;
      await refreshActiveConnection({ silent });
      return;
    }
    if (!silent) {
      appendLog("Hub", `Error refreshing status: ${error?.message || String(error)}`);
    }
  }
}

async function refreshConnectionsList() {
  try {
    const data = await getJson("/api/connections");
    connectionsCache = Array.isArray(data.connections) ? data.connections : [];
    renderConnectionsBar(connectionsCache);
    return connectionsCache;
  } catch {
    return connectionsCache;
  }
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

async function scanDockerCandidates() {
  await ensureActiveConnection();
  const s = currentState();
  appendLog("OpenClaw", "Scanning Docker candidates...");
  try {
    const data = await postJson(`${apiBase(activeConnectionId)}/openclaw/discover/docker`, {
      token: openclawTokenInput.value.trim(),
      autoApply: true
    });
    appendLog("OpenClaw", data);

    s.dockerCandidates = Array.isArray(data?.scan?.healthyCandidates) ? data.scan.healthyCandidates : [];
    if (data?.scan?.recommendedBaseUrl) {
      s.selectedBaseUrl = data.scan.recommendedBaseUrl;
    } else if (!s.selectedBaseUrl && s.dockerCandidates[0]?.baseUrl) {
      s.selectedBaseUrl = s.dockerCandidates[0].baseUrl;
    }
    renderCandidateButtons();
    await refreshActiveConnection();
  } catch (error) {
    appendLog("OpenClaw", `Error: ${error?.message || String(error)}`);
  }
}

async function connectHivee() {
  const token = pairingTokenInput.value.trim();
  if (!token) { appendLog("Hivee", "Hivee token is required."); return; }

  await ensureActiveConnection();
  appendLog("Hivee", "Connecting to Hivee...");
  try {
    const data = await postJson(`${apiBase(activeConnectionId)}/pairing/start`, { pairingToken: token });
    appendLog("Hivee", data);
    await refreshActiveConnection();
  } catch (error) {
    appendLog("Hivee", `Error: ${error?.message || String(error)}`);
  }
}

async function connectOpenClaw() {
  await ensureActiveConnection();
  const s = currentState();
  const baseUrl = (s.selectedBaseUrl || s.latestConfig.baseUrl || "").trim();
  if (!baseUrl) { appendLog("OpenClaw", "Select or discover an OpenClaw candidate first."); return; }

  const payload = {
    baseUrl,
    discoveryCandidates: "",
    token: openclawTokenInput.value.trim(),
    transport: "http",
    wsPath: "",
    requestTimeoutMs: Number.isFinite(s.latestConfig.requestTimeoutMs) ? Number(s.latestConfig.requestTimeoutMs) : 0
  };

  appendLog("OpenClaw", "Saving OpenClaw connection...");
  try {
    const saveResult = await postJson(`${apiBase(activeConnectionId)}/openclaw/config`, payload);
    if (!saveResult?.ok) {
      appendLog("OpenClaw", saveResult);
      await refreshActiveConnection();
      return;
    }

    const discoverResult = await postJson(`${apiBase(activeConnectionId)}/openclaw/discover`, {});
    appendLog("OpenClaw", { save: saveResult, discover: discoverResult });
    await refreshActiveConnection();
  } catch (error) {
    appendLog("OpenClaw", `Error: ${error?.message || String(error)}`);
  }
}

async function clearActiveConnection() {
  if (!activeConnectionId) {
    renderEmptyWorkspace();
    return;
  }
  const s = currentState();
  try {
    await postJson(`${apiBase(activeConnectionId)}/pairing/clear`, {});
    await postJson(`${apiBase(activeConnectionId)}/openclaw/config/reset`, {});

    s.hiveeConnected = false;
    s.openclawConnected = false;
    s.selectedBaseUrl = "";
    s.dockerCandidates = [];

    pairingTokenInput.disabled = false;
    pairingTokenInput.value = "";
    pairButton.disabled = false;
    pairButton.textContent = "Connect";
    pairEditButton.hidden = true;
    openclawTokenInput.disabled = false;
    openclawTokenInput.value = "";
    saveOpenclawConfigButton.disabled = false;
    saveOpenclawConfigButton.textContent = "Connect";
    dockerScanButton.disabled = false;
    openclawEditButton.hidden = true;

    renderCandidateButtons();
    await refreshActiveConnection();
    appendLog("Hub", "Connection cleared.");
  } catch (error) {
    appendLog("Hub", `Error clearing connection: ${error?.message || String(error)}`);
  }
}

async function removeConnection(id) {
  try {
    const connection = connectionsCache.find((item) => item.id === id);
    const label = connection?.name || id;
    const confirmed = window.confirm(`Delete connection "${label}"? This removes its pairing, OpenClaw config, and saved activity.`);
    if (!confirmed) return;

    const result = await deleteJson(`/api/connections/${encodeURIComponent(id)}`);
    if (!result?.ok) {
      throw new Error(result?.error || `Could not delete connection ${id}`);
    }

    delete connState[id];
    if (activeConnectionId === id) {
      activeConnectionId = null;
    }
    const remaining = await refreshConnectionsList();
    if (!activeConnectionId && remaining[0]?.id) {
      activeConnectionId = remaining[0].id;
    }
    await refreshActiveConnection({ silent: true });
    appendLog("Hub", `${label} deleted.`);
  } catch (error) {
    appendLog("Hub", `Error deleting connection: ${error?.message || String(error)}`);
  }
}

function flashWorkspace() {
  const grid = document.querySelector(".workspace-grid");
  if (!grid) return;
  grid.classList.add("workspace-flash");
  setTimeout(() => grid.classList.remove("workspace-flash"), 600);
}

// ---------------------------------------------------------------------------
// Event listeners
// ---------------------------------------------------------------------------

pairButton.addEventListener("click", connectHivee);
dockerScanButton.addEventListener("click", scanDockerCandidates);
saveOpenclawConfigButton.addEventListener("click", connectOpenClaw);

document.getElementById("refreshButton").addEventListener("click", async () => {
  await refreshActiveConnection();
});

pairEditButton.addEventListener("click", async () => {
  if (!activeConnectionId) return;
  try {
    await postJson(`${apiBase(activeConnectionId)}/pairing/clear`, {});
    const s = currentState();
    s.hiveeConnected = false;
    pairingTokenInput.disabled = false;
    pairButton.disabled = false;
    pairButton.textContent = "Connect";
    pairEditButton.hidden = true;
    pairingTokenInput.value = "";
    pairingTokenInput.focus();
  } catch (error) {
    appendLog("Hivee", `Error clearing pairing: ${error?.message || String(error)}`);
  }
});

openclawEditButton.addEventListener("click", () => {
  const s = currentState();
  s.openclawConnected = false;
  openclawTokenInput.disabled = false;
  saveOpenclawConfigButton.disabled = false;
  saveOpenclawConfigButton.textContent = "Connect";
  dockerScanButton.disabled = false;
  openclawEditButton.hidden = true;
  renderCandidateButtons();
  openclawTokenInput.focus();
});

document.getElementById("newConnectionButton").addEventListener("click", async () => {
  try {
    const name = nextConnectionName();
    const data = await postJson("/api/connections", { name });
    if (data?.ok && data?.id) {
      await switchToConnection(data.id);
      pairingTokenInput.focus();
      appendLog("Hub", `New connection created (${name}).`);
    }
  } catch (error) {
    appendLog("Hub", `Error creating connection: ${error?.message || String(error)}`);
  }
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

const bootConnections = await refreshConnectionsList();
if (bootConnections[0]?.id) {
  activeConnectionId = bootConnections[0].id;
  await refreshActiveConnection({ silent: true });
} else {
  renderEmptyWorkspace();
}
setInterval(() => {
  void refreshActiveConnection({ silent: true });
}, REFRESH_POLL_MS);
