from __future__ import annotations

import platform
import socket
from dataclasses import dataclass, field
from typing import List


def _parse_bool(raw_value: str, *, default: bool = False) -> bool:
    text = str(raw_value or "").strip().lower()
    if not text:
        return default
    if text in {"1", "true", "yes", "y", "on"}:
        return True
    if text in {"0", "false", "no", "n", "off"}:
        return False
    return default


def _parse_int(raw_value: str, *, default: int, min_value: int, max_value: int) -> int:
    try:
        parsed = int(str(raw_value or "").strip())
    except Exception:
        parsed = default
    return max(min_value, min(parsed, max_value))


def _split_csv(raw_value: str) -> List[str]:
    seen = set()
    out: List[str] = []
    for item in str(raw_value or "").split(","):
        token = item.strip()
        if not token:
            continue
        if token in seen:
            continue
        seen.add(token)
        out.append(token)
    return out


@dataclass
class HubConfig:
    cloud_url: str = ""
    install_token: str = ""
    connection_id: str = ""
    runtime_type: str = "openclaw"
    machine_name: str = field(default_factory=lambda: socket.gethostname() or "unknown-host")
    os_type: str = field(default_factory=lambda: platform.system().lower() or "unknown")
    hub_version: str = "0.1.0"
    heartbeat_sec: int = 30
    discovery_sec: int = 60
    request_timeout_sec: int = 20
    verify_ssl: bool = True
    once: bool = False
    log_level: str = "INFO"

    openclaw_base_url: str = ""
    openclaw_api_key: str = ""
    openclaw_verify_ssl: bool = True
    manual_agent_ids: List[str] = field(default_factory=list)

    @classmethod
    def from_env(cls) -> "HubConfig":
        import os

        return cls(
            cloud_url=str(os.getenv("HIVEE_CLOUD_URL") or "").strip(),
            install_token=str(os.getenv("HIVEE_INSTALL_TOKEN") or "").strip(),
            connection_id=str(os.getenv("HIVEE_CONNECTION_ID") or "").strip(),
            runtime_type=str(os.getenv("HIVEE_RUNTIME_TYPE") or "openclaw").strip().lower() or "openclaw",
            machine_name=str(os.getenv("HIVEE_HUB_MACHINE_NAME") or socket.gethostname() or "unknown-host").strip(),
            os_type=str(os.getenv("HIVEE_HUB_OS_TYPE") or platform.system().lower() or "unknown").strip(),
            hub_version=str(os.getenv("HIVEE_HUB_VERSION") or "0.1.0").strip(),
            heartbeat_sec=_parse_int(os.getenv("HIVEE_HUB_HEARTBEAT_SEC") or "30", default=30, min_value=10, max_value=3600),
            discovery_sec=_parse_int(os.getenv("HIVEE_HUB_DISCOVERY_SEC") or "60", default=60, min_value=15, max_value=3600),
            request_timeout_sec=_parse_int(os.getenv("HIVEE_HUB_TIMEOUT_SEC") or "20", default=20, min_value=3, max_value=120),
            verify_ssl=not _parse_bool(os.getenv("HIVEE_CLOUD_INSECURE") or "", default=False),
            once=_parse_bool(os.getenv("HIVEE_HUB_ONCE") or "", default=False),
            log_level=str(os.getenv("HIVEE_HUB_LOG_LEVEL") or "INFO").strip() or "INFO",
            openclaw_base_url=str(os.getenv("OPENCLAW_BASE_URL") or "").strip(),
            openclaw_api_key=str(os.getenv("OPENCLAW_API_KEY") or "").strip(),
            openclaw_verify_ssl=not _parse_bool(os.getenv("OPENCLAW_INSECURE") or "", default=False),
            manual_agent_ids=_split_csv(os.getenv("HIVEE_RUNTIME_AGENT_IDS") or ""),
        )

    def validate(self) -> None:
        if not self.cloud_url:
            raise ValueError("cloud_url is required")
        if not self.install_token:
            raise ValueError("install_token is required")
        if self.runtime_type != "openclaw":
            raise ValueError("Only runtime_type=openclaw is supported in this version")
        self.cloud_url = self.cloud_url.rstrip("/")
        self.runtime_type = self.runtime_type.lower().strip() or "openclaw"
        self.machine_name = self.machine_name.strip() or "unknown-host"
        self.os_type = self.os_type.strip().lower() or "unknown"
        self.hub_version = self.hub_version.strip() or "0.1.0"
        self.log_level = (self.log_level or "INFO").strip().upper() or "INFO"
        self.heartbeat_sec = max(10, min(int(self.heartbeat_sec or 30), 3600))
        self.discovery_sec = max(15, min(int(self.discovery_sec or 60), 3600))
        self.request_timeout_sec = max(3, min(int(self.request_timeout_sec or 20), 120))