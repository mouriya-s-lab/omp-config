#!/usr/bin/env bun

// ============================================================================
// omp-config-update — apply the omp-config repo snapshot to an OMP agent dir.
//
// TWO ENTRY POINTS, ONE APPLY.
//   auto   Run by extensions/omp-config-autoupdate.ts at OMP start when the
//          machine's switch is on (`/omp-config-autoupdate on`; off by default).
//          Refreshes the updater-owned clone (~/.omp/omp-config-src) from
//          origin, and applies only when the fetch succeeds and its commit
//          differs from the commit last applied to this agent dir
//          (`<agent dir>/.omp-config-applied`). A failed fetch (offline)
//          applies nothing: the clone is a copy of origin as of the last
//          fetch, never a stand-in for it.
//          The apply code is imported from the freshly fetched clone, so a
//          commit that changes apply rules is applied by its own rules.
//   apply  Run by /update-omp against a working checkout (`--source`).
//          `--check` reports without writing.
//
// AUTHORITY. The repo owns the managed items listed in `managedPlain` and
// `STRUCTURED`; for those it wins outright, host edits included. Everything
// else under the agent dir belongs to the host and is never touched:
//   - config.yml keys outside the repo, and LOCAL_CONFIG_FIELDS even when
//     the repo has them (absence on the host stays absence);
//   - keys a structured file has only on the host;
//   - files not in the managed set (extra extensions, agents, templates,
//     doc-polish.json, runtime state);
//   - app-managed files (`// @orca-managed-pi-extension` first line, or the
//     Otty marker anywhere; see OTTY_MARKER), checked before every overwrite
//     and delete;
//   - symlinks: a symlinked target is written through to its resolved file.
//
// DELETIONS. Only in `auto`, and only what git says the repo dropped between
// the applied commit and the new one: managed files deleted in that range,
// and structured keys present in the old repo version but not the new one
// (a dropped map loses only the repo's old keys; it is removed only if that
// leaves it empty). Without the old commit (first run, gc'd object) nothing
// is deleted.
//
// SAFETY. Every structured source must parse to a mapping before any write;
// one invalid source aborts the whole apply. A host structured file that does
// not parse is left untouched and reported as an error. Writes go to a temp file in the
// target's directory and are renamed over it. Order: plain files, JSON,
// config.yml, deletions. Any error leaves the applied marker unchanged, so
// the next start retries. A lock dir (~/.omp/omp-config-update.lock) keeps
// concurrent OMP starts and /update-omp from refreshing or applying at once;
// the loser skips. The lock records its holder's pid: a dead holder's lock is
// taken over, and a process only releases a lock it holds.
//
// PLUGINS. Entries of install-plugins.sh missing from
// ~/.omp/plugins/package.json are installed with `omp install`. Nothing is
// ever uninstalled here; /update-omp handles uninstall candidates.
// ============================================================================

import { spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readlinkSync,
	readFileSync,
	readdirSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const REPO_URL = "https://github.com/mouriya-s-lab/omp-config.git";
export const DEFAULT_BRANCH = "master";
export const APPLIED_MARKER = ".omp-config-applied";

/**
 * config.yml paths owned by each machine: never written from the repo, never
 * removed. /sync-omp-config keeps the repo's values for the same paths.
 */
export const LOCAL_CONFIG_FIELDS: readonly string[] = [
	"providers.webSearchOrder",
	"modelRoles",
	"defaultThinkingLevel",
	"skills",
	"symbolPreset",
	"theme",
	"colorBlindMode",
	"hideThinkingBlock",
	"statusLine",
	"terminal",
	"tui",
	"display",
	"worktree",
	"compaction.thresholdTokens",
];

type Format = "json" | "yaml";

interface StructuredItem {
	readonly rel: string;
	readonly format: Format;
	readonly localFields: readonly string[];
}

/** Structured files, in apply order: config.yml last (it is live-reloaded). */
const STRUCTURED: readonly StructuredItem[] = [
	{ rel: "agent/settings.json", format: "json", localFields: [] },
	{ rel: "agent/thinking-translator.json", format: "json", localFields: [] },
	{ rel: "agent/system-prompt-replace.json", format: "json", localFields: [] },
	{ rel: "agent/extensions/lang-nag.json", format: "json", localFields: [] },
	{ rel: "agent/extensions/input-polish.json", format: "json", localFields: [] },
	{ rel: "pi/agent/pi-bansos-relay-state.json", format: "json", localFields: [] },
	{ rel: "agent/config.yml", format: "yaml", localFields: LOCAL_CONFIG_FIELDS },
];

/** Repo files copied verbatim. `rel` uses `/` separators. */
function managedPlain(rel: string): boolean {
	if (rel.split("/").some(part => part.startsWith("."))) return false;
	return (
		/^agent\/(APPEND_SYSTEM|APPEND_SYSTEM_MODEL|APPEND_SYSTEM_LIGHT)\.md$/.test(rel) ||
		/^agent\/PROMPT-INJECT-[^/]+\.md$/.test(rel) ||
		/^agent\/(config-light\.yml|omp-light\.ts|omp-config-update\.ts)$/.test(rel) ||
		/^agent\/agents\/.+$/.test(rel) ||
		/^agent\/(extensions|extensions-last)\/[^/]+\.ts$/.test(rel)
	);
}

const RESTART_SCOPED = /^agent\/(APPEND_SYSTEM\.md|extensions\/.+\.ts|extensions-last\/.+\.ts)$/;

// --- report -----------------------------------------------------------------

export interface ApplyOptions {
	readonly source: string;
	readonly agentDir: string;
	/** Commit last applied to agentDir; enables git-derived deletions. */
	readonly previousCommit: string | undefined;
	readonly check: boolean;
	readonly plugins: boolean;
}

export interface ApplyReport {
	readonly written: string[];
	readonly deleted: string[];
	readonly skipped: { path: string; reason: string }[];
	readonly errors: string[];
	readonly notes: string[];
	readonly pluginsInstalled: string[];
	readonly pluginsMissing: string[];
	restartNeeded: boolean;
}

export type AutoResult =
	| { readonly kind: "busy" }
	| { readonly kind: "offline"; readonly error: string }
	| { readonly kind: "up-to-date"; readonly commit: string }
	| { readonly kind: "applied"; readonly commit: string; readonly previous: string | undefined; readonly report: ApplyReport }
	| { readonly kind: "failed"; readonly error: string };

// --- small helpers ----------------------------------------------------------

type Mapping = Record<string, unknown>;

function isMapping(value: unknown): value is Mapping {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function git(cwd: string, args: readonly string[]): { ok: true; out: string } | { ok: false; err: string } {
	const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
	if (result.error) return { ok: false, err: result.error.message };
	if (result.status !== 0) return { ok: false, err: (result.stderr || result.stdout).trim() || `git ${args[0]} exited ${result.status}` };
	return { ok: true, out: result.stdout };
}

function parseStructured(text: string, format: Format): Mapping {
	const value: unknown = format === "json" ? JSON.parse(text) : Bun.YAML.parse(text);
	if (!isMapping(value)) throw new Error("root is not a mapping");
	return value;
}

function serialize(value: Mapping, format: Format): string {
	// Bun.YAML.stringify leaves "key: " before nested blocks; drop that space. The
	// round-trip check below rejects the result if this ever changes a value.
	const text = format === "json" ? `${JSON.stringify(value, null, 2)}\n` : Bun.YAML.stringify(value, null, 2).replace(/:[ ]+$/gm, ":");
	const back = parseStructured(text, format);
	if (!Bun.deepEquals(back, value)) throw new Error("serialized form does not round-trip");
	return text.endsWith("\n") ? text : `${text}\n`;
}

function targetOf(rel: string, agentDir: string): string {
	if (rel.startsWith("agent/")) return join(agentDir, rel.slice("agent/".length));
	if (rel.startsWith("pi/agent/")) return join(homedir(), ".pi", "agent", rel.slice("pi/agent/".length));
	throw new Error(`no target for ${rel}`);
}

/**
 * Otty's "marker" + ": _otty" tag, assembled so the literal never appears in
 * this file: the check matches anywhere, and this file is itself managed.
 */
const OTTY_MARKER = ["marker:", "_otty"].join(" ");

function isAppManaged(path: string): boolean {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		return false;
	}
	return text.split("\n", 1)[0]?.trim() === "// @orca-managed-pi-extension" || text.includes(OTTY_MARKER);
}

/**
 * Resolve a symlinked target to the file it points at, so the link survives.
 * A dangling link resolves through readlink, so writing recreates its target.
 */
function writePath(target: string): string {
	let link = false;
	try {
		link = lstatSync(target).isSymbolicLink();
	} catch {
		// Missing target: write it in place.
	}
	if (!link) return target;
	try {
		return realpathSync(target);
	} catch {
		return resolve(dirname(target), readlinkSync(target));
	}
}

function atomicWrite(target: string, content: string | Uint8Array, mode?: number): void {
	const path = writePath(target);
	mkdirSync(dirname(path), { recursive: true });
	const tmp = join(dirname(path), `.${basename(path)}.omp-config-update-${process.pid}.tmp`);
	try {
		writeFileSync(tmp, content);
		const keepMode = mode ?? (existsSync(path) ? statSync(path).mode & 0o777 : undefined);
		if (keepMode !== undefined) chmodSync(tmp, keepMode);
		renameSync(tmp, path);
	} catch (error) {
		rmSync(tmp, { force: true });
		throw error;
	}
}

// --- structured merge -------------------------------------------------------

function pathIsLocal(path: readonly string[], localFields: readonly string[]): boolean {
	const joined = path.join(".");
	return localFields.some(field => joined === field || joined.startsWith(`${field}.`));
}

/** Repo values win key by key; host-only keys and local fields stay as they are. */
function overlay(host: unknown, repo: Mapping, localFields: readonly string[], path: readonly string[]): Mapping {
	// Deep copy: removeDropped later mutates nested maps, which must not alias the host's.
	const result: Mapping = isMapping(host) ? structuredClone(host) : {};
	for (const [key, value] of Object.entries(repo)) {
		const keyPath = [...path, key];
		if (pathIsLocal(keyPath, localFields)) continue;
		if (isMapping(value)) {
			result[key] = overlay(result[key], value, localFields, keyPath);
			continue;
		}
		// A non-map would wipe a local field nested under this key; the host's map stays.
		const prefix = `${keyPath.join(".")}.`;
		if (isMapping(result[key]) && localFields.some(field => field.startsWith(prefix))) continue;
		result[key] = structuredClone(value);
	}
	return result;
}

/** Remove from `host` the keys the repo had in `oldRepo` and dropped in `newRepo`. */
function removeDropped(host: Mapping, oldRepo: Mapping, newRepo: Mapping, localFields: readonly string[], path: readonly string[]): void {
	for (const [key, oldValue] of Object.entries(oldRepo)) {
		const keyPath = [...path, key];
		if (pathIsLocal(keyPath, localFields)) continue;
		const current = host[key];
		if (!(key in newRepo)) {
			// A dropped map loses only the keys the repo had; host-only and local keys under it stay.
			if (isMapping(oldValue) && isMapping(current)) {
				removeDropped(current, oldValue, {}, localFields, keyPath);
				if (Object.keys(current).length === 0) delete host[key];
			} else if (!isMapping(current)) {
				// The repo had a value here; a map in its place is the host's own and stays.
				delete host[key];
			}
			continue;
		}
		const next = newRepo[key];
		if (isMapping(oldValue) && isMapping(next) && isMapping(current)) removeDropped(current, oldValue, next, localFields, keyPath);
	}
}

// --- plan -------------------------------------------------------------------

type Op =
	| { readonly kind: "write"; readonly rel: string; readonly target: string; readonly content: string | Uint8Array }
	| { readonly kind: "delete"; readonly rel: string; readonly target: string };

function listSourceFiles(source: string): string[] {
	const root = join(source, "agent");
	const entries = readdirSync(root, { recursive: true, withFileTypes: true });
	const files: string[] = [];
	for (const entry of entries) {
		if (!entry.isFile()) continue;
		const abs = join(entry.parentPath, entry.name);
		const rel = `agent/${abs.slice(root.length + 1).split("\\").join("/")}`;
		if (managedPlain(rel)) files.push(rel);
	}
	return files.sort();
}

function oldRepoText(opts: ApplyOptions, rel: string): string | undefined {
	if (opts.previousCommit === undefined) return undefined;
	const shown = git(opts.source, ["show", `${opts.previousCommit}:${rel}`]);
	return shown.ok ? shown.out : undefined;
}

function planPlain(opts: ApplyOptions, report: ApplyReport): Op[] {
	const ops: Op[] = [];
	for (const rel of listSourceFiles(opts.source)) {
		const target = targetOf(rel, opts.agentDir);
		const content = readFileSync(join(opts.source, rel));
		if (existsSync(target)) {
			if (isAppManaged(target)) {
				report.skipped.push({ path: target, reason: "app-managed" });
				continue;
			}
			if (Buffer.from(readFileSync(target)).equals(content)) continue;
		}
		ops.push({ kind: "write", rel, target, content });
	}
	return ops;
}

function planStructured(opts: ApplyOptions, report: ApplyReport): Op[] {
	// Parse every source first: one invalid source aborts the whole apply.
	const sources: { item: StructuredItem; text: string; repo: Mapping }[] = [];
	for (const item of STRUCTURED) {
		const sourcePath = join(opts.source, item.rel);
		if (!existsSync(sourcePath)) {
			report.notes.push(`${item.rel}: not in source, host copy left alone`);
			continue;
		}
		const text = readFileSync(sourcePath, "utf8");
		try {
			sources.push({ item, text, repo: parseStructured(text, item.format) });
		} catch (error) {
			throw new Error(`${item.rel}: invalid ${item.format} (${errorText(error)}); nothing applied`);
		}
	}
	const lightPath = join(opts.source, "agent/config-light.yml");
	if (existsSync(lightPath)) {
		try {
			parseStructured(readFileSync(lightPath, "utf8"), "yaml");
		} catch (error) {
			throw new Error(`agent/config-light.yml: invalid yaml (${errorText(error)}); nothing applied`);
		}
	}

	const ops: Op[] = [];
	for (const { item, text, repo } of sources) {
		const target = targetOf(item.rel, opts.agentDir);
		let host: Mapping | undefined;
		if (existsSync(target)) {
			if (isAppManaged(target)) {
				report.skipped.push({ path: target, reason: "app-managed" });
				continue;
			}
			try {
				host = parseStructured(readFileSync(target, "utf8"), item.format);
			} catch (error) {
				// Replacing it would drop the host's local fields; leave it and retry next start.
				report.errors.push(`${target}: host copy unparsable (${errorText(error)}); left untouched`);
				continue;
			}
		}
		const merged = overlay(host, repo, item.localFields, []);
		const oldText = oldRepoText(opts, item.rel);
		if (oldText !== undefined) {
			try {
				removeDropped(merged, parseStructured(oldText, item.format), repo, item.localFields, []);
			} catch {
				report.notes.push(`${item.rel}: previous version unparsable, no keys removed`);
			}
		}
		if (host !== undefined && Bun.deepEquals(host, merged)) continue;
		// Keep the repo's own formatting whenever the result is exactly the repo file.
		const content = Bun.deepEquals(merged, repo) ? text : serialize(merged, item.format);
		ops.push({ kind: "write", rel: item.rel, target, content });
	}
	return ops;
}

function planDeletions(opts: ApplyOptions, report: ApplyReport): Op[] {
	if (opts.previousCommit === undefined) return [];
	// -z: NUL-separated, unquoted paths (non-ASCII names are C-quoted otherwise).
	const diff = git(opts.source, ["diff", "-z", "--no-renames", "--name-only", "--diff-filter=D", opts.previousCommit, "HEAD", "--", "agent"]);
	if (!diff.ok) {
		report.notes.push(`deletions skipped: ${diff.err}`);
		return [];
	}
	const ops: Op[] = [];
	for (const rel of diff.out.split("\0").filter(Boolean)) {
		if (!managedPlain(rel)) continue;
		const target = targetOf(rel, opts.agentDir);
		try {
			lstatSync(target);
		} catch {
			continue;
		}
		if (isAppManaged(target)) {
			report.skipped.push({ path: target, reason: "app-managed" });
			continue;
		}
		ops.push({ kind: "delete", rel, target });
	}
	return ops;
}

// --- light launcher -----------------------------------------------------------

function installLauncher(opts: ApplyOptions, report: ApplyReport): void {
	const sourcePath = join(opts.source, "agent/omp-light.ts");
	if (!existsSync(sourcePath)) return;
	const found = Bun.which("omp");
	if (!found) {
		report.errors.push("omp-light not installed: omp is not on PATH");
		return;
	}
	const binDir = dirname(resolve(found));
	const script = readFileSync(sourcePath);
	const windows = process.platform === "win32";
	const wanted: { path: string; content: string | Uint8Array; mode: number | undefined }[] = windows
		? [
				{ path: join(binDir, "omp-light.ts"), content: script, mode: undefined },
				{ path: join(binDir, "omp-light.cmd"), content: '@echo off\r\nbun "%~dp0omp-light.ts" %*\r\n', mode: undefined },
			]
		: [{ path: join(binDir, "omp-light"), content: script, mode: 0o755 }];
	for (const file of wanted) {
		const bytes = typeof file.content === "string" ? Buffer.from(file.content) : file.content;
		const same =
			existsSync(file.path) &&
			Buffer.from(readFileSync(file.path)).equals(bytes) &&
			(file.mode === undefined || (statSync(file.path).mode & 0o777) === file.mode);
		if (same) continue;
		if (opts.check) {
			report.written.push(file.path);
			continue;
		}
		try {
			atomicWrite(file.path, bytes, file.mode);
			report.written.push(file.path);
		} catch (error) {
			report.errors.push(`${file.path}: ${errorText(error)}`);
		}
	}
	const resolved = Bun.which("omp-light");
	const expected = wanted[windows ? 1 : 0]!.path;
	if (!opts.check && resolved && resolve(resolved).toLowerCase() !== expected.toLowerCase()) {
		report.notes.push(`omp-light on PATH resolves to ${resolved}, not ${expected} (PATH shadowing)`);
	}
}

// --- plugins ------------------------------------------------------------------

function declaredPlugins(source: string): string[] {
	const path = join(source, "install-plugins.sh");
	if (!existsSync(path)) return [];
	const specs: string[] = [];
	let inside = false;
	for (const line of readFileSync(path, "utf8").split("\n")) {
		if (/^\s*plugins=\(/.test(line)) {
			inside = true;
			continue;
		}
		if (inside && /^\s*\)/.test(line)) break;
		const match = inside ? /^\s*'([^']+)'/.exec(line) : null;
		if (match) specs.push(match[1]!);
	}
	return specs;
}

