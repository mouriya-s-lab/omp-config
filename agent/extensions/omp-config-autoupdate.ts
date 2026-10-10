import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { getAgentDir } from "@oh-my-pi/pi-coding-agent";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ============================================================================
// omp-config-autoupdate — apply the omp-config repo at OMP start, when enabled,
// or on demand.
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
// MANUAL RUN. `/omp-config-autoupdate run` runs the same child now, whatever
// the switch says, and once the session is idle posts the full report (commit
// range, every written/deleted/skipped path, plugins, notes, errors) as a
// display-only transcript message that starts no turn.
//
// WHY A CHILD PROCESS. Extensions run in-process without isolation; an updater
// fault must never take OMP down. At start the child is spawned from a managed
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
// apply error degrade to a log entry, warning, or report line; the session is
// unaffected.
// ============================================================================

const SCRIPT = "omp-config-update.ts";
const SWITCH_FILE = "omp-config-autoupdate.json";
const REPORT_TYPE = "omp-config-update";

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

/** Mirrors ApplyReport in omp-config-update.ts. */
type ApplyReport = {
	readonly written: readonly string[];
	readonly deleted: readonly string[];
	readonly skipped: readonly { readonly path: string; readonly reason: string }[];
	readonly errors: readonly string[];
	readonly notes: readonly string[];
	readonly pluginsInstalled: readonly string[];
	readonly pluginsMissing: readonly string[];
	readonly restartNeeded: boolean;
};

/** Mirrors AutoResult in omp-config-update.ts; JSON drops an undefined `previous`. */
type AutoResult =
	| { readonly kind: "busy" }
	| { readonly kind: "offline"; readonly error: string }
	| { readonly kind: "up-to-date"; readonly commit: string }
	| { readonly kind: "applied"; readonly commit: string; readonly previous?: string; readonly report: ApplyReport }
	| { readonly kind: "failed"; readonly error: string };

/** Everything one updater run can end in, including not getting to run it. */
type RunOutcome =
	| { readonly kind: "no-script"; readonly script: string }
	| { readonly kind: "no-bun" }
	| { readonly kind: "no-result"; readonly code: number | null; readonly stderr: string }
	| { readonly kind: "result"; readonly result: AutoResult };

/** One automatic run per process: child sessions share this module and must not re-run it. */
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

async function runUpdater(agentDir: string): Promise<RunOutcome> {
	const script = join(agentDir, SCRIPT);
	if (!existsSync(script)) return { kind: "no-script", script };
	const bun = Bun.which("bun");
	if (!bun) return { kind: "no-bun" };
	const run = await runChild(bun, script, agentDir);
	const result = parseResult(run.stdout);
	return result ? { kind: "result", result } : { kind: "no-result", code: run.code, stderr: run.stderr.trim() };
}

const short = (commit: string): string => commit.slice(0, 7);

function section(title: string, items: readonly string[]): string[] {
	return items.length === 0 ? [] : ["", `## ${title} (${items.length})`, ...items.map(item => `- \`${item}\``)];
}

/** Markdown report of one manual run: every path and message the updater returned. */
function detailedReport(outcome: RunOutcome, agentDir: string): string {
	const head = ["# omp-config update", "", `- **Agent dir:** \`${agentDir}\``];
	switch (outcome.kind) {
		case "no-script":
			return [...head, `- **Result:** not run: \`${outcome.script}\` is missing. Run \`/update-omp\` once from the omp-config checkout to install the updater.`].join("\n");
		case "no-bun":
			return [...head, "- **Result:** not run: `bun` is not on PATH."].join("\n");
		case "no-result":
			return [...head, `- **Result:** the updater exited ${outcome.code} without a result.`, "", "```", outcome.stderr || "(no stderr)", "```"].join("\n");
		case "result":
			break;
	}
	const result = outcome.result;
	switch (result.kind) {
		case "busy":
			return [...head, "- **Result:** skipped: another update holds `~/.omp/omp-config-update.lock`. Retry when it finishes."].join("\n");
		case "offline":
			return [...head, "- **Result:** not updated: fetching GitHub failed, so nothing was compared or applied.", "", "```", result.error, "```"].join("\n");
		case "failed":
			return [...head, "- **Result:** failed; nothing was recorded as applied.", "", "```", result.error, "```"].join("\n");
		case "up-to-date":
			return [...head, `- **Result:** up to date at \`${short(result.commit)}\` (\`${result.commit}\`); nothing applied.`].join("\n");
		case "applied": {
			const { report } = result;
			const changed = report.written.length + report.deleted.length + report.pluginsInstalled.length;
			const outcomeLine =
				report.errors.length > 0
					? `applied with ${report.errors.length} error(s); the applied commit is not recorded, so the next run retries`
					: changed === 0
						? "applied; this machine already matched, nothing written"
						: "updated";
			const lines = [
				...head,
				`- **Result:** ${outcomeLine}`,
				`- **Commit:** ${result.previous ? `\`${short(result.previous)}\` → ` : "(no previous record) → "}\`${short(result.commit)}\` (\`${result.commit}\`)`,
				`- **Restart needed:** ${report.restartNeeded ? "yes — extensions, APPEND_SYSTEM.md or plugins changed" : "no"}`,
				...section("Errors", report.errors),
				...section("Written", report.written),
				...section("Deleted", report.deleted),
				...section("Skipped", report.skipped.map(entry => `${entry.path}\` — \`${entry.reason}`)),
				...section("Plugins installed", report.pluginsInstalled),
				...section("Plugins still missing", report.pluginsMissing),
				...section("Notes", report.notes),
			];
			return lines.join("\n");
		}
	}
}

