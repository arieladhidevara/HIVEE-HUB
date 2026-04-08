from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Protocol


@dataclass
class RuntimeAgent:
    runtime_agent_id: str
    agent_name: str
    status: str = "online"
    agent_card_json: Dict[str, Any] = field(default_factory=dict)


@dataclass
class RuntimeChatResult:
    ok: bool
    text: str = ""
    error: str = ""
    metadata: Dict[str, Any] = field(default_factory=dict)


class RuntimeAdapter(Protocol):
    def discover_agents(self) -> List[RuntimeAgent]:
        ...

    def send_chat(self, *, runtime_agent_id: str, message: str, session_key: str, timeout_sec: int = 45) -> RuntimeChatResult:
        ...