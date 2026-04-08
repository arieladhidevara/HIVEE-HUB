from __future__ import annotations

from typing import Any, Dict, List, Optional

import httpx


class HiveeCloudError(RuntimeError):
    pass


class HiveeCloudClient:
    def __init__(self, *, cloud_url: str, timeout_sec: int = 20, verify_ssl: bool = True) -> None:
        self.cloud_url = str(cloud_url or "").strip().rstrip("/")
        self._client = httpx.Client(
            base_url=self.cloud_url,
            timeout=max(3, min(int(timeout_sec or 20), 120)),
            verify=bool(verify_ssl),
            follow_redirects=True,
            headers={"User-Agent": "hivee-hub/0.1.0"},
        )

    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> "HiveeCloudClient":
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        self.close()

    def install_complete(
        self,
        *,
        install_token: str,
        machine_name: str,
        os_type: str,
        hub_version: str,
    ) -> Dict[str, Any]:
        return self._post(
            "/api/hub/install/complete",
            {
                "install_token": install_token,
                "machine_name": machine_name,
                "os_type": os_type,
                "hub_version": hub_version,
            },
        )

    def heartbeat(
        self,
        *,
        connection_id: str,
        install_token: str,
        hub_status: str,
        machine_name: str,
        os_type: str,
        hub_version: str,
    ) -> Dict[str, Any]:
        return self._post(
            "/api/hub/heartbeat",
            {
                "connection_id": connection_id,
                "install_token": install_token,
                "hub_status": hub_status,
                "machine_name": machine_name,
                "os_type": os_type,
                "hub_version": hub_version,
            },
        )

    def report_agents_discovered(
        self,
        *,
        connection_id: str,
        install_token: str,
        agents: List[Dict[str, Any]],
    ) -> Dict[str, Any]:
        return self._post(
            "/api/hub/agents/discovered",
            {
                "connection_id": connection_id,
                "install_token": install_token,
                "agents": agents,
            },
        )

    def upload_agent_card(
        self,
        *,
        managed_agent_id: str,
        connection_id: str,
        install_token: str,
        agent_card_json: Dict[str, Any],
        agent_card_version: str = "1.0",
    ) -> Dict[str, Any]:
        return self._post(
            f"/api/hub/agents/{managed_agent_id}/card",
            {
                "connection_id": connection_id,
                "install_token": install_token,
                "agent_card_json": agent_card_json,
                "agent_card_version": agent_card_version,
            },
        )

    def claim_runtime_job(
        self,
        *,
        connection_id: str,
        install_token: str,
        max_wait_sec: int = 1,
    ) -> Optional[Dict[str, Any]]:
        res = self._post(
            "/api/hub/runtime/jobs/claim",
            {
                "connection_id": connection_id,
                "install_token": install_token,
                "max_wait_sec": max(0, min(int(max_wait_sec or 0), 20)),
            },
        )
        job = res.get("job") if isinstance(res, dict) else None
        return dict(job) if isinstance(job, dict) else None

    def complete_runtime_job(
        self,
        *,
        job_id: str,
        connection_id: str,
        install_token: str,
        status: str,
        result_text: str = "",
        error_text: str = "",
    ) -> Dict[str, Any]:
        return self._post(
            f"/api/hub/runtime/jobs/{job_id}/complete",
            {
                "connection_id": connection_id,
                "install_token": install_token,
                "status": str(status or "").strip().lower() or "completed",
                "result_text": str(result_text or ""),
                "error_text": str(error_text or ""),
            },
        )

    def _post(self, path: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        try:
            res = self._client.post(path, json=payload)
        except Exception as exc:
            raise HiveeCloudError(f"{path}: request failed: {exc}") from exc

        body: Any
        try:
            body = res.json()
        except Exception:
            body = {"raw": res.text}

        if res.status_code >= 400:
            raise HiveeCloudError(f"{path}: HTTP {res.status_code}: {body}")

        if isinstance(body, dict):
            return body
        return {"ok": True, "data": body}