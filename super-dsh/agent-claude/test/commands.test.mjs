import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const { registerClaudeCommands, slashCommandsFromReported } = await import("../dist/commands.js");

test("every observed Claude slash command is registered under a claude- prefixed name", () => {
  const registered = [];
  const commands = { register: (def) => { registered.push(def); return () => {}; } };
  const dispose = registerClaudeCommands({ commands }, {
    listSlashCommands: () => [{ name: "mcp", description: "Manage MCP servers", argumentHint: "" }],
    submit: () => {},
  });
  assert.equal(registered.length, 1);
  assert.equal(registered[0].name, "claude-mcp");
  assert.match(registered[0].description, /Claude/);
  dispose();
});

test("executing a registered command submits the raw Claude line and reports the output", async () => {
  const submitted = [];
  const commands = { register: (def) => { commands.last = def; return () => {}; } };
  registerClaudeCommands({ commands }, {
    listSlashCommands: () => [{ name: "mcp", description: "d", argumentHint: "" }],
    submit: (_agent, line) => submitted.push(line),
  });
  const result = await commands.last.handler({ agent: { id: "a1" }, rawInput: "", attachments: [], signal: new AbortController().signal });
  assert.deepEqual(submitted, ["/mcp"]);
  assert.equal(result.kind, "success");
});

/**
 * A recording fake of the `CommandRuntime` slice this module consumes: it keeps
 * every definition, every disposer call, and — like the real registry — the set
 * of names currently live in this scope, so a registration that fails to release
 * a previous name before re-registering THROWS instead of passing silently.
 */
function fakeRuntime() {
  const registered = [];
  const disposed = [];
  const live = new Set();
  const commands = {
    register: (definition) => {
      if (live.has(definition.name)) throw new Error(`command "${definition.name}" is already registered in this scope`);
      live.add(definition.name);
      registered.push(definition);
      return () => { disposed.push(definition.name); live.delete(definition.name); };
    },
  };
  return { commands, registered, disposed, live };
}


test("the returned disposer disposes EVERY registration it made (and only once)", () => {
  const { commands, registered, disposed } = fakeRuntime();
  const dispose = registerClaudeCommands({ commands }, {
    listSlashCommands: () => [
      { name: "mcp", description: "Manage MCP servers", argumentHint: "" },
      { name: "review", description: "Review a PR", argumentHint: "<pr>" },
      { name: "clear", description: "", argumentHint: "" },
    ],
    submit: () => { },
  });
  assert.deepEqual(registered.map((definition) => definition.name), ["claude-mcp", "claude-review", "claude-clear"]);
  assert.deepEqual(disposed, []);
  dispose();
  assert.deepEqual(disposed, ["claude-mcp", "claude-review", "claude-clear"]);
  dispose();
  assert.deepEqual(disposed, ["claude-mcp", "claude-review", "claude-clear"]);
});

test("a throwing registration disposer still lets the disposer release every other registration", () => {
  const disposed = [];
  const commands = {
    register: (definition) => {
      if (definition.name === "claude-review") return () => { throw new Error("boom"); };
      return () => { disposed.push(definition.name); };
    },
  };
  const dispose = registerClaudeCommands({ commands }, {
    listSlashCommands: () => [
      { name: "mcp", description: "d", argumentHint: "" },
      { name: "review", description: "d", argumentHint: "" },
      { name: "clear", description: "d", argumentHint: "" },
    ],
    submit: () => { },
  });
  assert.throws(dispose, /boom/);
  assert.deepEqual(disposed, ["claude-mcp", "claude-clear"]);
});

test("a throwing registration rolls back the registrations that already landed", () => {
  const disposed = [];
  const commands = {
    register: (definition) => {
      if (definition.name === "claude-review") throw new Error("register refused");
      return () => { disposed.push(definition.name); };
    },
  };
  assert.throws(() => registerClaudeCommands({ commands }, {
    listSlashCommands: () => [
      { name: "mcp", description: "d", argumentHint: "" },
      { name: "review", description: "d", argumentHint: "" },
      { name: "clear", description: "d", argumentHint: "" },
    ],
    submit: () => { },
  }), /register refused/);
  assert.deepEqual(disposed, ["claude-mcp"]);
});

