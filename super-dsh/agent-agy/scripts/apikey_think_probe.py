import asyncio, os, sys
key = sys.argv[1]
model = sys.argv[2]
os.environ.pop('GOOGLE_APPLICATION_CREDENTIALS', None)
import google.antigravity as ga

async def main():
    cfg = ga.LocalAgentConfig(model=model, api_key=key, workspaces=["/tmp/agy-sdk-ws"])
    agent = ga.Agent(cfg)
    await agent.__aenter__()
    resp = await agent.chat("What is 19*27? Think it through briefly, then answer.")
    kinds = {}
    thought_sample = None
    async for ch in resp.chunks:
        k = type(ch).__name__
        kinds[k] = kinds.get(k, 0) + 1
        if k == "Thought" and thought_sample is None:
            thought_sample = str(getattr(ch, 'text', ''))[:80]
    print("KINDS:", json.dumps(kinds))
    print("THOUGHT_SAMPLE:", repr(thought_sample))
    u = getattr(agent.conversation, 'last_turn_usage', None)
    if callable(u): u = u()
    print("USAGE:", u.model_dump() if u is not None and hasattr(u, 'model_dump') else None)

import json
asyncio.run(main())
