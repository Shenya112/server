"""
PC Control Panel — Server
Запуск: uvicorn server:app --host 0.0.0.0 --port 8000
Деплой: Railway / Render (бесплатно)
"""

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.middleware.cors import CORSMiddleware
import json
import asyncio
import os
from typing import List

app = FastAPI(title="PC Control Panel")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


class Manager:
    def __init__(self):
        self.dashboards: List[WebSocket] = []
        self.pc_clients: List[WebSocket] = []

    async def connect_dashboard(self, ws: WebSocket):
        await ws.accept()
        self.dashboards.append(ws)
        await ws.send_text(json.dumps({
            "type": "status",
            "pc_connected": len(self.pc_clients) > 0,
            "pc_count": len(self.pc_clients)
        }))

    async def connect_pc(self, ws: WebSocket):
        await ws.accept()
        self.pc_clients.append(ws)
        await self._broadcast_dashboards({
            "type": "status",
            "pc_connected": True,
            "pc_count": len(self.pc_clients),
            "message": "✅ PC подключился"
        })

    def disconnect_dashboard(self, ws: WebSocket):
        if ws in self.dashboards:
            self.dashboards.remove(ws)

    def disconnect_pc(self, ws: WebSocket):
        if ws in self.pc_clients:
            self.pc_clients.remove(ws)

    async def _broadcast_dashboards(self, data: dict):
        dead = []
        for ws in self.dashboards:
            try:
                await ws.send_text(json.dumps(data))
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.dashboards.remove(ws)

    async def send_to_pc(self, data: dict) -> bool:
        if not self.pc_clients:
            return False
        dead = []
        for ws in self.pc_clients:
            try:
                await ws.send_text(json.dumps(data))
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.pc_clients.remove(ws)
        return True

    @property
    def pc_connected(self) -> bool:
        return len(self.pc_clients) > 0


manager = Manager()


@app.get("/")
async def serve_dashboard():
    if os.path.exists("dashboard.html"):
        return FileResponse("dashboard.html")
    return HTMLResponse("<h1>dashboard.html not found</h1>", status_code=404)


@app.websocket("/ws/dashboard")
async def dashboard_ws(ws: WebSocket):
    await manager.connect_dashboard(ws)
    try:
        while True:
            raw = await ws.receive_text()
            msg = json.loads(raw)

            if not manager.pc_connected:
                await ws.send_text(json.dumps({
                    "type": "error",
                    "message": "❌ PC не подключён"
                }))
                continue

            sent = await manager.send_to_pc(msg)
            if not sent:
                await ws.send_text(json.dumps({
                    "type": "error",
                    "message": "❌ Не удалось отправить команду"
                }))
    except WebSocketDisconnect:
        manager.disconnect_dashboard(ws)


@app.websocket("/ws/client")
async def client_ws(ws: WebSocket):
    await manager.connect_pc(ws)
    try:
        while True:
            raw = await ws.receive_text()
            msg = json.loads(raw)
            await manager._broadcast_dashboards(msg)
    except WebSocketDisconnect:
        manager.disconnect_pc(ws)
        await manager._broadcast_dashboards({
            "type": "status",
            "pc_connected": len(manager.pc_clients) > 0,
            "pc_count": len(manager.pc_clients),
            "message": "⚠️ PC отключился"
        })


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "dashboards": len(manager.dashboards),
        "pc_clients": len(manager.pc_clients)
    }