function installedPluginSpecs(): { names: Set<string>; values: Set<string> } {
	const path = join(homedir(), ".omp", "plugins", "package.json");
	const names = new Set<string>();
	const values = new Set<string>();
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		const deps = isMapping(parsed) && isMapping(parsed.dependencies) ? parsed.dependencies : {};
		for (const [name, value] of Object.entries(deps)) {
			names.add(name);
			// Strip `#ref`: a host install pinned to a branch or commit still counts as installed.
			if (typeof value === "string") values.add(value.split("#", 1)[0]!);
		}
	} catch {
		// No plugins installed yet.
	}
	return { names, values };
}

function npmName(spec: string): string {
	if (spec.startsWith("@")) {
		const at = spec.indexOf("@", 1);
		return at === -1 ? spec : spec.slice(0, at);
	}
	const at = spec.indexOf("@");
	return at === -1 ? spec : spec.slice(0, at);
}

function syncPlugins(opts: ApplyOptions, report: ApplyReport): void {
	const installed = installedPluginSpecs();
	const missing = declaredPlugins(opts.source).filter(spec =>
		spec.includes("://") ? !installed.values.has(spec.split("#", 1)[0]!) : !installed.names.has(npmName(spec)),
	);
	if (missing.length === 0) return;
	if (opts.check || !opts.plugins) {
		report.pluginsMissing.push(...missing);
		return;
	}
	const omp = Bun.which("omp");
	if (!omp) {
		report.pluginsMissing.push(...missing);
		report.errors.push("plugins not installed: omp is not on PATH");
		return;
	}
	for (const spec of missing) {
		const result = spawnSync(omp, ["install", spec], { encoding: "utf8" });
		if (result.status === 0) {
			report.pluginsInstalled.push(spec);
			report.restartNeeded = true;
		} else {
			report.pluginsMissing.push(spec);
			report.errors.push(`omp install ${spec}: ${(result.stderr || result.stdout || result.error?.message || "").trim()}`);
		}
	}
}

