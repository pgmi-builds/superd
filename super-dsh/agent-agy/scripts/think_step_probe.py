import asyncio, os
for k in ('GOOGLE_APPLICATION_CREDENTIALS','GEMINI_API_KEY'): os.environ.pop(k,None)
import google.antigravity as ga

async def main():
    cfg = ga.LocalAgentConfig(model="gemini-3.7-flash", vertex=True, project="vertex-ai-489113", location="global", workspaces=["/tmp/agy-sdk-ws"])
    agent = ga.Agent(cfg)
    await agent.__aenter__()
    conv = agent.conversation
    resp = asyncio.ensure_future(agent.chat("What is 19*27? Think step by step."))
    n = 0
    async for step in conv.connection.receive_steps():
        td = getattr(step, 'thinking_delta', '') or ''
        print("STEP src=%s tgt=%s think=%d content=%d" % (
            getattr(step, 'source', '?'), getattr(step, 'target', '?'),
            len(td), len(getattr(step, 'content_delta', '') or '')))
        n += 1
        if n > 60: break
    await resp

asyncio.run(main())
