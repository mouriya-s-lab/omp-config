import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { getAgentDir } from "@oh-my-pi/pi-coding-agent";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ============================================================================
// omp-config-autoupdate — apply the omp-config repo at OMP start, when enabled.
//
// SWITCH. Off by default. `/omp-config-autoupdate on|off` writes
// `<agent dir>/omp-config-autoupdate.json` (`{"enabled": true|false}`);
// `/omp-config-autoupdate` or `… status` shows it. A missing or invalid file
// means off. The file is machine-local: the updater does not manage it and
// /sync-omp-config does not carry it. Read at each start, so a change applies
// from the next start.
//
// WHAT. When on, once per process, in the root session's `session_start`, runs
// `bun <agent dir>/omp-config-update.ts auto --agent-dir <agent dir> --json`
// as a child process. That script fetches origin into its own clone and, when
// the fetch succeeds and the fetched commit differs from the one last applied
// to this agent dir, applies it (see the header of omp-config-update.ts for
// what it touches and what it never touches). A failed fetch applies nothing.
//
// WHY A CHILD PROCESS. Extensions run in-process without isolation; an updater
// fault must never take OMP down. The child is spawned from a managed
// `ctx.setTimeout`, never awaited by startup, and keeps running if this
// session ends first: its writes are atomic and its lock is released by
// itself.
//
// TIMING. Files land while this session runs. Per-prompt and per-spawn
// files (APPEND_SYSTEM_MODEL.md, system-prompt-replace.json,
// PROMPT-INJECT-*.md, agents/) and live-reloaded config.yml apply at once;
// APPEND_SYSTEM.md, extensions (this one included) and plugins apply on the
// next start, which the notification says.
//
// FAILURE POLICY. Missing bun or script, a busy lock, offline fetch, or an
// apply error degrade to a log entry or warning; the session is unaffected.
// ============================================================================

const SCRIPT = "omp-config-update.ts";
const SWITCH_FILE = "omp-config-autoupdate.json";

type Switch = { readonly kind: "on" } | { readonly kind: "off" } | { readonly kind: "invalid"; readonly reason: string };

function readSwitch(path: string): Switch {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		return { kind: "off" };
	}
	try {
		const value: unknown = JSON.parse(text);
		if (typeof value === "object" && value !== null && "enabled" in value && typeof value.enabled === "boolean") {
			return value.enabled ? { kind: "on" } : { kind: "off" };
		}
		return { kind: "invalid", reason: 'expected {"enabled": true|false}' };
	} catch (error) {
		return { kind: "invalid", reason: error instanceof Error ? error.message : String(error) };
	}
}

type ApplyReport = {
	readonly written: readonly string[];
	readonly deleted: readonly string[];
	readonly errors: readonly string[];
	readonly pluginsInstalled: readonly string[];
	readonly restartNeeded: boolean;
};

type AutoResult =
	| { readonly kind: "busy" }
	| { readonly kind: "offline"; readonly error: string }
	| { readonly kind: "up-to-date"; readonly commit: string }
	| { readonly kind: "applied"; readonly commit: string; readonly report: ApplyReport }
	| { readonly kind: "failed"; readonly error: string };

/** One run per process: child sessions share this module and must not re-run it. */
let started = false;

function parseResult(stdout: string): AutoResult | undefined {
	const line = stdout.trim().split("\n").at(-1);
	if (!line) return undefined;
	try {
		const value: unknown = JSON.parse(line);
		return typeof value === "object" && value !== null && "kind" in value ? (value as AutoResult) : undefined;
	} catch {
		return undefined;
	}
}

type ChildRun = { code: number | null; stdout: string; stderr: string };

function runChild(bun: string, script: string, agentDir: string): Promise<ChildRun> {
	const { promise, resolve } = Promise.withResolvers<ChildRun>();
	const child = spawn(bun, [script, "auto", "--agent-dir", agentDir, "--json"], { stdio: ["ignore", "pipe", "pipe"] });
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
	child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
	child.on("error", (error) => resolve({ code: null, stdout, stderr: error.message }));
	child.on("close", (code) => resolve({ code, stdout, stderr }));
	return promise;
}