// --- apply ------------------------------------------------------------------

export async function applySnapshot(opts: ApplyOptions): Promise<ApplyReport> {
	const report: ApplyReport = { written: [], deleted: [], skipped: [], errors: [], notes: [], pluginsInstalled: [], pluginsMissing: [], restartNeeded: false };
	let ops: Op[];
	try {
		ops = [...planPlain(opts, report), ...planStructured(opts, report), ...planDeletions(opts, report)];
	} catch (error) {
		report.errors.push(errorText(error));
		return report;
	}
	for (const op of ops) {
		if (RESTART_SCOPED.test(op.rel)) report.restartNeeded = true;
		if (opts.check) {
			(op.kind === "write" ? report.written : report.deleted).push(op.target);
			continue;
		}
		try {
			if (op.kind === "write") {
				atomicWrite(op.target, op.content);
				report.written.push(op.target);
			} else {
				// Remove the managed entry itself; a symlink's backing file is not ours.
				unlinkSync(op.target);
				report.deleted.push(op.target);
			}
		} catch (error) {
			report.errors.push(`${op.target}: ${errorText(error)}`);
		}
	}
	installLauncher(opts, report);
	syncPlugins(opts, report);
	return report;
}

// --- lock -------------------------------------------------------------------

const LOCK_DIR = join(homedir(), ".omp", "omp-config-update.lock");
const LOCK_OWNER = join(LOCK_DIR, "pid");
/** A lock dir without a pid file is a holder that died between mkdir and write. */
const LOCK_ORPHAN_MS = 60 * 1000;