test("a duplicate observed name registers exactly once", () => {
  const { commands, registered } = fakeRuntime();
  registerClaudeCommands({ commands }, {
    listSlashCommands: () => [
      { name: "mcp", description: "first", argumentHint: "" },
      { name: "mcp", description: "second", argumentHint: "" },
    ],
    submit: () => { },
  });
  assert.equal(registered.length, 1);
  assert.equal(registered[0].name, "claude-mcp");
  assert.equal(registered[0].description, "Claude Code: first");
});

test("names that cannot become a command id are skipped, never thrown", () => {
  const { commands, registered } = fakeRuntime();
  registerClaudeCommands({ commands }, {
    listSlashCommands: () => [
      { name: "", description: "d", argumentHint: "" },
      { name: "   ", description: "d", argumentHint: "" },
      { name: undefined, description: "d", argumentHint: "" },
      { name: 42, description: "d", argumentHint: "" },
      { name: "clear", description: "d", argumentHint: "" },
    ],
    submit: () => { },
  });
  assert.deepEqual(registered.map((definition) => definition.name), ["claude-clear"]);
});

test("every registered id is a valid DSH command id, keeps the prefix, and stays 1:1 with the observed name", () => {
  const { commands, registered } = fakeRuntime();
  registerClaudeCommands({ commands }, {
    listSlashCommands: () => [
      { name: "mcp:status", description: "d", argumentHint: "" },
      { name: "MCP List", description: "d", argumentHint: "" },
      { name: "claude-mcp", description: "d", argumentHint: "" },
    ],
    submit: () => { },
  });
  const COMMAND_NAME = /^[a-z][a-z0-9_-]*$/u;
  for (const definition of registered) {
    assert.match(definition.name, COMMAND_NAME);
    assert.ok(definition.name.startsWith("claude-"), definition.name);
  }
  assert.deepEqual(
    registered.map((definition) => definition.name),
    ["claude-mcp-status", "claude-mcp-list", "claude-claude-mcp"],
  );
});

test("the handler re-submits the ORIGINAL slash line with the raw tail appended verbatim", async () => {
  const submitted = [];
  const { commands, registered } = fakeRuntime();
  registerClaudeCommands({ commands }, {
    listSlashCommands: () => [{ name: "mcp:status", description: "d", argumentHint: " <server>" }],
    submit: (_agent, line) => submitted.push(line),
  });
  const agent = { id: "a1" };
  for (const rawInput of ["", " list", "  --json  "]) {
    const result = await registered[0].handler({
      agent,
      rawInput,
      attachments: [],
      signal: new AbortController().signal,
    });
    assert.deepEqual(result, { kind: "success" });
  }
  // The registered id is sanitized (`claude-mcp-status`), the forwarded line is
  // not: the runtime must receive the exact Claude line the user picked.
  assert.deepEqual(submitted, ["/mcp:status", "/mcp:status list", "/mcp:status  --json  "]);
});

test("every description is non-empty and names Claude; an empty argument hint is omitted", () => {
  const { commands, registered } = fakeRuntime();
  registerClaudeCommands({ commands }, {
    listSlashCommands: () => [
      { name: "a", description: "Manage servers", argumentHint: "" },
      { name: "b", description: "   ", argumentHint: "   " },
      { name: "c", argumentHint: "<target>" },
    ],
    submit: () => { },
  });
  for (const definition of registered) {
    assert.ok(definition.description.trim().length > 0, definition.name);
    assert.match(definition.description, /Claude/);
  }
  assert.equal(registered[0].input, undefined);
  assert.equal(registered[1].input, undefined);
  assert.deepEqual(registered[2].input, { hint: "<target>" });
});

