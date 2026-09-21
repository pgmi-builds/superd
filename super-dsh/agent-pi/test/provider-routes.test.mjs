// PiProvider boot wiring (src/index.ts #registerModelCatalog): the adapter
// registers the placeholder `pi` route at boot (registerAdapter must not be
// empty) and atomically swaps the registration to the distinct REAL provider
// slugs once warmPiCatalog() resolves (omp parity; zai/deepseek/… groups).
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Context } from "@deepseek-ai/cordis";

const models = await import("../dist/models.js");
const { setPiModelRuntimeFactory, clearPiCatalogForTests, PI_PROVIDER_ID } = models;
const { PiProvider } = await import("../dist/index.js");

function tempPiAgentDir(settings) {
  const dir = mkdtempSync(join(tmpdir(), "aw-pi-routes-"));
  mkdirSync(dir, { recursive: true });
  if (settings !== undefined) writeFileSync(join(dir, "settings.json"), JSON.stringify(settings));
  return dir;
}

/** Recording LlmRuntime: captures the boot registration and any replace(). */
function fakeLlm() {
  const registrations = [];
  return {
    registrations,
    registerAdapter(providers, adapter) {
      const reg = { bootProviders: [...providers], adapter, replaced: null };
      const handle = () => { };
      handle.replace = (next) => {
        reg.replaced = [...next];
      };
      registrations.push(reg);
      return handle;
    },
  };
}

function providerContext(llm) {
  const ctx = new Context();
  ctx.provide("dshHomePath", mkdtempSync(join(tmpdir(), "aw-pi-routes-home-")));
  ctx.provide("agents", { setFactory() { } });
  ctx.provide("llm", llm);
  return ctx;
}

async function waitFor(condition, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return condition();
}

test("boot placeholder route swaps to distinct real provider slugs after warm (settings default first)", async () => {
  const dir = tempPiAgentDir({ defaultProvider: "zai", defaultModel: "glm" });
  process.env.PI_CODING_AGENT_DIR = dir;
  clearPiCatalogForTests();
  setPiModelRuntimeFactory(async () => ({
    getAvailable: async () => [
      { id: "glm", provider: "zai", name: "GLM" },
      { id: "v4-pro", provider: "deepseek", name: "DeepSeek v4 Pro", contextWindow: 128000 },
      { id: "v4-flash", provider: "deepseek", name: "DeepSeek v4 Flash" },
      { id: "sonnet", provider: "anthropic", name: "Claude Sonnet" },
    ],
    getModel: () => undefined,
  }));

  const llm = fakeLlm();
  new PiProvider(providerContext(llm));

  // Boot: exactly one registration, under the placeholder route, non-empty.
  assert.equal(llm.registrations.length, 1);
  assert.deepEqual(llm.registrations[0].bootProviders, [PI_PROVIDER_ID]);
  assert.ok(llm.registrations[0].adapter);

  // After the fire-and-forget warm resolves: replace() carries the distinct
  // slugs — the operator-wired provider (pi settings default) leads, the rest
  // alphabetical; the umbrella route is gone.
  assert.ok(
    await waitFor(() => llm.registrations[0].replaced !== null),
    "handle.replace was not called after warmPiCatalog",
  );
  assert.deepEqual(llm.registrations[0].replaced, ["zai", "anthropic", "deepseek"]);
  assert.ok(!llm.registrations[0].replaced.includes(PI_PROVIDER_ID));

  delete process.env.PI_CODING_AGENT_DIR;
  clearPiCatalogForTests();
});
