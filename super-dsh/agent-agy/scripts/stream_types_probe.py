import json, subprocess, threading, os
env = dict(os.environ)
env.update({
    "HOME": "/tmp/agy-home-key2",
    "GEMINI_API_KEY": os.environ.get("GEMINI_API_KEY", ""),
    "HTTPS_PROXY": "http://187.127.111.29:7474",
    "NO_PROXY": "127.0.0.1,localhost",
})
p = subprocess.Popen(["agy", "--input-format=stream-json", "--output-format=stream-json",
                      "--model=gemini-3.6-flash", "--effort=high"],
                     stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                     text=True, cwd="/tmp", env=env)
kinds = {}
def reader():
    for line in p.stdout:
        try: d = json.loads(line)
        except Exception: continue
        if d.get("event") == "step_update":
            su = d["step_update"]
            k = (su.get("step_type"), su.get("state"))
            kinds[k] = kinds.get(k, 0) + 1
            if su.get("step_type") not in ("agent_response", "tool", "user_input") or su.get("step_type")=="tool":
                print("RAW:", json.dumps(su, ensure_ascii=False)[:200], flush=True)
        elif d.get("event") == "result":
            print("RESULT:", d["result"].get("status"), flush=True)
threading.Thread(target=reader, daemon=True).start()
p.stdin.write(json.dumps({"event": "user", "message": {"content": "Is the Collatz conjecture proven? Briefly reason then answer in 2 sentences."}}) + "\n")
p.stdin.flush()
try: p.wait(timeout=120)
except subprocess.TimeoutExpired: p.kill()
pass
