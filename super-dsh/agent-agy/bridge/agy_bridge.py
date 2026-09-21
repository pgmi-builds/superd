#!/usr/bin/env python3
# agy_bridge.py — JSONL-over-stdio bridge hosting the google-antigravity SDK.
#
# Contract (one JSON object per line; requests on stdin, events on stdout):
#   -> {"op":"start",  "model":str, "thinking_level"?:"minimal|low|medium|high|extra_high",
#       "api_key"?:str, "project"?:str, "location"?:str,
#       "approval_mode"?:"allow"|"ask",          # default "allow"
#       "workspaces":[str], "save_dir"?:str}
#      (localharness is NOT spawned here — materializes lazily on first prompt)
#   -> {"op":"prompt", "text":str, "conversation_id"?:str}
#      streams back:
#      <- {"event":"thinking","text":str}        # Thought delta (reasoning)
#      <- {"event":"chunk","text":str}           # Text delta
#      <- {"event":"tool","name":str}            # tool dispatched
#      <- {"event":"approval_request","id":str,"tool":str,"args":str}   # ask mode
#      <- {"event":"usage","input_tokens":int,"output_tokens":int,
#          "thinking_tokens":int,"total_tokens":int}                    # best effort
#      <- {"event":"done","conversation_id":str,"turn_ms":int}
#      <- {"event":"error","error":str,"recoverable":bool}
#   -> {"op":"approval","id":str,"allow":bool}   # host reply to approval_request
#   -> {"op":"ping"} -> {"event":"pong"}
#   -> {"op":"close"} -> exits 0
#
# Auth is transparent: pass api_key (Gemini API key) or project (+ADC) for the
# Vertex endpoint. CLI (agy) is never invoked.

import asyncio
import json
import os
import sys
import time
import uuid


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