/** The lock belongs to a running process; a dead holder's lock is stale. */
function lockHolderAlive(): boolean {
	let pid: number;
	try {
		pid = Number(readFileSync(LOCK_OWNER, "utf8"));
	} catch {
		return Date.now() - statSync(LOCK_DIR).mtimeMs < LOCK_ORPHAN_MS;
	}
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function acquireLock(): boolean {
	// ~/.omp may not exist yet (agent dir elsewhere); a missing parent is not a held lock.
	mkdirSync(dirname(LOCK_DIR), { recursive: true });
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			mkdirSync(LOCK_DIR);
			writeFileSync(LOCK_OWNER, String(process.pid));
			return true;
		} catch {
			try {
				if (lockHolderAlive()) return false;
				rmSync(LOCK_DIR, { recursive: true, force: true });
			} catch {
				// Lock vanished between attempts; retry.
			}
		}
	}
	return false;
}

/** Release only a lock this process holds, never one taken over after it. */
function releaseLock(): void {
	try {
		if (Number(readFileSync(LOCK_OWNER, "utf8")) !== process.pid) return;
	} catch {
		return;
	}
	rmSync(LOCK_DIR, { recursive: true, force: true });
}

// --- auto -------------------------------------------------------------------

const CLONE_DIR = join(homedir(), ".omp", "omp-config-src");

