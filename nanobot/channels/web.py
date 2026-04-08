"""Web UI channel — browser-based chat via WebSocket.

Starts an aiohttp server that serves a static chat frontend and communicates
with clients over WebSocket.  No Node.js required — pure Python backend with
vanilla HTML/CSS/JS on the frontend.
"""

from __future__ import annotations

import asyncio
import json
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from aiohttp import WSMsgType, web
from loguru import logger
from pydantic import Field as PydanticField

from nanobot.bus.events import OutboundMessage
from nanobot.bus.queue import MessageBus
from nanobot.channels.base import BaseChannel
from nanobot.config.schema import Base

# ---------------------------------------------------------------------------
# Static assets directory (shipped alongside this module)
# ---------------------------------------------------------------------------
_STATIC_DIR = Path(__file__).resolve().parent / "web_static"


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

class WebConfig(Base):
    """Web channel configuration."""

    enabled: bool = False
    host: str = "0.0.0.0"
    port: int = 8080
    allow_from: list[str] = PydanticField(default_factory=lambda: ["*"])
    streaming: bool = True


# ---------------------------------------------------------------------------
# Per-client streaming accumulator
# ---------------------------------------------------------------------------

@dataclass
class _StreamBuf:
    text: str = ""
    stream_id: str | None = None


# ---------------------------------------------------------------------------
# Channel
# ---------------------------------------------------------------------------

class WebChannel(BaseChannel):
    """Browser-based chat channel served over HTTP + WebSocket."""

    name = "web"
    display_name = "Web"

    @classmethod
    def default_config(cls) -> dict[str, Any]:
        return WebConfig().model_dump(by_alias=True)

    def __init__(self, config: Any, bus: MessageBus):
        if isinstance(config, dict):
            config = WebConfig.model_validate(config)
        super().__init__(config, bus)
        self.config: WebConfig = config

        # WebSocket connections keyed by chat_id
        self._clients: dict[str, web.WebSocketResponse] = {}
        # Streaming buffers keyed by chat_id
        self._stream_bufs: dict[str, _StreamBuf] = {}

        self._app: web.Application | None = None
        self._runner: web.AppRunner | None = None

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    async def start(self) -> None:
        self._running = True
        self._app = web.Application()
        self._app.router.add_get("/ws", self._ws_handler)
        # Serve static frontend
        if _STATIC_DIR.is_dir():
            self._app.router.add_get("/", self._index_handler)
            self._app.router.add_static("/static", _STATIC_DIR, show_index=False)

        self._runner = web.AppRunner(self._app)
        await self._runner.setup()
        site = web.TCPSite(self._runner, self.config.host, self.config.port)
        await site.start()
        logger.info("Web UI listening on http://{}:{}", self.config.host, self.config.port)

        # Keep the channel alive until stopped
        try:
            while self._running:
                await asyncio.sleep(1)
        except asyncio.CancelledError:
            pass

    async def stop(self) -> None:
        self._running = False
        # Close all WebSocket connections
        for ws in list(self._clients.values()):
            await ws.close()
        self._clients.clear()
        if self._runner:
            await self._runner.cleanup()
        logger.info("Web UI stopped")

    # ------------------------------------------------------------------
    # HTTP handlers
    # ------------------------------------------------------------------

    async def _index_handler(self, request: web.Request) -> web.FileResponse:
        return web.FileResponse(_STATIC_DIR / "index.html")

    async def _ws_handler(self, request: web.Request) -> web.WebSocketResponse:
        ws = web.WebSocketResponse()
        await ws.prepare(request)

        # Assign a client id — reuse if provided, else generate
        client_id: str | None = request.query.get("client_id")
        if not client_id:
            client_id = uuid.uuid4().hex[:12]

        chat_id = client_id  # 1:1 mapping for simplicity
        sender_id = client_id

        # Register connection (replaces any stale one for same client)
        old = self._clients.get(chat_id)
        if old and not old.closed:
            await old.close()
        self._clients[chat_id] = ws

        # Confirm connection
        await ws.send_json({"type": "connected", "client_id": client_id})
        logger.info("Web client connected: {}", client_id)

        try:
            async for raw in ws:
                if raw.type == WSMsgType.TEXT:
                    try:
                        data = json.loads(raw.data)
                    except json.JSONDecodeError:
                        await ws.send_json({"type": "error", "error": "Invalid JSON"})
                        continue

                    msg_type = data.get("type", "message")
                    if msg_type == "message":
                        content = data.get("content", "").strip()
                        if not content:
                            continue
                        await self._handle_message(
                            sender_id=sender_id,
                            chat_id=chat_id,
                            content=content,
                            media=data.get("media", []),
                            metadata={},
                        )
                    elif msg_type == "ping":
                        await ws.send_json({"type": "pong"})
                elif raw.type in (WSMsgType.ERROR, WSMsgType.CLOSE):
                    break
        except asyncio.CancelledError:
            pass
        finally:
            self._clients.pop(chat_id, None)
            self._stream_bufs.pop(chat_id, None)
            logger.info("Web client disconnected: {}", client_id)

        return ws

    # ------------------------------------------------------------------
    # Outbound: send full message
    # ------------------------------------------------------------------

    async def send(self, msg: OutboundMessage) -> None:
        ws = self._clients.get(msg.chat_id)
        if not ws or ws.closed:
            logger.debug("Web: no active connection for chat_id={}", msg.chat_id)
            return
        await ws.send_json({
            "type": "message",
            "content": msg.content,
            "media": msg.media,
        })

    # ------------------------------------------------------------------
    # Outbound: streaming deltas
    # ------------------------------------------------------------------

    async def send_delta(self, chat_id: str, delta: str, metadata: dict[str, Any] | None = None) -> None:
        ws = self._clients.get(chat_id)
        if not ws or ws.closed:
            return

        meta = metadata or {}
        stream_id = meta.get("_stream_id")

        if meta.get("_stream_end"):
            buf = self._stream_bufs.pop(chat_id, None)
            if buf and buf.text:
                await ws.send_json({
                    "type": "stream_end",
                    "content": buf.text + delta,
                })
            return

        buf = self._stream_bufs.get(chat_id)
        if buf is None or (stream_id is not None and buf.stream_id is not None and buf.stream_id != stream_id):
            buf = _StreamBuf(stream_id=stream_id)
            self._stream_bufs[chat_id] = buf
        elif buf.stream_id is None:
            buf.stream_id = stream_id

        buf.text += delta
        await ws.send_json({
            "type": "stream_delta",
            "delta": delta,
        })

    @property
    def supports_streaming(self) -> bool:
        return super().supports_streaming