class Bridge:
    def __init__(self):
        self.config = None
        self.started = False
        self.pending_approvals = {}  # id -> asyncio.Event
        self.approval_results = {}   # id -> bool
        self.approval_mode = "allow"

    async def handle_start(self, req):
        import google.antigravity as ga

        kwargs = {
            "model": req.get("model") or "gemini-3.5-flash",
            "workspaces": req.get("workspaces") or [os.getcwd()],
        }
        if req.get("save_dir"):
            kwargs["save_dir"] = req["save_dir"]
        if req.get("api_key"):
            kwargs["api_key"] = req["api_key"]
        if req.get("project"):
            kwargs["vertex"] = True
            kwargs["project"] = req["project"]
            if req.get("location"):
                kwargs["location"] = req["location"]
        self.approval_mode = req.get("approval_mode") or "allow"
        # ask mode requires the SDK to keep hook objects in-process; the current
        # localharness pickles parts of the config, which fails on runtime
        # references (SimpleQueue). Opt-in via AGY_BRIDGE_ASK=1 until the SDK
        # supports in-process hooks; otherwise degrade to allow with a trace.
        if self.approval_mode == "ask":
            if os.environ.get("AGY_BRIDGE_ASK") == "1":
                kwargs["hooks"] = list(kwargs.get("hooks") or []) + [PreToolApprovalBridge(self)]
            else:
                emit({"event": "error", "error": "approval_mode=ask unavailable (SDK pickles config; set AGY_BRIDGE_ASK=1 to force); degrading to allow", "recoverable": True})
                self.approval_mode = "allow"
        level = req.get("thinking_level")
        if level:
            from google.antigravity.models import (
                GeminiAPIEndpoint, GeminiModelOptions, ModelTarget, VertexEndpoint,
            )
            from google.antigravity.types import ThinkingLevel
            if kwargs.get("vertex"):
                endpoint = VertexEndpoint(project=kwargs.get("project"),
                                          location=kwargs.get("location"))
            else:
                endpoint = GeminiAPIEndpoint(api_key=kwargs.get("api_key"))
            kwargs["model"] = None
            kwargs["models"] = [ModelTarget(
                name=req["model"],
                endpoint=endpoint,
                options=GeminiModelOptions(thinking_level=ThinkingLevel(level)),
            )]
        self.config = ga.LocalAgentConfig(**kwargs)
        self.started = True
        emit({"event": "started"})

    async def handle_prompt(self, req):
        if not self.started:
            emit({"event": "error", "error": "not started", "recoverable": False})
            return
        import google.antigravity as ga

        text = req.get("text") or ""
        cid = req.get("conversation_id")
        t0 = time.time()
        agent = ga.Agent(self.config)
        try:
            await agent.__aenter__()
            resp = await agent.chat(text)
            usage = None
            # resp.__aiter__ yields only Text strings; .chunks carries the full
            # typed stream (Thought / ToolCall / ToolResult).
            async for ch in resp.chunks:
                kind = type(ch).__name__
                if isinstance(ch, str):
                    emit({"event": "chunk", "text": ch})
                elif kind == "Thought":
                    emit({"event": "thinking", "text": getattr(ch, "text", "")})
                elif kind == "Text":
                    emit({"event": "chunk", "text": getattr(ch, "text", "")})
                elif kind == "ToolCall":
                    emit({"event": "tool_call", "id": str(getattr(ch, "id", "") or ""),
                          "name": str(getattr(ch, "name", "") or "unknown"),
                          "args": json.dumps(getattr(ch, "args", ""), ensure_ascii=False, default=str)[:600]})
                elif kind == "ToolResult":
                    err = getattr(ch, "error", None)
                    emit({"event": "tool_result", "id": str(getattr(ch, "id", "") or ""),
                          "name": str(getattr(ch, "name", "") or ""),
                          "is_error": err is not None,
                          "result": str(getattr(ch, "result", ""))[:600]})
            conv = agent.conversation
            new_cid = (conv.conversation_id if conv else None) or cid or ""
            if conv is not None:
                u = getattr(conv, "last_turn_usage", None)
                if callable(u):
                    u = u()
                if u is not None:
                    d = u.model_dump() if hasattr(u, "model_dump") else {}
                    emit({"event": "usage",
                          "input_tokens": int(d.get("prompt_token_count") or 0),
                          "output_tokens": int(d.get("candidates_token_count") or 0),
                          "thinking_tokens": int(d.get("thoughts_token_count") or 0),
                          "total_tokens": int(d.get("total_token_count") or 0)})
            emit({"event": "done", "conversation_id": new_cid,
                  "turn_ms": int((time.time() - t0) * 1000)})
        except Exception as e:  # noqa: BLE001 — surface everything to the host
            emit({"event": "error", "error": f"{type(e).__name__}: {e}",
                  "recoverable": True})
        finally:
            try:
                await agent.__aexit__(None, None, None)
            except Exception:
                pass

    async def handle_approval(self, req):
        aid = req.get("id")
        if aid in self.pending_approvals:
            self.approval_results[aid] = bool(req.get("allow"))
            self.pending_approvals.pop(aid).set()

    async def wait_approval(self, aid, timeout=120.0):
        ev = asyncio.Event()
        self.pending_approvals[aid] = ev
        try:
            await asyncio.wait_for(ev.wait(), timeout)
            return self.approval_results.get(aid, False)
        except asyncio.TimeoutError:
            self.pending_approvals.pop(aid, None)
            return False

    async def main_loop(self):
        loop = asyncio.get_event_loop()

        async def read_stdin():
            # Dedicated reader: approval ops must arrive WHILE a prompt is
            # in flight (the prompt handler blocks its own coroutine).
            while True:
                line = await loop.run_in_executor(None, sys.stdin.readline)
                if not line:
                    self.host_gone = True
                    return
                line = line.strip()
                if not line:
                    continue
                try:
                    req = json.loads(line)
                except json.JSONDecodeError as e:
                    emit({"event": "error", "error": f"bad json: {e}", "recoverable": False})
                    continue
                op = req.get("op")
                if op == "approval":
                    await self.handle_approval(req)
                elif op == "ping":
                    emit({"event": "pong"})
                else:
                    await self.ops.put(req)  # close included: processed in order

        self.host_gone = False
        self.ops = asyncio.Queue()
        reader = asyncio.ensure_future(read_stdin())
        try:
            while not self.host_gone:
                req = await self.ops.get()
                op = req.get("op")
                if op == "start":
                    await self.handle_start(req)
                elif op == "prompt":
                    await self.handle_prompt(req)
                elif op == "close":
                    emit({"event": "closed"})
                    return
                else:
                    emit({"event": "error", "error": f"unknown op {op!r}", "recoverable": False})
        finally:
            reader.cancel()


def _sdk_hooks():
    from google.antigravity import hooks as hooks_mod
    return hooks_mod


try:
    _HOOKS = _sdk_hooks()
    _DECIDE_BASE = _HOOKS.PreToolCallDecideHook
except Exception:  # pragma: no cover — SDK absent in pure-syntax checks
    _DECIDE_BASE = object


class PreToolApprovalBridge(_DECIDE_BASE):
    """Ask the host over the bridge protocol before every tool call (ask mode)."""

    def __init__(self, bridge: Bridge):
        self.bridge = bridge

    async def run(self, context, data):  # SDK DecideHook protocol
        aid = uuid.uuid4().hex
        emit({"event": "approval_request", "id": aid,
              "tool": str(getattr(data, "name", "unknown")),
              "args": str(getattr(data, "args", "") or "")[:400]})
        allow = await self.bridge.wait_approval(aid)
        return _HOOKS.HookResult(allow=allow, message=None if allow else "denied by user")


async def main():
    bridge = Bridge()
    await bridge.main_loop()


if __name__ == "__main__":
    asyncio.run(main())
