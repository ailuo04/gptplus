#!/usr/bin/env python3
"""Local capture gateway for Codex `wire_api = "responses"` reverse engineering.

Logs every request (method, path, headers, raw body) to capture.jsonl and
serves a configurable Responses-API SSE stream.

Scenarios (GW_SCENARIO):
  full        - reasoning summary + content parts + text + completed
  minimal     - ONLY response.output_item.done(message) + response.completed
  bare        - ONLY response.completed (no output items)
  toolcall    - turn 1 => shell function_call, turn 2 => text
  empty       - response.completed with empty output
  nonstream   - respond with a single JSON object (not SSE)
"""
import json
import os
import time
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
LOG = os.path.join(HERE, "capture.jsonl")
SCENARIO = os.environ.get("GW_SCENARIO", "full")
PORT = int(os.environ.get("GW_PORT", "10199"))
REQUIRE_AUTH = os.environ.get("GW_REQUIRE_AUTH", "")
LOG_LOCK = threading.Lock()


def log(rec):
    with LOG_LOCK:
        with open(LOG, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(rec, ensure_ascii=False) + "\n")


def base_response(model, status="in_progress"):
    return {
        "id": "resp_capture_0001",
        "object": "response",
        "created_at": int(time.time()),
        "status": status,
        "model": model,
        "output": [],
        "parallel_tool_calls": True,
        "tool_choice": "auto",
        "tools": [],
    }


def text_events(model, text="Hello from the capture gateway.", with_parts=True):
    rid, mid = "resp_capture_0001", "msg_capture_0001"
    br = base_response(model)
    ev = [("response.created", {"type": "response.created", "sequence_number": 0,
                                "response": br})]
    item = {"type": "message", "id": mid, "role": "assistant",
            "status": "in_progress", "content": []}
    ev.append(("response.output_item.added",
               {"type": "response.output_item.added", "sequence_number": 1,
                "output_index": 0, "item": item}))
    if with_parts:
        ev.append(("response.content_part.added",
                   {"type": "response.content_part.added", "sequence_number": 2,
                    "item_id": mid, "output_index": 0, "content_index": 0,
                    "part": {"type": "output_text", "text": "", "annotations": []}}))
    seq = 10
    for i in range(0, len(text), 8):
        ev.append(("response.output_text.delta",
                   {"type": "response.output_text.delta", "sequence_number": seq,
                    "item_id": mid, "output_index": 0, "content_index": 0,
                    "delta": text[i:i + 8]}))
        seq += 1
    if with_parts:
        ev.append(("response.output_text.done",
                   {"type": "response.output_text.done", "sequence_number": seq,
                    "item_id": mid, "output_index": 0, "content_index": 0, "text": text}))
        ev.append(("response.content_part.done",
                   {"type": "response.content_part.done", "sequence_number": seq + 1,
                    "item_id": mid, "output_index": 0, "content_index": 0,
                    "part": {"type": "output_text", "text": text, "annotations": []}}))
    done = dict(item)
    done["status"] = "completed"
    done["content"] = [{"type": "output_text", "text": text, "annotations": []}]
    ev.append(("response.output_item.done",
               {"type": "response.output_item.done", "sequence_number": seq + 2,
                "output_index": 0, "item": done}))
    fin = base_response(model, "completed")
    fin["output"] = [done]
    fin["usage"] = {"input_tokens": 12, "output_tokens": 8, "total_tokens": 20,
                    "input_tokens_details": {"cached_tokens": 0},
                    "output_tokens_details": {"reasoning_tokens": 0}}
    ev.append(("response.completed", {"type": "response.completed",
                                      "sequence_number": seq + 3, "response": fin}))
    return ev


def tool_events(model, command='["echo","hello-from-tool"]'):
    rid = "resp_capture_0002"
    br = base_response(model)
    ev = [("response.created", {"type": "response.created", "sequence_number": 0,
                                "response": br})]
    item = {"type": "function_call", "id": "fc_capture_1", "call_id": "call_capture_1",
            "name": "exec_command", "arguments": "", "status": "in_progress"}
    ev.append(("response.output_item.added",
               {"type": "response.output_item.added", "sequence_number": 1,
                "output_index": 0, "item": item}))
    args = json.dumps({"cmd": "echo hello-from-tool"})
    seq = 2
    for ch in args:
        ev.append(("response.function_call_arguments.delta",
                   {"type": "response.function_call_arguments.delta",
                    "sequence_number": seq, "item_id": "fc_capture_1",
                    "output_index": 0, "delta": ch}))
        seq += 1
    ev.append(("response.function_call_arguments.done",
               {"type": "response.function_call_arguments.done", "sequence_number": seq,
                "item_id": "fc_capture_1", "output_index": 0, "arguments": args}))
    done = dict(item)
    done["arguments"] = args
    done["status"] = "completed"
    ev.append(("response.output_item.done",
               {"type": "response.output_item.done", "sequence_number": seq + 1,
                "output_index": 0, "item": done}))
    fin = base_response(model, "completed")
    fin["output"] = [done]
    fin["usage"] = {"input_tokens": 10, "output_tokens": 5, "total_tokens": 15,
                    "input_tokens_details": {"cached_tokens": 0},
                    "output_tokens_details": {"reasoning_tokens": 0}}
    ev.append(("response.completed", {"type": "response.completed",
                                      "sequence_number": seq + 2, "response": fin}))
    return ev


