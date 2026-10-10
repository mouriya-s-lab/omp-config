import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { getAgentDir } from "@oh-my-pi/pi-coding-agent";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

// ============================================================================
// omp-config-autoupdate — apply the omp-config repo at every OMP start.
//
// WHAT. Once per process, in the root session's `session_start`, runs
// `bun <agent dir>/omp-config-update.ts auto --agent-dir <agent dir> --json`
// as a child process. That script fetches origin into its own clone and, when
// the fetched commit differs from the one last applied to this agent dir,
// applies it (see the header of omp-config-update.ts for what it touches and
// what it never touches).
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

type ApplyReport = {
	readonly written: readonly string[];
	readonly deleted: readonly string[];
	readonly errors: readonly string[];
	readonly pluginsInstalled: readonly string[];
	readonly restartNeeded: boolean;
};

type AutoResult =
	| { readonly kind: "busy" }
	| { readonly kind: "up-to-date"; readonly commit: string; readonly fetchError?: string }
	| { readonly kind: "applied"; readonly commit: string; readonly fetchError?: string; readonly report: ApplyReport }
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

	pi.on("session_start", (_event, ctx) => {
		if (started || ctx.agent?.parentId) return;
		started = true;
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
				case "up-to-date":
					pi.logger.info(`omp-config: up to date at ${result.commit.slice(0, 7)}${result.fetchError ? ` (fetch failed: ${result.fetchError})` : ""}`);
					return;
				case "failed":
					notify(ctx, `omp-config: auto-update failed: ${result.error}`, "warning");
					return;
				case "applied": {
					const { report } = result;
					// Offline: the applied commit came from the clone's cache, not a fresh fetch.
					const cached = result.fetchError ? ` (from cached clone; fetch failed: ${result.fetchError})` : "";
					const changed = report.written.length + report.deleted.length + report.pluginsInstalled.length;
					if (report.errors.length > 0) {
						notify(ctx, `omp-config: applied ${result.commit.slice(0, 7)}${cached} with ${report.errors.length} error(s), will retry next start: ${report.errors[0]}`, "warning");
						return;
					}
					if (changed === 0) {
						pi.logger.info(`omp-config: ${result.commit.slice(0, 7)} applied${cached}, host already matched`);
						return;
					}
					notify(
						ctx,
						`omp-config: updated to ${result.commit.slice(0, 7)}${cached} (${report.written.length} written, ${report.deleted.length} deleted, ${report.pluginsInstalled.length} plugin(s) installed)${report.restartNeeded ? "; restart OMP to load extensions/APPEND_SYSTEM/plugins" : ""}`,
						"info",
					);
					return;
				}
			}
		}, 0);
	});
}
