window.__ModuleLoader__.load({ id: "super-dsh", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
//#region rolldown:runtime
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
	if (from && typeof from === "object" || typeof from === "function") for (var keys = __getOwnPropNames(from), i = 0, n = keys.length, key; i < n; i++) {
		key = keys[i];
		if (!__hasOwnProp.call(to, key) && key !== except) __defProp(to, key, {
			get: ((k) => from[k]).bind(null, key),
			enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
		});
	}
	return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", {
	value: mod,
	enumerable: true
}) : target, mod));

//#endregion
let react = require("react");
react = __toESM(react);
let react_jsx_runtime = require("react/jsx-runtime");
react_jsx_runtime = __toESM(react_jsx_runtime);

//#region src/client/RuntimeSeat.tsx
const NATIVE = {
	key: "native",
	label: "DSH",
	path: "/"
};
/** Fallback labels for the read-only face (which only reports keys). */
const RUNTIME_LABELS = {
	native: "DSH",
	omp: "OMP",
	codex: "Codex"
};
function fromGlobal() {
	const agents = globalThis.__DSH_AGENT_ROSTER__?.agents;
	if (!Array.isArray(agents)) return void 0;
	const links = [];
	for (const entry of agents) {
		if (typeof entry !== "object" || entry === null) continue;
		const { key, label, path } = entry;
		if (typeof key !== "string" || typeof path !== "string") continue;
		links.push({
			key,
			label: typeof label === "string" ? label : RUNTIME_LABELS[key] ?? key,
			path
		});
	}
	return links.length > 0 ? links : void 0;
}
/** Normalize the current mount root: `/omp` and `/omp/` are the same page. */
function currentPath() {
	const pathname = typeof location === "undefined" ? "/" : location.pathname;
	if (pathname === "" || pathname === "/") return "/";
	return pathname.endsWith("/") ? pathname : `${pathname}/`;
}
function RuntimeSeat({ wide }) {
	const [agents, setAgents] = react.useState(() => fromGlobal() ?? [NATIVE]);
	const [open, setOpen] = react.useState(false);
	const rootRef = react.useRef(null);
	react.useEffect(() => {
		let cancelled = false;
		fetch("/api/agent-runtime", { credentials: "same-origin" }).then((r) => r.ok ? r.json() : Promise.reject(/* @__PURE__ */ new Error(`HTTP ${r.status}`))).then((j) => {
			if (cancelled) return;
			if (Array.isArray(j?.agents)) {
				const listed = [];
				for (const entry of j.agents) {
					if (typeof entry !== "object" || entry === null) continue;
					const { key, label, path } = entry;
					if (typeof key !== "string" || typeof path !== "string") continue;
					listed.push({
						key,
						label: typeof label === "string" ? label : RUNTIME_LABELS[key] ?? key,
						path
					});
				}
				if (listed.length > 0) {
					setAgents(listed);
					return;
				}
			}
			if (!Array.isArray(j?.available)) return;
			const links = [];
			for (const key of j.available) {
				if (typeof key !== "string") continue;
				links.push(key === "native" ? NATIVE : {
					key,
					label: RUNTIME_LABELS[key] ?? key,
					path: `/${key}/`
				});
			}
			if (links.length > 0) setAgents(links);
		}).catch(() => {});
		return () => {
			cancelled = true;
		};
	}, []);
	react.useEffect(() => {
		if (!open) return;
		const onDown = (event) => {
			if (rootRef.current !== null && !rootRef.current.contains(event.target)) setOpen(false);
		};
		document.addEventListener("mousedown", onDown);
		return () => document.removeEventListener("mousedown", onDown);
	}, [open]);
	const here = currentPath();
	const active = agents.find((agent) => agent.path === here) ?? NATIVE;
	const styleBase = {
		display: "flex",
		alignItems: "center",
		gap: 8,
		width: "100%",
		padding: wide ? "7px 10px" : "7px 0",
		justifyContent: wide ? "flex-start" : "center",
		border: "none",
		borderRadius: 8,
		background: "transparent",
		color: "inherit",
		font: "inherit",
		fontSize: 13,
		cursor: "pointer",
		position: "relative"
	};
	const styleBadge = {
		fontSize: 10,
		lineHeight: 1.4,
		padding: "1px 6px",
		borderRadius: 999,
		background: "color-mix(in srgb, currentColor 12%, transparent)",
		whiteSpace: "nowrap"
	};
	const styleMenu = {
		position: "absolute",
		bottom: "calc(100% + 6px)",
		left: 6,
		right: 6,
		zIndex: 40,
		background: "var(--dsh-surface, #26262b)",
		border: "1px solid color-mix(in srgb, currentColor 18%, transparent)",
		borderRadius: 10,
		boxShadow: "0 8px 24px rgba(0,0,0,.35)",
		overflow: "hidden"
	};
	const styleItem = (isActive) => ({
		display: "block",
		width: "100%",
		padding: "8px 12px",
		border: "none",
		background: isActive ? "color-mix(in srgb, currentColor 10%, transparent)" : "transparent",
		color: "inherit",
		font: "inherit",
		fontSize: 13,
		textAlign: "left",
		cursor: "pointer"
	});
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		ref: rootRef,
		style: {
			position: "relative",
			width: "100%"
		},
		children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
			type: "button",
			style: styleBase,
			title: "Agent runtime — picking one opens that runtime's mount (/omp/, /codex/, …)",
			onClick: () => {
				setOpen((v) => !v);
			},
			children: wide ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					"aria-hidden": true,
					children: "⌘"
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
					style: {
						flex: 1,
						textAlign: "left",
						whiteSpace: "nowrap",
						overflow: "hidden",
						textOverflow: "ellipsis"
					},
					children: ["Agent · ", active.label]
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					style: styleBadge,
					children: "open"
				})
			] }) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				"aria-hidden": true,
				children: "⌘"
			})
		}), open && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
			style: styleMenu,
			children: agents.map((agent) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("a", {
				href: agent.path,
				style: {
					...styleItem(agent.path === here),
					textDecoration: "none"
				},
				"aria-current": agent.path === here ? "page" : void 0,
				onClick: () => {
					setOpen(false);
				},
				children: agent.path === here ? `${agent.label} ✓` : agent.label
			}, agent.key))
		})]
	});
}

//#endregion
//#region src/client/index.ts
/** Required services (cordis fiber inject): the slot registry. */
const inject = ["slots"];
/**
* Mount the selector. Degrades silently when the slot service is absent (a
* composition without the sidebar renders nothing — a footer action is an
* optional occupant by contract).
*
* @param ctx - client root context.
*/
function apply(ctx) {
	ctx.inject(["slots"], (raw) => {
		const scope = raw;
		scope.effect(() => scope.slots.inject("sidebar.footer.action", () => scope.slots.register({
			name: "sidebar.footer.action",
			id: "agent-runtime"
		}, RuntimeSeat)), "agent-hub: runtime footer action");
	});
}

//#endregion
exports.apply = apply;
exports.inject = inject;
return module.exports; } });