from __future__ import annotations

import logging
from typing import Any, Dict, List, Tuple

import httpx

from .base import RuntimeAgent, RuntimeChatResult


log = logging.getLogger("hivee_hub.runtime.openclaw")


class OpenClawRuntimeAdapter:
    def __init__(
        self,
        *,
        base_url: str,
        api_key: str,
        timeout_sec: int = 20,
        verify_ssl: bool = True,
        manual_agent_ids: List[str] | None = None,
    ) -> None:
        self.base_url = str(base_url or "").strip().rstrip("/")
        self.api_key = str(api_key or "").strip()
        self.timeout_sec = max(3, min(int(timeout_sec or 20), 120))
        self.verify_ssl = bool(verify_ssl)
        self.manual_agent_ids = list(manual_agent_ids or [])

    def discover_agents(self) -> List[RuntimeAgent]:
        discovered: List[RuntimeAgent] = []
        seen = set()

        if self.base_url:
            remote_agents = self._discover_from_openclaw()
            for agent in remote_agents:
                if agent.runtime_agent_id in seen:
                    continue
                seen.add(agent.runtime_agent_id)
                discovered.append(agent)

        for agent_id in self.manual_agent_ids:
            rid = str(agent_id or "").strip()
            if not rid or rid in seen:
                continue
            seen.add(rid)
            discovered.append(
                RuntimeAgent(
                    runtime_agent_id=rid,
                    agent_name=rid,
                    status="online",
                    agent_card_json=self._default_agent_card(runtime_agent_id=rid, agent_name=rid),
                )
            )

        return discovered

    def send_chat(self, *, runtime_agent_id: str, message: str, session_key: str, timeout_sec: int = 45) -> RuntimeChatResult:
        msg = str(message or "").strip()
        if not msg:
            return RuntimeChatResult(ok=False, error="runtime message is empty")
        if not self.base_url:
            return RuntimeChatResult(ok=False, error="OPENCLAW_BASE_URL is not configured")

        model = str(runtime_agent_id or "").strip() or "default"
        req_timeout = max(5, min(int(timeout_sec or self.timeout_sec), 120))

        headers: Dict[str, str] = {
            "Content-Type": "application/json",
            "User-Agent": "hivee-hub/0.1.0",
        }
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"

        requests: List[Tuple[str, str, Dict[str, Any]]] = [
            (
                "chat_completions",
                "/v1/chat/completions",
                {
                    "model": model,
                    "messages": [{"role": "user", "content": msg}],
                },
            ),
            (
                "chat_completions",
                "/api/v1/chat/completions",
                {
                    "model": model,
                    "messages": [{"role": "user", "content": msg}],
                },
            ),
            (
                "chat_completions",
                "/chat/completions",
                {
                    "model": model,
                    "messages": [{"role": "user", "content": msg}],
                },
            ),
            (
                "responses",
                "/v1/responses",
                {
                    "model": model,
                    "input": msg,
                },
            ),
            (
                "responses",
                "/api/v1/responses",
                {
                    "model": model,
                    "input": msg,
                },
            ),
            (
                "responses",
                "/responses",
                {
                    "model": model,
                    "input": msg,
                },
            ),
        ]

        last_error = ""
        with httpx.Client(timeout=req_timeout, verify=self.verify_ssl, follow_redirects=True) as client:
            for transport, path, payload in requests:
                url = f"{self.base_url}{path}"
                try:
                    res = client.post(url, headers=headers, json=payload)
                except Exception as exc:
                    last_error = f"{path}: request failed: {exc}"
                    continue

                raw_body = res.text[:800]
                if res.status_code >= 400:
                    last_error = f"{path}: HTTP {res.status_code}: {raw_body}"
                    continue

                data: Any = None
                try:
                    data = res.json()
                except Exception:
                    data = None

                text = self._extract_chat_text(data)
                if not text:
                    text = str(raw_body or "").strip()
                if text:
                    return RuntimeChatResult(
                        ok=True,
                        text=text,
                        metadata={
                            "path": path,
                            "transport": transport,
                            "runtime_agent_id": model,
                            "session_key": str(session_key or "").strip() or None,
                        },
                    )
                last_error = f"{path}: response parsed but text is empty"

        return RuntimeChatResult(
            ok=False,
            error=last_error or "No OpenClaw chat endpoint produced a response",
            metadata={
                "runtime_agent_id": model,
                "session_key": str(session_key or "").strip() or None,
            },
        )

    def _discover_from_openclaw(self) -> List[RuntimeAgent]:
        if not self.base_url:
            return []

        candidate_paths = [
            "/agents",
            "/api/agents",
            "/v1/agents",
            "/api/v1/agents",
            "/nodes",
            "/api/nodes",
            "/models",
            "/api/models",
            "/v1/models",
            "/api/v1/models",
        ]
        headers = {}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"

        with httpx.Client(timeout=self.timeout_sec, verify=self.verify_ssl, follow_redirects=True) as client:
            for path in candidate_paths:
                url = f"{self.base_url}{path}"
                try:
                    res = client.get(url, headers=headers)
                except Exception as exc:
                    log.debug("openclaw list request failed %s: %s", path, exc)
                    continue
                if res.status_code >= 400:
                    continue
                payload: Any = None
                try:
                    payload = res.json()
                except Exception:
                    continue
                items = self._extract_items(payload)
                parsed = self._parse_items(items)
                if parsed:
                    return parsed
        return []

    def _extract_items(self, payload: Any) -> List[Any]:
        if isinstance(payload, list):
            return payload
        if isinstance(payload, dict):
            for key in ("agents", "models", "nodes", "data", "items"):
                value = payload.get(key)
                if isinstance(value, list):
                    return value
        return []

    def _parse_items(self, items: List[Any]) -> List[RuntimeAgent]:
        out: List[RuntimeAgent] = []
        seen = set()
        for item in items:
            runtime_agent_id = ""
            agent_name = ""
            status = "online"
            card_json: Dict[str, Any] = {}

            if isinstance(item, str):
                runtime_agent_id = item.strip()
                agent_name = runtime_agent_id
            elif isinstance(item, dict):
                runtime_agent_id = str(
                    item.get("id")
                    or item.get("agent_id")
                    or item.get("agentId")
                    or item.get("model")
                    or item.get("name")
                    or ""
                ).strip()
                agent_name = str(
                    item.get("name")
                    or item.get("agent_name")
                    or item.get("agentName")
                    or runtime_agent_id
                    or ""
                ).strip()
                status = str(item.get("status") or "online").strip().lower() or "online"
                raw_card = item.get("agent_card_json") or item.get("agent_card") or item.get("card")
                if isinstance(raw_card, dict):
                    card_json = dict(raw_card)
            if not runtime_agent_id:
                continue
            if runtime_agent_id in seen:
                continue
            seen.add(runtime_agent_id)
            if not agent_name:
                agent_name = runtime_agent_id
            if not card_json:
                card_json = self._default_agent_card(runtime_agent_id=runtime_agent_id, agent_name=agent_name)
            out.append(
                RuntimeAgent(
                    runtime_agent_id=runtime_agent_id,
                    agent_name=agent_name,
                    status=status,
                    agent_card_json=card_json,
                )
            )
        return out

    def _default_agent_card(self, *, runtime_agent_id: str, agent_name: str) -> Dict[str, Any]:
        return {
            "schema": "hivee.agent_card.v1",
            "runtime": "openclaw",
            "runtime_agent_id": runtime_agent_id,
            "name": agent_name,
            "capabilities": ["chat"],
        }

    def _extract_chat_text(self, payload: Any) -> str:
        if not isinstance(payload, dict):
            return ""

        output_text = payload.get("output_text")
        if isinstance(output_text, str) and output_text.strip():
            return output_text.strip()

        choices = payload.get("choices")
        if isinstance(choices, list) and choices:
            first = choices[0] if isinstance(choices[0], dict) else {}
            msg = first.get("message") if isinstance(first, dict) else None
            if isinstance(msg, dict):
                content = msg.get("content")
                if isinstance(content, str) and content.strip():
                    return content.strip()
                if isinstance(content, list):
                    parts: List[str] = []
                    for item in content:
                        if isinstance(item, dict):
                            part = str(item.get("text") or item.get("content") or "").strip()
                            if part:
                                parts.append(part)
                    if parts:
                        return "\n".join(parts).strip()
            text_value = first.get("text") if isinstance(first, dict) else None
            if isinstance(text_value, str) and text_value.strip():
                return text_value.strip()

        output = payload.get("output")
        if isinstance(output, list):
            parts: List[str] = []
            for item in output:
                if isinstance(item, dict):
                    content = item.get("content")
                    if isinstance(content, list):
                        for c in content:
                            if isinstance(c, dict):
                                text_value = str(c.get("text") or c.get("content") or "").strip()
                                if text_value:
                                    parts.append(text_value)
            if parts:
                return "\n".join(parts).strip()

        message = payload.get("message")
        if isinstance(message, str) and message.strip():
            return message.strip()

        text_value = payload.get("text")
        if isinstance(text_value, str) and text_value.strip():
            return text_value.strip()

        return ""