/** Fetch `branch` into the updater-owned clone; returns the clone or fetch error, if any. */
function refreshClone(branch: string): string | undefined {
	if (!existsSync(CLONE_DIR)) {
		const tmp = `${CLONE_DIR}.tmp-${process.pid}`;
		rmSync(tmp, { recursive: true, force: true });
		const cloned = spawnSync("git", ["clone", "--quiet", "--depth", "1", "--branch", branch, REPO_URL, tmp], { encoding: "utf8" });
		if (cloned.status !== 0) {
			rmSync(tmp, { recursive: true, force: true });
			return `git clone failed: ${(cloned.stderr || cloned.error?.message || "").trim()}`;
		}
		renameSync(tmp, CLONE_DIR);
		return undefined;
	}
	const origin = git(CLONE_DIR, ["remote", "get-url", "origin"]);
	if (!origin.ok || origin.out.trim() !== REPO_URL) {
		throw new Error(`${CLONE_DIR} is not an updater clone of ${REPO_URL}; left untouched`);
	}
	const fetched = git(CLONE_DIR, ["fetch", "--quiet", "--depth", "1", "origin", branch]);
	if (!fetched.ok) return fetched.err;
	const reset = git(CLONE_DIR, ["reset", "--quiet", "--hard", "FETCH_HEAD"]);
	if (!reset.ok) throw new Error(`git reset failed: ${reset.err}`);
	return undefined;
}

