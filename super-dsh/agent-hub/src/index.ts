/**
 * @pgmi-builds/agent-hub — host half public surface (Agent Worlds line).
 *
 * The line owns the switch and the gateway (per super-dsh/AGENTS.md):
 * the world inventory control plane + the foreign agent roster + the world
 * spawner, and (AW-B) the per-world mount carrier.
 *
 * DL7 (2026-09-16): the app-level selector value is GONE. World ownership is
 * per-request: the addressed world is the mount path of the request
 * (`/<label>/...`). `/api/*` stays ctx0/native and untouched.
 */
export { handleAgentRuntime, registerSelectorRpc, AGENT_RUNTIME_RPC_PATH, registryTargets, type RuntimeTargetSource } from './rpc.js'
export { registerForeignTarget, unregisterForeignTarget, getTarget, listRuntimeKeys, type ForeignTarget, type GatewayFace } from './targets.js'
export { registerAgent, unregisterAgent, setReady, listAgents, onRosterChanged, type RosterEntry } from './roster.js'
export { spawnWorld, type SpawnWorldOptions } from './spawn-world.js'
export { claimLabel, labelOf, releaseLabel, listLabels, type LabelClaim, type ClaimOptions } from './labels.js'
export { WorldWebServer, stripLabelFromUrl, type WorldWebRoute, type WorldWebUpgradeRoute, type RealWebServerFace } from './world-web-server.js'
export { parseClientRequest, serverResponse, serverError, serverResult, wireErrorOf, EnvelopeError, type ClientRequestEnvelope, type WireError } from './envelope.js'
export { WorldMuxServer, parseClientMessage, defaultFailure, type MuxOpen, type MuxFailure, type WorldMuxOptions } from './world-mux.js'
export { mountWorld, rewriteIndexHtml, type CarrierGatewayFace, type MountWorldOptions, type MountedWorld } from './carrier.js'
export { renderClientShim } from './client-shim.js'
export { agentLinks, agentRosterRow, AGENT_ROSTER_GLOBAL, type AgentLink } from './agent-roster.js'
export { createOwnershipIndex, type OwnershipIndex, type OwnershipRow } from './ownership.js'
export { registerHostMount, takeHostMount, listHostMounts, noteWorldServer, worldServerOf, type HostMount } from './world-host.js'
export { worldMountPatches, WORLD_MOUNT_PLUGIN, WORLD_MOUNT_ROW_ID, type WorldPatchLayer } from './world-mount.js'
export { default as worldApply, name as worldPluginName, type Config as WorldEntryConfig } from './world-entry.js'
export { default as joinApply, name as worldJoinPluginName, type Config as WorldJoinConfig } from './world-join.js'
export { default } from './gateway.js'
