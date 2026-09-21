// Task 5: config.toml + model_catalog_json → Dash-facing model catalog.
// Fixtures mirror the real cc-switch shapes (glm-5.2 via custom provider).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readCodexModelCatalog } from "../dist/models.js";

const FIX = join(new URL(".", import.meta.url).pathname, "fixtures", "models-home");

function seedHome(configToml, catalog) {
  rmSync(FIX, { recursive: true, force: true });
  mkdirSync(FIX, { recursive: true });
  if (configToml !== null) writeFileSync(join(FIX, "config.toml"), configToml);
  if (catalog !== null) writeFileSync(join(FIX, "cc-switch-model-catalog.json"), catalog);
}
import { rmSync } from "node:fs";

const GOOD_TOML = `model_provider = "custom"
model = "glm-5.2"
model_reasoning_effort = "high"
disable_response_storage = true
model_catalog_json = "cc-switch-model-catalog.json"

[model_providers]

[model_providers.custom]
name = "zhipu_glm_en"
base_url = "http://127.0.0.1:15721/v1"

[projects."/home/u1/workspaces/base"]
trust_level = "trusted"
`;

const GOOD_CATALOG = JSON.stringify({
  models: [
    {
      slug: "glm-5.2",
      display_name: "GLM-5.2",
      description: "GLM-5.2",
      default_reasoning_level: "medium",
      context_window: 1000000,
      input_modalities: ["text"],
    },
    {
      slug: "glm-5.2-air",
      display_name: "GLM-5.2-Air",
      description: "light tier",
    },
  ],
});

test("readCodexModelCatalog: real-shaped config + catalog → entries with reasoning + provider name", () => {
  seedHome(GOOD_TOML, GOOD_CATALOG);
  const catalog = readCodexModelCatalog(FIX);
  assert.equal(catalog.defaultModel, "glm-5.2");
  assert.equal(catalog.provider, "zhipu_glm_en");
  assert.equal(catalog.models.length, 2);
  assert.deepEqual(
    catalog.models[0],
    { id: "glm-5.2", label: "GLM-5.2", reasoningEffort: "medium", contextWindow: 1000000 },
  );
  assert.equal(catalog.models[1].id, "glm-5.2-air");
  assert.equal(catalog.models[1].label, "GLM-5.2-Air");
  assert.equal(catalog.models[1].reasoningEffort, undefined);
});

test("readCodexModelCatalog: missing home/files → fail-soft placeholder, never throws", () => {
  seedHome(null, null);
  const catalog = readCodexModelCatalog(FIX);
  assert.equal(catalog.defaultModel, "codex-default");
  assert.deepEqual(catalog.models, [{ id: "codex-default", label: "Codex default" }]);
});

test("readCodexModelCatalog: broken lines/entries tolerated", () => {
  seedHome(`model = "glm-5.2"\nbroken line without equals\nmodel_catalog_json = "cat.json"\n`, "{ not json");
  const catalog = readCodexModelCatalog(FIX);
  assert.equal(catalog.defaultModel, "glm-5.2", "config model still parsed");
  assert.equal(catalog.models.length, 1, "unparsable catalog degrades to config model only");
  assert.equal(catalog.models[0].id, "glm-5.2");
});

test("readCodexModelCatalog: no config model → catalog first entry becomes default", () => {
  seedHome(`model_catalog_json = "cc-switch-model-catalog.json"\n`, GOOD_CATALOG);
  const catalog = readCodexModelCatalog(FIX);
  assert.equal(catalog.defaultModel, "glm-5.2", "first catalog entry is the default when config.model is absent");
});
