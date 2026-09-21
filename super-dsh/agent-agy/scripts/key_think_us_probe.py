import asyncio, os, sys, json
key = sys.argv[1]
os.environ['HTTPS_PROXY'] = 'socks5h://127.0.0.1:11084'
os.environ['NO_PROXY'] = '127.0.0.1,localhost'
os.environ.pop('GOOGLE_APPLICATION_CREDENTIALS', None)
import google.antigravity as ga
from google.antigravity.models import GeminiModelOptions, GeminiAPIEndpoint, ModelTarget
from google.antigravity.types import ThinkingLevel

async def probe(model, level):
    cfg = ga.LocalAgentConfig(model=model, api_key=key, workspaces=["/tmp/agy-sdk-ws"])
    if level:
        cfg.model = None
        cfg.models = [ModelTarget(name=model,
                                  endpoint=GeminiAPIEndpoint(api_key=key),
                                  options=GeminiModelOptions(thinking_level=ThinkingLevel(level)))]
    agent = ga.Agent(cfg)
    await agent.__aenter__()
    resp = await agent.chat("What is 19*27? Think briefly, then answer.")
    kinds = {}
    sample = None
    async for ch in resp.chunks:
        k = type(ch).__name__
        kinds[k] = kinds.get(k, 0) + 1
        if k == "Thought" and sample is None:
            sample = str(getattr(ch, 'text', ''))[:60]
    u = getattr(agent.conversation, 'last_turn_usage', None)
    if callable(u): u = u()
    out = {"model": model, "level": level or "default", "kinds": kinds,
           "thought_sample": sample,
           "usage": u.model_dump() if u is not None and hasattr(u, 'model_dump') else None}
    print(json.dumps(out), flush=True)
    await agent.__aexit__(None, None, None)

async def main():
    await probe("gemini-3.6-flash", None)
    await probe("gemini-3.6-flash", "high")
    await probe("gemini-3.7-flash", "high")
asyncio.run(main())