export async function runAuto(agentDir: string, branch: string): Promise<AutoResult> {
	if (!acquireLock()) return { kind: "busy" };
	try {
		const fetchError = refreshClone(branch);
		if (fetchError !== undefined) return { kind: "offline", error: fetchError };
		const head = git(CLONE_DIR, ["rev-parse", "HEAD"]);
		if (!head.ok) return { kind: "failed", error: head.err };
		const commit = head.out.trim();
		const markerPath = join(agentDir, APPLIED_MARKER);
		const applied = existsSync(markerPath) ? readFileSync(markerPath, "utf8").trim() : "";
		if (applied === commit) return { kind: "up-to-date", commit };
		const previousCommit = applied && git(CLONE_DIR, ["cat-file", "-e", `${applied}^{commit}`]).ok ? applied : undefined;
		// Apply with the fetched commit's own rules. Dynamic import is required:
		// the module is the just-fetched clone's copy, chosen at runtime, not this file.
		const fetchedUpdater = join(CLONE_DIR, "agent", "omp-config-update.ts");
		if (!existsSync(fetchedUpdater)) return { kind: "failed", error: `${branch} at ${commit.slice(0, 7)} has no agent/omp-config-update.ts; nothing applied` };
		const fetched: { applySnapshot?: typeof applySnapshot } = await import(pathToFileURL(fetchedUpdater).href);
		if (typeof fetched.applySnapshot !== "function") return { kind: "failed", error: "fetched omp-config-update.ts exports no applySnapshot" };
		const report = await fetched.applySnapshot({ source: CLONE_DIR, agentDir, previousCommit, check: false, plugins: true });
		if (applied && previousCommit === undefined) report.notes.push(`previous commit ${applied} unavailable, no deletions`);
		if (report.errors.length === 0) atomicWrite(markerPath, `${commit}\n`);
		return { kind: "applied", commit, previous: applied || undefined, report };
	} catch (error) {
		return { kind: "failed", error: errorText(error) };
	} finally {
		releaseLock();
	}
}

// --- CLI ----------------------------------------------------------------------

function formatReport(report: ApplyReport, check: boolean): string {
	const lines: string[] = [];
	const verb = check ? "would write" : "wrote";
	for (const path of report.written) lines.push(`${verb}: ${path}`);
	for (const path of report.deleted) lines.push(`${check ? "would delete" : "deleted"}: ${path}`);
	for (const { path, reason } of report.skipped) lines.push(`skipped (${reason}): ${path}`);
	for (const spec of report.pluginsInstalled) lines.push(`plugin installed: ${spec}`);
	for (const spec of report.pluginsMissing) lines.push(`plugin missing: ${spec}`);
	for (const note of report.notes) lines.push(`note: ${note}`);
	for (const error of report.errors) lines.push(`error: ${error}`);
	if (report.written.length + report.deleted.length === 0) lines.push("no file changes");
	if (report.restartNeeded) lines.push("restart OMP: APPEND_SYSTEM.md, extensions or plugins changed");
	return lines.join("\n");
}

function usage(): never {
	process.stderr.write(
		"usage:\n  omp-config-update.ts auto [--agent-dir DIR] [--branch NAME] [--json]\n  omp-config-update.ts apply --source DIR [--agent-dir DIR] [--check] [--no-plugins] [--json]\n",
	);
	process.exit(2);
}

async function main(argv: readonly string[]): Promise<number> {
	const [mode, ...rest] = argv;
	let agentDir = resolve(process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".omp", "agent"));
	let branch = DEFAULT_BRANCH;
	let source: string | undefined;
	let check = false;
	let plugins = true;
	let json = false;
	for (let i = 0; i < rest.length; i++) {
		const arg = rest[i];
		const value = (): string => rest[++i] ?? usage();
		if (arg === "--agent-dir") agentDir = resolve(value());
		else if (arg === "--branch") branch = value();
		else if (arg === "--source") source = resolve(value());
		else if (arg === "--check") check = true;
		else if (arg === "--no-plugins") plugins = false;
		else if (arg === "--json") json = true;
		else usage();
	}
	if (mode === "auto") {
		const result = await runAuto(agentDir, branch);
		if (json) process.stdout.write(`${JSON.stringify(result)}\n`);
		else if (result.kind === "applied") process.stdout.write(`applied ${result.commit}\n${formatReport(result.report, false)}\n`);
		else process.stdout.write(`${result.kind}${"commit" in result ? ` ${result.commit}` : ""}${"error" in result ? `: ${result.error}` : ""}\n`);
		return result.kind === "failed" || (result.kind === "applied" && result.report.errors.length > 0) ? 1 : 0;
	}
	if (mode === "apply") {
		if (source === undefined) usage();
		// --check only reads, so it neither takes nor waits for the lock.
		if (!check && !acquireLock()) {
			process.stderr.write(`another update holds ${LOCK_DIR}; retry later\n`);
			return 1;
		}
		try {
			const report = await applySnapshot({ source, agentDir, previousCommit: undefined, check, plugins });
			process.stdout.write(json ? `${JSON.stringify(report)}\n` : `${formatReport(report, check)}\n`);
			return report.errors.length > 0 ? 1 : 0;
		} finally {
			releaseLock();
		}
	}
	usage();
}

if (import.meta.main) {
	process.exitCode = await main(process.argv.slice(2));
}
