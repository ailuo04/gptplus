#!/usr/bin/env python3
"""Raw TCP listener that logs the first bytes of any connection (WebSocket upgrade probe)."""
import socket
import os
import time

PORT = int(os.environ.get("WS_PORT", "10199"))
LOG = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ws-probe.log")

srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
srv.bind(("127.0.0.1", PORT))
srv.listen(8)
print(f"ws probe listening on 127.0.0.1:{PORT}", flush=True)
srv.settimeout(90)
with open(LOG, "a", encoding="utf-8") as fh:
    fh.write(f"--- probe start {time.time()} ---\n")
    while True:
        try:
            conn, addr = srv.accept()
        except socket.timeout:
            fh.write("--- accept timeout, exiting ---\n")
            break
        conn.settimeout(3)
        try:
            data = conn.recv(8192)
        except socket.timeout:
            data = b"<timeout>"
        fh.write(f"=== connection from {addr} at {time.time()} ===\n")
        fh.write(repr(data) + "\n")
        try:
            conn.sendall(b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n")
        except Exception:
            pass
        conn.close()
        fh.flush()
