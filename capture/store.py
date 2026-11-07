"""取得した育成データの共有状態。"""

from __future__ import annotations

import threading
from datetime import datetime
from typing import Any


class StateStore:
    """最後に取得した育成データをスレッドセーフに保持する。"""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._version = 0
        self._state: dict[str, Any] | None = None
        self._last_error: dict[str, Any] | None = None
        self._last_notification: dict[str, Any] | None = None

    def restore(self, state: dict[str, Any]) -> None:
        """サーバー再起動時に、保存しておいた状態を復元する。"""
        with self._lock:
            restored = dict(state)
            version = restored.get("version")
            self._version = version if isinstance(version, int) else 0
            self._state = restored

    def update(self, state: dict[str, Any]) -> int:
        with self._lock:
            self._version += 1
            state = dict(state)
            state["version"] = self._version
            state["updated_at"] = datetime.now().astimezone().isoformat(timespec="seconds")
            self._state = state
            self._last_error = None
            return self._version

    def note_error(self, error: str, *, endpoint: str = "") -> None:
        with self._lock:
            self._last_error = {
                "error": error,
                "endpoint": endpoint,
                "at": datetime.now().astimezone().isoformat(timespec="seconds"),
            }

    def note_notification(
        self, *, endpoint: str, request_id: str, kind: str, body_size: int
    ) -> None:
        with self._lock:
            self._last_notification = {
                "endpoint": endpoint,
                "request_id": request_id,
                "kind": kind,
                "body_size": body_size,
                "at": datetime.now().astimezone().isoformat(timespec="seconds"),
            }

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            if self._state is None:
                return {
                    "ok": False,
                    "error": "まだゲームデータを受信していません。",
                    "version": 0,
                    "last_error": self._last_error,
                    "last_notification": self._last_notification,
                }
            result = dict(self._state)
            result["last_error"] = self._last_error
            result["last_notification"] = self._last_notification
            return result

    @property
    def version(self) -> int:
        with self._lock:
            return self._version

    @property
    def has_data(self) -> bool:
        with self._lock:
            return self._state is not None