def minimal_events(model):
    """ONLY output_item.done + completed."""
    mid = "msg_capture_min"
    done = {"type": "message", "id": mid, "role": "assistant", "status": "completed",
            "content": [{"type": "output_text", "text": "minimal path works",
                         "annotations": []}]}
    fin = base_response(model, "completed")
    fin["output"] = [done]
    fin["usage"] = {"input_tokens": 1, "output_tokens": 3, "total_tokens": 4,
                    "input_tokens_details": {"cached_tokens": 0},
                    "output_tokens_details": {"reasoning_tokens": 0}}
    return [("response.output_item.done",
             {"type": "response.output_item.done", "sequence_number": 0,
              "output_index": 0, "item": done}),
            ("response.completed", {"type": "response.completed",
                                    "sequence_number": 1, "response": fin})]


def bare_events(model):
    fin = base_response(model, "completed")
    fin["output"] = []
    fin["usage"] = {"input_tokens": 1, "output_tokens": 0, "total_tokens": 1,
                    "input_tokens_details": {"cached_tokens": 0},
                    "output_tokens_details": {"reasoning_tokens": 0}}
    return [("response.completed", {"type": "response.completed",
                                    "sequence_number": 0, "response": fin})]


def reasoning_events(model, text="analysis complete"):
    """Emit a reasoning item carrying a summary + encrypted_content."""
    rid, rsid = "resp_capture_rs", "rs_capture_1"
    br = base_response(model)
    ev = [("response.created", {"type": "response.created", "sequence_number": 0,
                                "response": br})]
    item = {"type": "reasoning", "id": rsid, "summary": []}
    ev.append(("response.output_item.added",
               {"type": "response.output_item.added", "sequence_number": 1,
                "output_index": 0, "item": item}))
    ev.append(("response.reasoning_summary_part.added",
               {"type": "response.reasoning_summary_part.added", "sequence_number": 2,
                "item_id": rsid, "output_index": 0, "summary_index": 0,
                "part": {"type": "summary_text", "text": ""}}))
    ev.append(("response.reasoning_summary_text.delta",
               {"type": "response.reasoning_summary_text.delta", "sequence_number": 3,
                "item_id": rsid, "output_index": 0, "summary_index": 0, "delta": text}))
    ev.append(("response.reasoning_summary_text.done",
               {"type": "response.reasoning_summary_text.done", "sequence_number": 4,
                "item_id": rsid, "output_index": 0, "summary_index": 0, "text": text}))
    done_rs = {"type": "reasoning", "id": rsid,
               "summary": [{"type": "summary_text", "text": text}],
               "encrypted_content": "ENCRYPTED_BLOB_FROM_GATEWAY"}
    ev.append(("response.output_item.done",
               {"type": "response.output_item.done", "sequence_number": 5,
                "output_index": 0, "item": done_rs}))
    mid = "msg_capture_rs"
    done_msg = {"type": "message", "id": mid, "role": "assistant", "status": "completed",
                "content": [{"type": "output_text", "text": "reasoning path works",
                             "annotations": []}]}
    ev.append(("response.output_item.done",
               {"type": "response.output_item.done", "sequence_number": 6,
                "output_index": 1, "item": done_msg}))
    fin = base_response(model, "completed")
    fin["output"] = [done_rs, done_msg]
    fin["usage"] = {"input_tokens": 20, "output_tokens": 9, "total_tokens": 29,
                    "input_tokens_details": {"cached_tokens": 0},
                    "output_tokens_details": {"reasoning_tokens": 5}}
    ev.append(("response.completed", {"type": "response.completed", "sequence_number": 7,
                                      "response": fin}))
    return ev


