#!/usr/bin/env python3
"""Promised Land WebSocket relay server + HTTP file server."""

import asyncio
import json
import os

import websockets
from websockets.http11 import Response
from websockets.datastructures import Headers

PORT = int(os.environ.get("PORT", 3000))
HTML_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "promised-land.html")

# Room storage: room_code -> { "host": ws, "guests": { socket_id: ws } }
rooms = {}
next_id = 0


def new_socket_id():
    global next_id
    next_id += 1
    return f"sock_{next_id}"


BASE_DIR = os.path.dirname(os.path.abspath(__file__))

STATIC_FILES = {
    "/": ("promised-land.html", "text/html; charset=utf-8"),
    "/index.html": ("promised-land.html", "text/html; charset=utf-8"),
    "/images.js": ("images.js", "application/javascript; charset=utf-8"),
}


async def process_request(ws, request):
    """Intercept HTTP requests to serve static files.

    Skip if the request is a WebSocket upgrade (has Upgrade header).
    """
    # Let WebSocket upgrade requests pass through
    if request.headers.get("Upgrade", "").lower() == "websocket":
        return None

    entry = STATIC_FILES.get(request.path)
    if entry:
        filename, content_type = entry
        filepath = os.path.join(BASE_DIR, filename)
        try:
            with open(filepath, "rb") as f:
                body = f.read()
            return Response(
                200, "OK",
                Headers([("Content-Type", content_type)]),
                body
            )
        except FileNotFoundError:
            return Response(404, "Not Found", Headers(), b"File not found")
    # Return None to let WebSocket handshake proceed
    return None


async def send_json(ws, data):
    """Send JSON to a websocket, ignoring closed connections."""
    try:
        await ws.send(json.dumps(data))
    except websockets.exceptions.ConnectionClosed:
        pass


async def handler(ws):
    socket_id = new_socket_id()
    room_code = None
    is_host = False

    try:
        async for raw in ws:
            try:
                data = json.loads(raw)
            except json.JSONDecodeError:
                continue

            msg_type = data.get("type")

            if msg_type == "createRoom":
                code = data.get("roomCode", "")
                if code in rooms:
                    await send_json(ws, {"type": "error", "message": "Room code already exists"})
                    continue
                rooms[code] = {"host": ws, "guests": {}}
                room_code = code
                is_host = True
                await send_json(ws, {"type": "roomCreated"})

            elif msg_type == "joinRoom":
                code = data.get("roomCode", "")
                room = rooms.get(code)
                if not room or not room["host"].open:
                    await send_json(ws, {"type": "error", "message": "Room not found"})
                    continue
                room_code = code
                is_host = False
                room["guests"][socket_id] = ws
                # Forward join to host with guest's socket ID
                await send_json(room["host"], {
                    "type": "join",
                    "name": data.get("name", "Player"),
                    "emoji": data.get("emoji", "?"),
                    "socketId": socket_id
                })
                await send_json(ws, {"type": "joined"})

            else:
                # Generic message routing
                room = rooms.get(room_code) if room_code else None
                if not room:
                    continue

                if is_host:
                    # Host -> guests
                    target_id = data.pop("_targetSocketId", None)
                    exclude_id = data.pop("_excludeSocketId", None)

                    if target_id:
                        # Directed message to one guest
                        target = room["guests"].get(target_id)
                        if target and target.open:
                            await send_json(target, data)
                    elif exclude_id:
                        # Broadcast to all except one
                        for gid, g in list(room["guests"].items()):
                            if gid != exclude_id and g.open:
                                await send_json(g, data)
                    else:
                        # Broadcast to all guests
                        for g in list(room["guests"].values()):
                            if g.open:
                                await send_json(g, data)
                else:
                    # Guest -> host
                    data["_senderSocketId"] = socket_id
                    if room["host"].open:
                        await send_json(room["host"], data)

    except websockets.exceptions.ConnectionClosed:
        pass
    finally:
        # Cleanup on disconnect
        if room_code and room_code in rooms:
            room = rooms[room_code]
            if is_host:
                # Host left - notify guests, remove room
                for g in list(room["guests"].values()):
                    await send_json(g, {"type": "hostDisconnected"})
                del rooms[room_code]
            else:
                room["guests"].pop(socket_id, None)
                if room["host"].open:
                    await send_json(room["host"], {
                        "type": "guestDisconnected",
                        "socketId": socket_id
                    })


async def main():
    async with websockets.serve(
        handler,
        "0.0.0.0",
        PORT,
        process_request=process_request,
        max_size=2**20,  # 1MB max message
    ):
        print(f"Promised Land running at http://localhost:{PORT}")
        print(f"Share your local IP address with friends on the same network,")
        print(f"or deploy to a hosting service for internet play.")
        await asyncio.Future()  # run forever


if __name__ == "__main__":
    asyncio.run(main())