export default function ompConfigAutoupdate(pi: ExtensionAPI): void {
	const notify = (ctx: ExtensionContext, text: string, level: "info" | "warning"): void => {
		if (ctx.hasUI) ctx.ui.notify(text, level);
		if (level === "warning") pi.logger.warn(text);
		else pi.logger.info(text);
	};

	pi.registerCommand("omp-config-autoupdate", {
		description: "Turn startup auto-update of omp-config on or off: /omp-config-autoupdate [status|on|off]",
		getArgumentCompletions: prefix => {
			const matches = ["status", "on", "off"].filter(value => value.startsWith(prefix.trim().toLowerCase())).map(value => ({ value, label: value }));
			return matches.length ? matches : null;
		},
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase() || "status";
			const path = join(getAgentDir(), SWITCH_FILE);
			if (action === "on" || action === "off") {
				try {
					writeFileSync(path, `${JSON.stringify({ enabled: action === "on" })}\n`);
				} catch (error) {
					ctx.ui.notify(`omp-config: cannot write ${path}: ${error instanceof Error ? error.message : String(error)}`, "error");
					return;
				}
				ctx.ui.notify(`omp-config: auto-update ${action}; takes effect from the next OMP start (${path})`, "info");
				return;
			}
			if (action !== "status") {
				ctx.ui.notify("Usage: /omp-config-autoupdate [status|on|off]", "warning");
				return;
			}
			const state = readSwitch(path);
			switch (state.kind) {
				case "on":
					ctx.ui.notify(`omp-config: auto-update is on (${path})`, "info");
					return;
				case "off":
					ctx.ui.notify(`omp-config: auto-update is off (${path}); enable with /omp-config-autoupdate on`, "info");
					return;
				case "invalid":
					ctx.ui.notify(`omp-config: ${path} is invalid (${state.reason}); auto-update is off`, "warning");
					return;
			}
		},
	});

	pi.on("session_start", (_event, ctx) => {
		if (started || ctx.agent?.parentId) return;
		started = true;
		const switchPath = join(getAgentDir(), SWITCH_FILE);
		const state = readSwitch(switchPath);
		if (state.kind === "invalid") notify(ctx, `omp-config: ${switchPath} is invalid (${state.reason}); auto-update is off`, "warning");
		if (state.kind !== "on") return;
		ctx.setTimeout(async () => {
			const agentDir = getAgentDir();
			const script = join(agentDir, SCRIPT);
			if (!existsSync(script)) {
				notify(ctx, `omp-config: ${script} missing; run /update-omp once to install the updater`, "warning");
				return;
			}
			const bun = Bun.which("bun");
			if (!bun) {
				notify(ctx, "omp-config: bun is not on PATH; auto-update skipped", "warning");
				return;
			}
			const run = await runChild(bun, script, agentDir);
			const result = parseResult(run.stdout);
			if (!result) {
				notify(ctx, `omp-config: updater exited ${run.code} without a result: ${run.stderr.trim().slice(0, 500)}`, "warning");
				return;
			}
			switch (result.kind) {
				case "busy":
					pi.logger.info("omp-config: another update is running; skipped");
					return;
				case "offline":
					pi.logger.info(`omp-config: fetch failed, not updated: ${result.error}`);
					return;
				case "up-to-date":
					pi.logger.info(`omp-config: up to date at ${result.commit.slice(0, 7)}`);
					return;
				case "failed":
					notify(ctx, `omp-config: auto-update failed: ${result.error}`, "warning");
					return;
				case "applied": {
					const { report } = result;
					const changed = report.written.length + report.deleted.length + report.pluginsInstalled.length;
					if (report.errors.length > 0) {
						notify(ctx, `omp-config: applied ${result.commit.slice(0, 7)} with ${report.errors.length} error(s), will retry next start: ${report.errors[0]}`, "warning");
						return;
					}
					if (changed === 0) {
						pi.logger.info(`omp-config: ${result.commit.slice(0, 7)} applied, host already matched`);
						return;
					}
					notify(
						ctx,
						`omp-config: updated to ${result.commit.slice(0, 7)} (${report.written.length} written, ${report.deleted.length} deleted, ${report.pluginsInstalled.length} plugin(s) installed)${report.restartNeeded ? "; restart OMP to load extensions/APPEND_SYSTEM/plugins" : ""}`,
						"info",
					);
					return;
				}
			}
		}, 0);
	});
}