def custom_tool_events(model):
    """Emit a custom (freeform) tool call: apply_patch."""
    br = base_response(model)
    ev = [("response.created", {"type": "response.created", "sequence_number": 0,
                                "response": br})]
    cid = "ctc_capture_1"
    item = {"type": "custom_tool_call", "id": cid, "call_id": "call_custom_1",
            "name": "apply_patch", "input": ""}
    ev.append(("response.output_item.added",
               {"type": "response.output_item.added", "sequence_number": 1,
                "output_index": 0, "item": item}))
    patch = ("*** Begin Patch\n*** Add File: gateway-note.txt\n+hello from gateway\n"
             "*** End Patch\n")
    ev.append(("response.custom_tool_call_input.delta",
               {"type": "response.custom_tool_call_input.delta", "sequence_number": 2,
                "item_id": cid, "output_index": 0, "delta": patch}))
    ev.append(("response.custom_tool_call_input.done",
               {"type": "response.custom_tool_call_input.done", "sequence_number": 3,
                "item_id": cid, "output_index": 0, "input": patch}))
    done = dict(item)
    done["input"] = patch
    ev.append(("response.output_item.done",
               {"type": "response.output_item.done", "sequence_number": 4,
                "output_index": 0, "item": done}))
    fin = base_response(model, "completed")
    fin["output"] = [done]
    fin["usage"] = {"input_tokens": 10, "output_tokens": 20, "total_tokens": 30,
                    "input_tokens_details": {"cached_tokens": 0},
                    "output_tokens_details": {"reasoning_tokens": 0}}
    ev.append(("response.completed", {"type": "response.completed", "sequence_number": 5,
                                      "response": fin}))
    return ev


def deltas_only_events(model, text="DELTA-CHANNEL-ONLY"):
    """Stream deltas, but the terminal message item carries EMPTY content."""
    mid = "msg_deltas"
    br = base_response(model)
    ev = [("response.created", {"type": "response.created", "sequence_number": 0,
                                "response": br})]
    ev.append(("response.output_item.added",
               {"type": "response.output_item.added", "sequence_number": 1,
                "output_index": 0,
                "item": {"type": "message", "id": mid, "role": "assistant",
                         "status": "in_progress", "content": []}}))
    ev.append(("response.content_part.added",
               {"type": "response.content_part.added", "sequence_number": 2,
                "item_id": mid, "output_index": 0, "content_index": 0,
                "part": {"type": "output_text", "text": "", "annotations": []}}))
    seq = 3
    for i in range(0, len(text), 6):
        ev.append(("response.output_text.delta",
                   {"type": "response.output_text.delta", "sequence_number": seq,
                    "item_id": mid, "output_index": 0, "content_index": 0,
                    "delta": text[i:i + 6]}))
        seq += 1
    ev.append(("response.output_text.done",
               {"type": "response.output_text.done", "sequence_number": seq,
                "item_id": mid, "output_index": 0, "content_index": 0, "text": text}))
    ev.append(("response.content_part.done",
               {"type": "response.content_part.done", "sequence_number": seq + 1,
                "item_id": mid, "output_index": 0, "content_index": 0,
                "part": {"type": "output_text", "text": text, "annotations": []}}))
    empty_item = {"type": "message", "id": mid, "role": "assistant",
                  "status": "completed", "content": []}
    ev.append(("response.output_item.done",
               {"type": "response.output_item.done", "sequence_number": seq + 2,
                "output_index": 0, "item": empty_item}))
    fin = base_response(model, "completed")
    fin["output"] = [empty_item]
    fin["usage"] = {"input_tokens": 5, "output_tokens": 6, "total_tokens": 11,
                    "input_tokens_details": {"cached_tokens": 0},
                    "output_tokens_details": {"reasoning_tokens": 0}}
    ev.append(("response.completed", {"type": "response.completed",
                                      "sequence_number": seq + 3, "response": fin}))
    return ev