export default function ompConfigAutoupdate(pi: ExtensionAPI): void {
	const notify = (ctx: ExtensionContext, text: string, level: "info" | "warning"): void => {
		if (ctx.hasUI) ctx.ui.notify(text, level);
		if (level === "warning") pi.logger.warn(text);
		else pi.logger.info(text);
	};

	pi.registerCommand("omp-config-autoupdate", {
		description: "omp-config auto-update: /omp-config-autoupdate [status|on|off|run] (run = update from GitHub now and show the full report)",
		getArgumentCompletions: prefix => {
			const matches = ["status", "on", "off", "run"].filter(value => value.startsWith(prefix.trim().toLowerCase())).map(value => ({ value, label: value }));
			return matches.length ? matches : null;
		},
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase() || "status";
			const path = join(getAgentDir(), SWITCH_FILE);
			if (action === "run") {
				const agentDir = getAgentDir();
				ctx.ui.notify("omp-config: updating from GitHub…", "info");
				const outcome = await runUpdater(agentDir);
				await ctx.waitForIdle();
				pi.sendMessage({ customType: REPORT_TYPE, content: detailedReport(outcome, agentDir), display: true, attribution: "agent" }, { triggerTurn: false });
				return;
			}
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
				ctx.ui.notify("Usage: /omp-config-autoupdate [status|on|off|run]", "warning");
				return;
			}
			const state = readSwitch(path);
			switch (state.kind) {
				case "on":
					ctx.ui.notify(`omp-config: auto-update is on (${path}); /omp-config-autoupdate run updates now`, "info");
					return;
				case "off":
					ctx.ui.notify(`omp-config: auto-update is off (${path}); enable with /omp-config-autoupdate on, or update once now with /omp-config-autoupdate run`, "info");
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
			const outcome = await runUpdater(getAgentDir());
			switch (outcome.kind) {
				case "no-script":
					notify(ctx, `omp-config: ${outcome.script} missing; run /update-omp once to install the updater`, "warning");
					return;
				case "no-bun":
					notify(ctx, "omp-config: bun is not on PATH; auto-update skipped", "warning");
					return;
				case "no-result":
					notify(ctx, `omp-config: updater exited ${outcome.code} without a result: ${outcome.stderr.slice(0, 500)}`, "warning");
					return;
				case "result":
					break;
			}
			const result = outcome.result;
			switch (result.kind) {
				case "busy":
					pi.logger.info("omp-config: another update is running; skipped");
					return;
				case "offline":
					pi.logger.info(`omp-config: fetch failed, not updated: ${result.error}`);
					return;
				case "up-to-date":
					pi.logger.info(`omp-config: up to date at ${short(result.commit)}`);
					return;
				case "failed":
					notify(ctx, `omp-config: auto-update failed: ${result.error}`, "warning");
					return;
				case "applied": {
					const { report } = result;
					const changed = report.written.length + report.deleted.length + report.pluginsInstalled.length;
					if (report.errors.length > 0) {
						notify(ctx, `omp-config: applied ${short(result.commit)} with ${report.errors.length} error(s), will retry next start: ${report.errors[0]}; /omp-config-autoupdate run shows the full report`, "warning");
						return;
					}
					if (changed === 0) {
						pi.logger.info(`omp-config: ${short(result.commit)} applied, host already matched`);
						return;
					}
					notify(
						ctx,
						`omp-config: updated to ${short(result.commit)} (${report.written.length} written, ${report.deleted.length} deleted, ${report.pluginsInstalled.length} plugin(s) installed)${report.restartNeeded ? "; restart OMP to load extensions/APPEND_SYSTEM/plugins" : ""}`,
						"info",
					);
					return;
				}
			}
		}, 0);
	});
}