test("the built module has no import or require at all (structural type only, no Cordis runtime)", () => {
  const built = readFileSync(new URL("../dist/commands.js", import.meta.url), "utf8");
  assert.doesNotMatch(built, /^\s*import\b/mu, "no ESM import statement");
  assert.doesNotMatch(built, /from\s+["']@deepseek-ai/u, "no Cordis runtime import");
  assert.doesNotMatch(built, /\brequire\(/u, "no CJS require");
});

test("package.json points the bundle loader at cordis.patch.yml and the row resolves to this package", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.name, "@pgmi-builds/agent-adapter-claude");
  assert.equal(pkg.dsh?.bundle?.patch, "./cordis.patch.yml");
  assert.ok(Array.isArray(pkg.files) && pkg.files.includes("cordis.patch.yml"), "cordis.patch.yml must ship in files[]");
  assert.ok(existsSync(new URL("../cordis.patch.yml", import.meta.url)));
});

const REQUIRE = createRequire(import.meta.url);
const REPO_ROOT = fileURLToPath(new URL("../../../..", import.meta.url));

/**
 * Resolve a YAML parser WITHOUT adding a dependency: the package has none, but
 * the repo's upstream checkout carries `js-yaml` (hoisted) and `yaml` (pnpm).
 * Returns `undefined` when neither is present, in which case the structural
 * test below is SKIPPED rather than failing a machine that lacks the checkout.
 */
function resolveYamlParser() {
  const candidates = [
    "yaml",
    "js-yaml",
    `${REPO_ROOT}upstream/deepseek-harness/node_modules/js-yaml`,
    `${REPO_ROOT}upstream/deepseek-harness/node_modules/yaml`,
  ];
  for (const candidate of candidates) {
    try {
      const mod = REQUIRE(candidate);
      const load = typeof mod?.load === "function"
        ? mod.load
        : typeof mod?.parse === "function" ? mod.parse : mod?.default?.parse;
      if (typeof load === "function") return (text) => load.call(mod, text);
    } catch { /* try the next candidate */ }
  }
  return undefined;
}

const parseYaml = resolveYamlParser();

test("cordis.patch.yml parses and carries the exact standalone row table", {
  skip: parseYaml === undefined ? "no YAML parser resolvable without adding a dependency" : false,
}, () => {
  const rows = parseYaml(readFileSync(new URL("../cordis.patch.yml", import.meta.url), "utf8"));
  assert.ok(Array.isArray(rows), "the patch must be a top-level sequence of rows");

  const disabled = rows.filter((row) => row?.disabled === true).map((row) => row.id);
  assert.deepEqual(disabled, ["agent-loop", "llm-deepseek", "llm-pi-ai", "agent-presets", "directory-picker"]);

  const inserted = rows.filter((row) => Array.isArray(row.insert)).flatMap((row) => row.insert);
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.deepEqual(inserted, [
    { id: "claude-provider", name: pkg.name },
    { id: "directory-picker-browse", name: "@deepseek-ai/dsh-host-directory-picker-browse" },
    { id: "directory-picker-browse-surface", name: "@deepseek-ai/dsh-client-ui-directory-picker-browse" },
  ]);

  // The auto row is unmounted by `disabled`, never replaced by an insert of the
  // same id; its two faces are pinned as plain inserts above.
  assert.equal(rows.some((row) => row.id === "directory-picker" && row.insert !== undefined), false);

  const permission = rows.find((row) => row.id === "permission");
  assert.deepEqual(Object.keys(permission.config.presets), ["read-only", "workspace-write", "danger-full-access"]);
  assert.deepEqual(permission.config.presets["read-only"], { sandbox: "read-only", approval: "ask" });
  assert.deepEqual(permission.config.presets["workspace-write"], { sandbox: "workspace-write", approval: "ask" });
  assert.deepEqual(permission.config.presets["danger-full-access"], { sandbox: "danger-full-access", approval: "never" });
  assert.equal(permission.config.defaultPreset, "danger-full-access");

  // No row may disable AND insert: the directory-picker lesson, generalised.
  for (const row of rows) {
    assert.equal(row.disabled === true && row.insert !== undefined, false, `row ${String(row.id)} both disables and inserts`);
  }
});

// --- observation-shape pins -------------------------------------------------

test("slashCommandsFromReported normalizes both report shapes and drops what it cannot use", () => {
  assert.deepEqual(slashCommandsFromReported(undefined), []);
  assert.deepEqual(slashCommandsFromReported("mcp"), []);
  assert.deepEqual(slashCommandsFromReported([null, 42, true, "", "   "]), []);
  // The session_init shape (bare, space-padded names).
  assert.deepEqual(slashCommandsFromReported([" mcp ", "clear"]), [{ name: "mcp" }, { name: "clear" }]);
  // The supportedCommands() shape (objects), trimmed, first report wins, blanks dropped.
  assert.deepEqual(
    slashCommandsFromReported([
      { name: " mcp ", description: "  Manage MCP servers ", argumentHint: "  <cmd>  " },
      { name: "mcp", description: "a later duplicate" },
      { description: "no name at all" },
      { name: "clear", description: "   ", argumentHint: "" },
    ]),
    [
      { name: "mcp", description: "Manage MCP servers", argumentHint: "<cmd>" },
      { name: "clear" },
    ],
  );
});

// --- live-path wiring pins --------------------------------------------------
//
// These construct a REAL ClaudeAgent over a REAL ClaudeSdkClient (only the SDK
// `query` factory is faked) and drive the same `session_init` the CLI sends.
// They are the dead-wiring pins: delete the `ctx.inject(["commands"])` block in
// agent.ts and every assertion below sees zero registrations.

const { Context } = await import("@deepseek-ai/cordis");
const { ClaudeAgent } = await import("../dist/agent.js");
const {
  ClaudeSdkClient,
  setClaudeFactory,
  resetClaudeClientState,
} = await import("../dist/claude-client.js");
const { readModelCatalog, setModelCatalog } = await import("../dist/models.js");

/** Session stub with the minimal surface the agent's construction and turns touch. */
function recordingSession(id) {
  const appended = [];
  return {
    session: {
      id,
      snapshotEvents: () => [],
      requestHeader: () => undefined,
      append: (type, data) => {
        const event = { seq: appended.length, time: Date.now(), type, data };
        appended.push(event);
        return event;
      },
    },
    appended,
  };
}

async function waitFor(predicate, label) {
  for (let tick = 0; tick < 500; tick += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.fail(`timed out waiting for ${label}`);
}

/**
 * A real ClaudeSdkClient whose fake SDK query yields the CLI's `system/init`
 * once (carrying `slash_commands`) and then stays silent, while a drain loop
 * records every pushed SDKUserMessage exactly as it would reach the CLI.
 */
function sessionInitClient(pushed, { slashCommands, supportedCommands }) {
  resetClaudeClientState();
  setClaudeFactory((o) => {
    void (async () => { for await (const message of o.prompt) pushed.push(message); })();
    return {
      interrupt: async () => { },
      setModel: async () => { },
      setPermissionMode: async () => { },
      ...(supportedCommands === undefined ? {} : { supportedCommands }),
      close: () => { },
      async *[Symbol.asyncIterator]() {
        yield {
          type: "system",
          subtype: "init",
          session_id: "sdk-1",
          cwd: "/w",
          model: "claude-sonnet-5",
          permissionMode: "default",
          tools: [],
          slash_commands: slashCommands,
          skills: [],
          plugins: [],
          mcp_servers: [],
        };
        await new Promise(() => { });
      },
    };
  });
  return new ClaudeSdkClient({ cwd: "/w", claudeSessionId: "11112222-3333-4444-5555-666677778888" });
}

const WIRING_SESSION = "session-11112222-3333-4444-5555-666677778888";

/** Construct the live agent over the given ctx and drive the init observation. */
async function liveAgent(ctx, client) {
  const { session } = recordingSession(WIRING_SESSION);
  const agent = new ClaudeAgent(ctx, WIRING_SESSION, {}, session, client);
  await client.ensureStarted();
  return agent;
}

test("the live ClaudeAgent mirrors its session's slash commands and forwards a picked one to Claude", async () => {
  const { commands, registered, disposed, live } = fakeRuntime();
  const ctx = new Context();
  ctx.provide("commands", commands);
  const pushed = [];
  const client = sessionInitClient(pushed, { slashCommands: ["mcp", "clear"] });
  const agent = await liveAgent(ctx, client);
  try {
    await waitFor(() => registered.length >= 2, "the mirrored claude- registrations");
    assert.deepEqual(registered.map((definition) => definition.name), ["claude-mcp", "claude-clear"]);
    assert.deepEqual(disposed, [], "the init-stage mirror must not be released before it is replaced or the agent is disposed");

    // A foreign invocation must never drive this session's CLI.
    const foreign = await registered[0].handler({ agent: { id: "other" }, rawInput: " list", attachments: [], signal: new AbortController().signal });
    assert.deepEqual(foreign, { kind: "success" });
    assert.deepEqual(pushed, [], "a misrouted invocation must not reach the wire");

    // Idle agent: picking the command opens a real turn carrying the exact line.
    const handled = await registered[0].handler({ agent, rawInput: " list", attachments: [], signal: new AbortController().signal });
    assert.deepEqual(handled, { kind: "success" });
    await waitFor(() => pushed.length > 0, "the forwarded slash line on the wire");
    assert.deepEqual(pushed[0].message.content, [{ type: "text", text: "/mcp list" }]);
  } finally {
    await agent.dispose();
  }
  assert.deepEqual(disposed.sort(), ["claude-clear", "claude-mcp"], "disposal must release every mirrored command");
  assert.equal(live.size, 0);
});

test("supportedCommands() enriches the mirror, releasing the old one before re-registering", async () => {
  const { commands, registered, disposed } = fakeRuntime();
  const ctx = new Context();
  ctx.provide("commands", commands);
  const pushed = [];
  const client = sessionInitClient(pushed, {
    slashCommands: ["mcp"],
    supportedCommands: async () => [
      { name: "mcp", description: "Manage MCP servers", argumentHint: "<cmd>" },
    ],
  });
  const agent = await liveAgent(ctx, client);
  try {
    // The fake registry throws on a duplicate name in one scope: reaching two
    // registrations at all proves the rebuild disposed the old mirror first.
    await waitFor(() => registered.length >= 2, "the enriched mirror rebuild");
    assert.deepEqual(registered.map((definition) => definition.name), ["claude-mcp", "claude-mcp"]);
    assert.deepEqual(disposed, ["claude-mcp"]);
    assert.equal(registered[1].description, "Claude Code: Manage MCP servers");
    assert.deepEqual(registered[1].input, { hint: "<cmd>" });
  } finally {
    await agent.dispose();
  }
});

test("a session that reports no slash commands mirrors zero commands without throwing", async () => {
  setModelCatalog([]);
  const { commands, registered } = fakeRuntime();
  const ctx = new Context();
  ctx.provide("commands", commands);
  const pushed = [];
  const client = sessionInitClient(pushed, { slashCommands: [] });
  const agent = await liveAgent(ctx, client);
  try {
    // The init landed (it fed the model catalog) and still registered nothing.
    await waitFor(() => readModelCatalog().models.some((model) => model.id === "claude-sonnet-5"), "the session_init observation");
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(registered, []);
  } finally {
    await agent.dispose();
  }
  setModelCatalog([]);
});

test("a world without the commands service mirrors nothing and never throws", async () => {
  const ctx = new Context();
  let listener = () => { };
  const client = {
    on(l) { listener = l; return () => { }; },
    close() { },
    supportedModels: async () => ["claude-sonnet-5"],
    supportedCommands: async () => [],
    prompt: async () => { },
    followUp: async () => { },
    setPermissionMode: async () => { },
    interrupt: async () => { },
    getState: async () => ({ isStreaming: false }),
  };
  const { session } = recordingSession("session-no-commands");
  const agent = new ClaudeAgent(ctx, "session-no-commands", {}, session, client);
  try {
    listener({ type: "session_init", model: "claude-sonnet-5", slashCommands: ["mcp"], tools: [] });
    await new Promise((resolve) => setTimeout(resolve, 10));
  } finally {
    await agent.dispose();
  }
});

// --- real-registry pin ------------------------------------------------------
//
// The strongest form of the wiring pin: mount the REAL CommandRuntime and build
// two live agents that observe the SAME command names. Agent-scoped layers are
// what let the second agent register at all (the registry throws on a duplicate
// name inside one layer), each agent's own view carries its own mirror, and
// disposing one agent leaves the other's commands intact.

let RealCommandRuntime;
try {
  RealCommandRuntime = (await import("@deepseek-ai/dsh-commands")).default;
} catch {
  RealCommandRuntime = undefined;
}

test("two live agents mirror the same claude- names into their own scopes against the real CommandRuntime", {
  skip: RealCommandRuntime === undefined ? "@deepseek-ai/dsh-commands is not resolvable here" : false,
}, async () => {
  const ctx = new Context();
  await ctx.plugin(RealCommandRuntime);

  const clients = new Map();
  const fakeClient = (id) => {
    let listener = () => { };
    const client = {
      on(l) { listener = l; return () => { }; },
      close() { },
      supportedModels: async () => [],
      supportedCommands: async () => [],
      prompt: async () => { },
      followUp: async () => { },
      setPermissionMode: async () => { },
      interrupt: async () => { },
      getState: async () => ({ isStreaming: false }),
      emit: (event) => listener(event),
    };
    clients.set(id, client);
    return client;
  };

  const sessionA = "session-11111111-1111-4111-8111-111111111111";
  const sessionB = "session-22222222-2222-4222-8222-222222222222";
  const agentA = new ClaudeAgent(ctx, sessionA, {}, recordingSession(sessionA).session, fakeClient(sessionA));
  const agentB = new ClaudeAgent(ctx, sessionB, {}, recordingSession(sessionB).session, fakeClient(sessionB));
  await new Promise((resolve) => setTimeout(resolve, 30));

  const init = { type: "session_init", model: "claude-sonnet-5", slashCommands: ["mcp", "clear"] };
  clients.get(sessionA).emit(init);
  clients.get(sessionB).emit(init);
  await new Promise((resolve) => setTimeout(resolve, 30));

  try {
    assert.deepEqual(ctx.commands.list(agentA).map((descriptor) => descriptor.name), ["claude-clear", "claude-mcp"]);
    assert.deepEqual(ctx.commands.list(agentB).map((descriptor) => descriptor.name), ["claude-clear", "claude-mcp"]);
    const definition = ctx.commands.find(agentA, "claude-mcp");
    assert.ok(definition, "the agent-scoped mirror must resolve through the real registry");
    assert.equal(definition.description, "Claude Code slash command");
    assert.deepEqual(
      definition.handler({ agent: agentA, rawInput: " list", attachments: [], signal: new AbortController().signal, commandId: "c1" }),
      { kind: "success" },
    );

    await agentA.dispose();
    assert.deepEqual(ctx.commands.list(agentA).map((descriptor) => descriptor.name), [], "disposing an agent releases its own mirror");
    assert.deepEqual(ctx.commands.list(agentB).map((descriptor) => descriptor.name), ["claude-clear", "claude-mcp"], "a sibling session's mirror must survive");
  } finally {
    await agentA.dispose();
    await agentB.dispose();
  }
});