def choose(req, scenario):
    model = req.get("model") or "unknown"
    inp = req.get("input") or []
    if scenario == "deltas":
        return deltas_only_events(model)
    if scenario == "reasoning":
        return reasoning_events(model)
    if scenario == "customtool":
        has_out = any(isinstance(i, dict) and i.get("type") == "custom_tool_call_output"
                      for i in inp)
        if has_out:
            return [("response.output_item.done",
                     {"type": "response.output_item.done", "sequence_number": 0,
                      "output_index": 0, "item": {
                          "type": "message", "id": "m_done", "role": "assistant",
                          "status": "completed",
                          "content": [{"type": "output_text", "text": "patch path done",
                                       "annotations": []}]}}),
                    ("response.completed",
                     {"type": "response.completed", "sequence_number": 1,
                      "response": dict(base_response(model, "completed"), output=[])})]
        return custom_tool_events(model)
    if scenario == "sse_error":
        return [("error", {"type": "error", "code": "server_error",
                           "message": "synthetic failure", "param": None,
                           "sequence_number": 0})]
    if scenario == "sse_failed":
        fin = base_response(model, "failed")
        fin["error"] = {"code": "server_error", "message": "synthetic failure"}
        return [("response.failed", {"type": "response.failed", "sequence_number": 0,
                                     "response": fin})]
    if scenario == "sse_incomplete":
        fin = base_response(model, "incomplete")
        fin["incomplete_details"] = {"reason": "max_output_tokens"}
        return [("response.incomplete", {"type": "response.incomplete",
                                         "sequence_number": 0, "response": fin})]
    if scenario in ("minimal", "noevent", "typemismatch", "notype"):
        return minimal_events(model)
    if scenario == "bare":
        return bare_events(model)
    if scenario == "toolcall":
        has_out = any(isinstance(i, dict) and i.get("type") == "function_call_output"
                      for i in inp)
        return text_events(model, "Done: tool executed.", with_parts=False) if has_out \
            else tool_events(model)
    return text_events(model)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _read_body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(n) if n else b""

    def _record(self, body):
        hdrs = {}
        for k, v in self.headers.items():
            hdrs.setdefault(k, []).append(v)
        log({"ts": time.time(), "method": self.command, "path": self.path,
             "headers": hdrs, "body_raw": body.decode("utf-8", "replace")})

    @property
    def route(self):
        return self.path.split("?", 1)[0].rstrip("/")

    def _maybe_401(self):
        if REQUIRE_AUTH and self.headers.get("Authorization") != f"Bearer {REQUIRE_AUTH}":
            self.send_response(401)
            body = b'{"error":{"message":"missing bearer","type":"invalid_request_error","code":"invalid_api_key"}}'
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return True
        return False

    def do_GET(self):
        self._record(self._read_body())
        if self._maybe_401():
            return
        if self.route.endswith("/models"):
            payload = json.dumps({"object": "list", "data": [
                {"id": "capture-model", "object": "model", "created": int(time.time()),
                 "owned_by": "local"}]}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return
        self.send_response(404)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_DELETE(self):
        body = self._read_body()
        self._record(body)
        self.send_response(200)
        payload = b'{"id":"resp_capture_0001","object":"response","status":"cancelled"}'
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_POST(self):
        body = self._read_body()
        self._record(body)
        if self._maybe_401():
            return
        if not self.route.endswith("/responses"):
            self.send_response(404)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        try:
            req = json.loads(body or b"{}")
        except Exception:
            req = {}
        forced = os.environ.get("GW_STATUS", "")
        if forced:
            code = int(forced)
            payload = json.dumps({
                "error": {"message": f"forced {code}", "type": "server_error",
                          "code": "forced_code"}}).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            if code == 429:
                self.send_header("Retry-After", "3")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            try:
                self.wfile.write(payload)
            except (BrokenPipeError, ConnectionResetError):
                pass
            return
        if SCENARIO == "nonstream":
            payload = json.dumps(base_response(req.get("model", "m"), "completed")).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return
        evs = choose(req, SCENARIO)
        if SCENARIO == "httpstatus":
            err = json.dumps({"error": {"message": "boom", "type": "server_error"}}).encode()
            self.send_response(500)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(err)))
            self.end_headers()
            self.wfile.write(err)
            return
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.send_header("Transfer-Encoding", "chunked")
        self.end_headers()
        no_event_line = SCENARIO in ("noevent", "typemismatch", "notype")
        try:
            for name, obj in evs:
                if SCENARIO == "typemismatch":
                    obj = dict(obj)
                    obj["type"] = "response.bogus.type"
                if SCENARIO == "notype":
                    obj = {k: v for k, v in obj.items() if k != "type"}
                if no_event_line:
                    chunk = f"data: {json.dumps(obj)}\n\n".encode()
                else:
                    chunk = f"event: {name}\ndata: {json.dumps(obj)}\n\n".encode()
                self.wfile.write(f"{len(chunk):X}\r\n".encode() + chunk + b"\r\n")
                self.wfile.flush()
            self.wfile.write(b"0\r\n\r\n")
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    if os.path.exists(LOG) and os.environ.get("GW_KEEP_LOG") != "1":
        os.remove(LOG)
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"capture gateway on http://127.0.0.1:{PORT} scenario={SCENARIO} "
          f"require_auth={REQUIRE_AUTH or 'no'}", flush=True)
    srv.serve_forever()


