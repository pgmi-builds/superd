#!/usr/bin/env python3
"""ask-mode approval roundtrip driver: feeds start/prompt, auto-approves."""
import json, subprocess, sys, threading, time

p = subprocess.Popen([".venv/bin/python", "bridge/agy_bridge.py"],
                     stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)

def reader():
    for line in p.stdout:
        line = line.strip()
        if not line:
            continue
        print(line, flush=True)
        try:
            ev = json.loads(line)
        except Exception:
            continue
        if ev.get("event") == "approval_request":
            time.sleep(0.3)
            p.stdin.write(json.dumps({"op": "approval", "id": ev["id"], "allow": True}) + "\n")
            p.stdin.flush()

threading.Thread(target=reader, daemon=True).start()
for l in [
    json.dumps({"op": "start", "model": "gemini-3.7-flash", "project": "vertex-ai-489113",
                "location": "global", "approval_mode": "ask", "workspaces": ["/tmp"]}),
    json.dumps({"op": "prompt", "text": "List the files in the /tmp/agy-sdk-ws directory."}),
    json.dumps({"op": "close"}),
]:
    p.stdin.write(l + "\n")
p.stdin.flush()
try:
    p.wait(timeout=90)
except subprocess.TimeoutExpired:
    p.kill()
    print("TIMEOUT")
