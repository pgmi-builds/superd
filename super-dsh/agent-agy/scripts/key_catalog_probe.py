import asyncio, os, sys, json
key = sys.argv[1]
os.environ.pop('GOOGLE_APPLICATION_CREDENTIALS', None)
import google.antigravity as ga

CANDIDATES = ["gemini-3.6-flash","gemini-3.6-pro","gemini-3.7-flash","gemini-3.7-pro",
              "gemini-3.5-flash","gemini-3.5-pro","gemini-2.5-flash","gemini-2.5-pro",
              "gemini-3-flash","gemini-3-pro","gemini-3.6-flash-lite"]

async def probe(model):
    cfg = ga.LocalAgentConfig(model=model, api_key=key, workspaces=["/tmp/agy-sdk-ws"])
    try:
        agent = ga.Agent(cfg)
        await agent.__aenter__()
        resp = await agent.chat("Reply with exactly: OK")
        text = ""
        async for ch in resp:
            text += str(ch)
        await agent.__aexit__(None, None, None)
        return {"model": model, "ok": True, "sample": text.strip()[:12]}
    except Exception as e:
        try: await agent.__aexit__(None, None, None)
        except Exception: pass
        return {"model": model, "ok": False, "err": str(e)[:90]}

async def main():
    for m in CANDIDATES:
        print(json.dumps(await probe(m)), flush=True)
asyncio.run(main())
