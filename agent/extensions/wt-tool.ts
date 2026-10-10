import * as fs from "node:fs/promises";
import * as path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { type ExtensionAPI, type ExtensionContext, InteractiveMode, z } from "@oh-my-pi/pi-coding-agent";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { isUserInterruptAbort } from "@oh-my-pi/pi-coding-agent/session/messages";
import { planWorktreeExit, type SessionWorktree } from "@oh-my-pi/pi-coding-agent/session/session-worktree";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import { cfgWorktreeCleanSource } from "@oh-my-pi/pi-coding-agent/task/settings";
import * as vcs from "@oh-my-pi/pi-natives/vcs";

// ============================================================================
// wt / wt_remove — let the main agent move its session into a new worktree
// and back out of it, which OMP only lets the human do.
//
// `wt` runs the human's `/wt` itself, not a copy: the request is handed to
// `executeBuiltinSlashCommand("/wt [<branch>]", { ctx: <live InteractiveMode> })`,
// the dispatcher the TUI editor submit uses. Everything that path does applies
// unchanged: argument parsing, the collab-guest host-only gate, the vibe-mode
// and /btw gates, settings flush, worktree creation, session move and cwd
// rescope with rollback, `worktree.cleanSource`, the summary line, and
// registration in InteractiveMode's owned worktrees (so `worktree.onExit`
// handles it at exit).
//
// Before queueing, `wt` checks whether the session is already in a linked
// worktree. If it is, the call creates nothing and returns that worktree's
// path, branch, HEAD, uncommitted count, main checkout, what forking from it
// would do, and a `confirm` value (hash of the worktree path and branch).
// Only a second call with that value queues `/wt` anyway.
//
// `wt_remove` removes the linked worktree the session is in and moves the
// session to the main checkout. OMP has no removal command, so only the move
// is the human's (`/move <main checkout>`); the removal is a forced
// `git worktree remove` that keeps the branch. It takes two calls:
//   1. Without `confirm`: a check that changes nothing. It reports what removal
//      would delete (staged, unstaged, untracked, ignored files), the branch
//      commits not reachable from the main checkout's HEAD (the branch is kept
//      either way), and what would block it (running background jobs, running
//      subagents, live subagents whose cwd is in the worktree). It returns a
//      `confirm` value: a hash of the worktree path, branch, upstream's
//      worktree fingerprint (`planWorktreeExit`: HEAD, branch tip, porcelain
//      status, size/mtime of each changed path) and the ignored-file listing.
//   2. With `confirm`: the check runs again and the value must match, so the
//      model can only confirm the state it was shown. The removal is queued.
// When the session is idle the check runs once more before `/move` and once
// more after it; any difference or blocker stops the removal there.
//
// Both tools queue: the human commands refuse while the session is streaming,
// and a tool call always runs while streaming. On a terminal `agent_end` (not
// `willContinue`) the request is armed; a timer waits until the session is
// idle with no queued messages, then runs it once. `agent_start` disarms the
// timer; the next terminal `agent_end` re-arms it. A terminal end interrupted
// by the user (Esc) cancels the request. Session switch and shutdown drop it.
//
// While a human command runs, `showError` / `showWarning` / `showStatus` /
// `present` on the instance are shadowed by recorders that still delegate, so
// the human sees exactly what the command shows and the agent gets the same
// text. `editor.addToHistory` is shadowed by a no-op and `draftDetached` is
// set, so the agent's command neither enters the human's input history nor
// clears the human's draft. The outcome goes back as a custom message
// (`attribution: "agent"`) that starts a turn.
//
// The extension API has no handle on InteractiveMode. `ctx.ui.setEditorComponent`
// in the TUI forwards to `InteractiveMode#setEditorComponent` with the live
// instance as `this`, so the prototype method is swapped for a recorder for
// that one synchronous call and restored before anything else runs; the real
// editor swap never happens.
//
// Relies on omp internals (InteractiveMode's prototype and public members,
// the extension UI context forwarding, `executeBuiltinSlashCommand`, the
// `/wt` and `/move` TUI handlers, `planWorktreeExit`, `AgentRegistry`);
// re-verify in a real TUI after every omp upgrade.
// ============================================================================

const CREATE_TOOL = "wt";
const REMOVE_TOOL = "wt_remove";
const MESSAGE_TYPE = "wt-tool";
const IDLE_POLL_MS = 50;
const LIST_LIMIT = 50;

const CREATE_DESCRIPTION = [
	"Run the user's `/wt` command for this session: fork the current git checkout into a new linked worktree on `branch` (default `wt/<yyyymmdd-hhmmss>`), carry uncommitted changes along, and move this session (cwd and session file) into it.",
	"The command is the same one the user types, so the user's `worktree.*` settings apply, including `worktree.cleanSource` (reset and clean the source checkout after the move) and `worktree.onExit` (what happens to the worktree when the session exits).",
	"When the session is already in a linked worktree, the call creates nothing: it returns that worktree's details and a `confirm` value. Usually keep working there. Only if you still want a new worktree forked from this one, call again with that `confirm` value.",
	"`/wt` cannot run mid-turn: a call that creates only queues it. End your turn right after such a call, without further tool calls; the command runs once the session is idle, and its outcome (new cwd, summary, or the error the user saw) arrives as the next message.",
	"Available only in the main session of the interactive TUI.",
].join("\n");

const REMOVE_DESCRIPTION = [
	"Remove the linked git worktree this session is in and move the session to the repository's main checkout. The branch is always kept.",
	"Two calls. First call it without `confirm`: it only checks, changes nothing, and reports whether removal is safe, every staged, unstaged, untracked and ignored file removal would delete, the branch commits not in the main checkout, anything that blocks removal, and a `confirm` value.",
	"Judge the report yourself. To go ahead, call it again with that `confirm` value; it is valid only while the worktree is exactly as reported. The removal is queued: end your turn right after the call, without further tool calls. Once the session is idle the worktree is checked again, the session moves to the main checkout (the user's `/move`), the worktree is checked a last time and removed; any change or blocker stops it. The outcome arrives as the next message.",
	"Available only in the main session of the interactive TUI.",
].join("\n");

const createParams = z.object({
	branch: z.string().optional().describe("New branch name; omit for the default `wt/<timestamp>`."),
	confirm: z
		.string()
		.optional()
		.describe("Only when the session is already in a linked worktree: the `confirm` value from the previous call, to create a worktree anyway."),
});

const removeParams = z.object({
	confirm: z
		.string()
		.optional()
		.describe("Omit to check. To remove, the `confirm` value from the latest check."),
});

/** What `wt_remove` would do to the worktree at one instant. */
type WorktreeCheck = {
	/** Realpath of the linked worktree root. */
	readonly worktree: string;
	readonly branch: string;
	/** Realpath of the repository's main checkout. */
	readonly mainDir: string;
	/** Binds a confirmation to exactly this state. */
	readonly confirm: string;
	readonly staged: readonly string[];
	readonly unstaged: readonly string[];
	readonly untracked: readonly string[];
	readonly ignored: readonly string[];
	/** `<sha> <subject>` of branch commits not reachable from the main checkout's HEAD. */
	readonly unmergedCommits: readonly string[];
	/** Live users of the worktree that removal would pull it out from under. */
	readonly blockers: readonly string[];
};

type CheckResult = { readonly kind: "ok"; readonly check: WorktreeCheck } | { readonly kind: "error"; readonly reason: string };

type Request =
	| { readonly kind: "create"; readonly sessionId: string; readonly branch: string | undefined }
	| { readonly kind: "remove"; readonly sessionId: string; readonly check: WorktreeCheck };

/** Lifecycle of the one queued request: queued by a tool, armed after a terminal `agent_end`, then run once. */
type State =
	| { readonly kind: "idle" }
	| { readonly kind: "queued"; readonly request: Request }
	| { readonly kind: "armed"; readonly request: Request; readonly timer: Timer }
	| { readonly kind: "running"; readonly request: Request };

type Capture =
	| { readonly kind: "ok"; readonly mode: InteractiveModeContext }
	| { readonly kind: "error"; readonly reason: string };

const requestLabel = (request: Request): string => (request.kind === "create" ? "`/wt`" : "worktree removal");

const isEligible = (ctx: ExtensionContext): boolean => ctx.mode === "tui" && ctx.agent.kind === "main";

const isWithin = (child: string, parent: string): boolean => {
	const rel = path.relative(parent, child);
	return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

const realpathOr = (dir: string): Promise<string> => fs.realpath(dir).catch(() => path.resolve(dir));

/** Live InteractiveMode behind `ctx.ui`, read through one recorded `setEditorComponent` call. */
const captureInteractiveMode = (ctx: ExtensionContext): Capture => {
	const proto = InteractiveMode.prototype;
	const original = Object.getOwnPropertyDescriptor(proto, "setEditorComponent");
	if (typeof original?.value !== "function") {
		return { kind: "error", reason: "InteractiveMode.prototype.setEditorComponent is missing (omp internals changed)." };
	}
	let captured: unknown;
	Object.defineProperty(proto, "setEditorComponent", {
		...original,
		value: function (this: unknown): void {
			captured = this;
		},
	});
	try {
		ctx.ui.setEditorComponent(undefined);
	} finally {
		Object.defineProperty(proto, "setEditorComponent", original);
	}
	if (!(captured instanceof InteractiveMode)) {
		return { kind: "error", reason: "the interactive TUI instance is not reachable from this session." };
	}
	const mode = captured as unknown as InteractiveModeContext;
	if (mode.sessionManager.getSessionId() !== ctx.sessionManager.getSessionId()) {
		return { kind: "error", reason: "the interactive TUI is attached to a different session." };
	}
	return { kind: "ok", mode };
};

/** Shadow `key` on `target` with an own property for the duration of one operation; returns the undo. */
const shadow = <T extends object, K extends keyof T>(target: T, key: K, value: T[K]): (() => void) => {
	const own = Object.getOwnPropertyDescriptor(target, key);
	Object.defineProperty(target, key, { value, configurable: true, writable: true, enumerable: false });
	return () => {
		if (own) Object.defineProperty(target, key, own);
		else delete target[key];
	};
};

const presentedText = (content: unknown): string[] =>
	(Array.isArray(content) ? content : [content]).flatMap(component => {
		const getText = (component as { getText?: unknown } | null)?.getText;
		if (typeof getText !== "function") return [];
		const text = stripVTControlCharacters(String(getText.call(component))).trim();
		return text ? [text] : [];
	});

/** Run a built-in slash command through the TUI dispatcher; returns every line the human was shown. */
const runSlashCommand = async (mode: InteractiveModeContext, text: string): Promise<string[]> => {
	const shown: string[] = [];
	const record = (prefix: string, message: string): void => {
		const line = stripVTControlCharacters(message).trim();
		if (line) shown.push(`${prefix}${line}`);
	};
	const showError = mode.showError;
	const showWarning = mode.showWarning;
	const showStatus = mode.showStatus;
	const present = mode.present;
	const undo = [
		shadow(mode, "showError", message => {
			record("Error: ", message);
			showError.call(mode, message);
		}),
		shadow(mode, "showWarning", (message, options) => {
			record("Warning: ", message);
			showWarning.call(mode, message, options);
		}),
		shadow(mode, "showStatus", (message, options) => {
			record("", message);
			showStatus.call(mode, message, options);
		}),
		shadow(mode, "present", content => {
			shown.push(...presentedText(content));
			present.call(mode, content);
		}),
		shadow(mode.editor, "addToHistory", () => {}),
	];
	try {
		const handled = await executeBuiltinSlashCommand(text, { ctx: mode, draftDetached: true });
		if (handled === false) shown.push(`Error: the built-in ${text.split(" ", 1)[0]} command was not found (omp internals changed).`);
	} catch (error) {
		shown.push(`Error: ${error instanceof Error ? error.message : String(error)}`);
	} finally {
		for (const restore of undo.reverse()) restore();
	}
	return shown;
};

const describeShown = (shown: readonly string[]): string => (shown.length > 0 ? shown.join("\n") : "(it showed nothing)");

const listing = (title: string, items: readonly string[]): string => {
	if (items.length === 0) return `${title}: none`;
	const shownItems = items.slice(0, LIST_LIMIT).map(item => `  ${item}`);
	const rest = items.length > LIST_LIMIT ? [`  … and ${items.length - LIST_LIMIT} more`] : [];
	return [`${title} (${items.length}):`, ...shownItems, ...rest].join("\n");
};

const formatCheck = (check: WorktreeCheck): string => {
	const lost = check.staged.length + check.unstaged.length + check.untracked.length + check.ignored.length;
	const verdict =
		check.blockers.length > 0
			? "BLOCKED: removal would be refused until the blockers below are gone."
			: lost > 0
				? `UNSAFE: removal permanently deletes the ${lost} entr${lost === 1 ? "y" : "ies"} listed below.`
				: "SAFE: no file in the worktree would be lost.";
	return [
		`Worktree: ${check.worktree}`,
		`Branch: ${check.branch} (kept)`,
		`Main checkout (the session moves here): ${check.mainDir}`,
		`Verdict: ${verdict}`,
		listing("Blockers", check.blockers),
		listing("Staged changes (deleted)", check.staged),
		listing("Unstaged changes (deleted)", check.unstaged),
		listing("Untracked files (deleted)", check.untracked),
		listing("Ignored files and directories (deleted)", check.ignored),
		listing(`Commits on ${check.branch} not reachable from the main checkout's HEAD (kept on the branch)`, check.unmergedCommits),
		`confirm: ${check.confirm}`,
	].join("\n");
};

export default function wtTool(pi: ExtensionAPI): void {
	let state: State = { kind: "idle" };

	const git = async (cwd: string, args: string[]): Promise<string> => {
		const result = await pi.exec("git", args, { cwd });
		if (result.code !== 0) throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${result.stderr.trim()}`);
		return result.stdout;
	};

	/** Upstream's worktree fingerprint plus the ignored listing, which upstream's snapshot does not see. */
	const fingerprint = async (worktree: SessionWorktree, ignored: readonly string[]): Promise<string> => {
		const warnings: string[] = [];
		const plan = await planWorktreeExit([worktree], "ask", async () => true, message => warnings.push(message));
		const approved = plan[0]?.approvedFingerprint;
		if (approved === undefined) throw new Error(`could not inspect the worktree: ${warnings.join("; ") || "no snapshot"}`);
		return Bun.hash([worktree.path, worktree.branch, approved, ...ignored].join("\0")).toString(16);
	};

	const ignoredEntries = async (worktree: string): Promise<string[]> =>
		(await git(worktree, ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"]))
			.split("\0")
			.filter(Boolean);

	const blockersFor = async (ctx: ExtensionContext, worktree: string): Promise<string[]> => {
		const blockers = (ctx.getAsyncJobSnapshot()?.running ?? []).map(
			job => `background job ${job.id} still running: ${job.label}`,
		);
		for (const ref of AgentRegistry.global().list()) {
			// Task subagents persist a session file; extension helper sessions (lang-nag, watchdog
			// reviewers, bro) are in-memory model calls that never touch the worktree.
			if (ref.kind !== "sub" || ref.sessionFile === null) continue;
			if (ref.status === "running") {
				blockers.push(`subagent ${ref.id} is running`);
				continue;
			}
			const cwd = ref.session?.sessionManager.getCwd();
			if (cwd !== undefined && isWithin(await realpathOr(cwd), worktree)) {
				blockers.push(`subagent ${ref.id} (${ref.status}) works in this worktree`);
			}
		}
		return blockers;
	};

	/** Inspect the linked worktree containing `dir`. Read-only. */
	const inspect = async (ctx: ExtensionContext, dir: string): Promise<CheckResult> => {
		try {
			const repository = vcs.git(dir);
			if (!repository) return { kind: "error", reason: `${dir} is not inside a git repository.` };
			const linked = repository.linkedWorktree();
			if (!linked) return { kind: "error", reason: `${dir} is the main checkout, not a linked worktree.` };
			const worktree = await realpathOr(linked.root);
			const mainDir = await realpathOr(linked.primaryRoot);
			const branch = await repository.currentBranch();
			if (!branch) return { kind: "error", reason: `${worktree} has a detached HEAD; check out a branch first so no commit is lost.` };
			const tip = await repository.headSha();
			if (!tip) return { kind: "error", reason: `${worktree} has no commits.` };
			const record: SessionWorktree = { path: worktree, branch, sourceCwd: mainDir, baseCommit: tip, keptChanges: true };

			const before = await fingerprint(record, await ignoredEntries(worktree));
			const status = (await git(worktree, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])).split("\0");
			const staged: string[] = [];
			const unstaged: string[] = [];
			const untracked: string[] = [];
			for (let i = 0; i < status.length; i++) {
				const entry = status[i];
				if (entry.length < 4) continue;
				const [x, y, file] = [entry[0], entry[1], entry.slice(3)];
				// Renames and copies are followed by their source path as a separate entry.
				const shown = x === "R" || x === "C" ? `${status[++i]} -> ${file}` : file;
				if (x === "?" && y === "?") {
					untracked.push(shown);
					continue;
				}
				if (x !== " ") staged.push(`${x} ${shown}`);
				if (y !== " ") unstaged.push(`${y} ${shown}`);
			}
			const ignored = await ignoredEntries(worktree);
			const mainHead = (await git(mainDir, ["rev-parse", "HEAD"])).trim();
			const unmergedCommits = (await git(worktree, ["log", "--format=%h %s", `${mainHead}..${tip}`]))
				.split("\n")
				.filter(Boolean);
			const after = await fingerprint(record, ignored);
			if (after !== before) return { kind: "error", reason: `${worktree} changed while it was being checked; check again.` };
			return {
				kind: "ok",
				check: {
					worktree,
					branch,
					mainDir,
					confirm: after,
					staged,
					unstaged,
					untracked,
					ignored,
					unmergedCommits,
					blockers: await blockersFor(ctx, worktree),
				},
			};
		} catch (error) {
			return { kind: "error", reason: error instanceof Error ? error.message : String(error) };
		}
	};

	/** Re-inspect a confirmed worktree; undefined when it is unchanged and unblocked, else why not. */
	const recheck = async (ctx: ExtensionContext, confirmed: WorktreeCheck): Promise<string | undefined> => {
		const current = await inspect(ctx, confirmed.worktree);
		if (current.kind === "error") return current.reason;
		if (current.check.confirm !== confirmed.confirm) {
			return `the worktree changed since the check (a file was added, removed or edited, or HEAD or the branch moved; edits inside a listed file count even when the lists look the same). Current state:\n${formatCheck(current.check)}`;
		}
		if (current.check.blockers.length > 0) return `it is in use:\n${current.check.blockers.join("\n")}`;
		return undefined;
	};

	const reset = (ctx: ExtensionContext): void => {
		if (state.kind === "armed") ctx.clearTimer(state.timer);
		state = { kind: "idle" };
	};

	const report = (content: string, options: { triggerTurn: true } | { deliverAs: "nextTurn" }): void => {
		pi.sendMessage({ customType: MESSAGE_TYPE, content, display: true, attribution: "agent" }, options);
	};

	const runCreate = async (mode: InteractiveModeContext, branch: string | undefined): Promise<string> => {
		const before = mode.sessionManager.getCwd();
		const shown = await runSlashCommand(mode, branch ? `/wt ${branch}` : "/wt");
		const after = mode.sessionManager.getCwd();
		pi.logger.info("wt: queued /wt ran", { before, after, moved: after !== before });
		return after !== before
			? `\`/wt\` ran and moved this session from \`${before}\` to \`${after}\`. Continue the task there. What /wt showed the user:\n${describeShown(shown)}`
			: `\`/wt\` ran but did not move this session; it is still in \`${before}\`. What /wt showed the user:\n${describeShown(shown)}`;
	};

	const runRemove = async (ctx: ExtensionContext, mode: InteractiveModeContext, check: WorktreeCheck): Promise<string> => {
		const stop = (why: string): string =>
			`Worktree removal stopped before anything changed: ${why}\nThe session is still in \`${mode.sessionManager.getCwd()}\` and \`${check.worktree}\` is untouched.`;
		const beforeMove = await recheck(ctx, check);
		if (beforeMove !== undefined) return stop(beforeMove);

		const shown = await runSlashCommand(mode, `/move ${check.mainDir}`);
		const cwd = await realpathOr(mode.sessionManager.getCwd());
		if (cwd !== check.mainDir) {
			return `Worktree removal stopped: \`/move ${check.mainDir}\` did not move the session; it is in \`${cwd}\` and \`${check.worktree}\` is untouched. What /move showed the user:\n${describeShown(shown)}`;
		}
		const moved = `The session moved to the main checkout \`${check.mainDir}\`. Continue the task there.`;

		const afterMove = await recheck(ctx, check);
		if (afterMove !== undefined) return `${moved}\nThe worktree was NOT removed: ${afterMove}\n\`${check.worktree}\` is untouched.`;

		const removed = await vcs.requireGit(check.mainDir).worktreeRemove(check.worktree, true);
		const exists = await fs.stat(check.worktree).then(
			() => true,
			() => false,
		);
		pi.logger.info("wt_remove: removal ran", { worktree: check.worktree, removed, exists });
		if (!removed || exists) {
			return `${moved}\nRemoving the worktree failed: git ${removed ? "reported success but the directory still exists" : "refused"}; \`${check.worktree}\` ${exists ? "still exists" : "is gone"}.`;
		}
		const branchKept = Boolean(await vcs.requireGit(check.mainDir).resolveRef(`refs/heads/${check.branch}`));
		const commits =
			check.unmergedCommits.length > 0
				? ` It has ${check.unmergedCommits.length} commit(s) not reachable from the main checkout's HEAD.`
				: " All its commits are reachable from the main checkout's HEAD.";
		return `${moved}\nRemoved the worktree \`${check.worktree}\`. Branch \`${check.branch}\` ${branchKept ? "is kept." : "no longer exists."}${branchKept ? commits : ""}`;
	};

	const execute = async (ctx: ExtensionContext, request: Request): Promise<void> => {
		state = { kind: "running", request };
		try {
			if (ctx.sessionManager.getSessionId() !== request.sessionId) return;
			const capture = captureInteractiveMode(ctx);
			if (capture.kind === "error") {
				pi.logger.warn("wt: queued request not run", { kind: request.kind, reason: capture.reason });
				report(`The queued ${requestLabel(request)} did not run: ${capture.reason}`, { triggerTurn: true });
				return;
			}
			const outcome =
				request.kind === "create"
					? await runCreate(capture.mode, request.branch)
					: await runRemove(ctx, capture.mode, request.check);
			report(outcome, { triggerTurn: true });
		} catch (error) {
			report(`The queued ${requestLabel(request)} failed: ${error instanceof Error ? error.message : String(error)}`, {
				triggerTurn: true,
			});
		} finally {
			state = { kind: "idle" };
		}
	};

	const arm = (ctx: ExtensionContext, request: Request): void => {
		const tick = (): void => {
			if (state.kind !== "armed" || state.request !== request) return;
			if (!ctx.isIdle() || ctx.hasPendingMessages()) {
				state = { kind: "armed", request, timer: ctx.setTimeout(tick, IDLE_POLL_MS) };
				return;
			}
			void execute(ctx, request);
		};
		state = { kind: "armed", request, timer: ctx.setTimeout(tick, IDLE_POLL_MS) };
	};

	const activate = async (ctx: ExtensionContext): Promise<void> => {
		if (!isEligible(ctx)) return;
		const active = new Set(pi.getActiveTools());
		if (active.has(CREATE_TOOL) && active.has(REMOVE_TOOL)) return;
		active.add(CREATE_TOOL);
		active.add(REMOVE_TOOL);
		await pi.setActiveTools([...active]);
	};

	/** Why the calling session cannot queue a request, if it cannot. */
	const queueBlocker = (ctx: ExtensionContext, tool: string): string | undefined => {
		if (!isEligible(ctx)) return `${tool}: only the main session of the interactive TUI can use this tool.`;
		if (state.kind !== "idle") {
			return `${tool}: ${requestLabel(state.request)} is already queued for the end of this turn; end your turn.`;
		}
		const capture = captureInteractiveMode(ctx);
		if (capture.kind === "error") return `${tool}: ${capture.reason}`;
		if (capture.mode.collabGuest) return `${tool}: session moves are host-only during a collab session.`;
		return undefined;
	};

	/** The linked worktree the session is in, with what `/wt` from there would do; undefined outside one. */
	const currentWorktree = async (
		ctx: ExtensionContext,
	): Promise<{ readonly confirm: string; readonly report: string } | undefined> => {
		const cwd = ctx.sessionManager.getCwd();
		const linked = vcs.git(cwd)?.linkedWorktree();
		if (!linked) return undefined;
		const worktree = await realpathOr(linked.root);
		const mainDir = await realpathOr(linked.primaryRoot);
		const branch = (await git(worktree, ["branch", "--show-current"])).trim();
		const head = (await git(worktree, ["log", "-1", "--format=%h %s"])).trim();
		const changed = (await git(worktree, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]))
			.split("\0")
			.filter(entry => entry.length >= 4 && !/^[RC]/.test(entry)).length;
		const capture = captureInteractiveMode(ctx);
		const cleanSource = capture.kind === "ok" && cfgWorktreeCleanSource.get(capture.mode.settings) === true;
		const report = [
			`Worktree: ${worktree}`,
			`Branch: ${branch || "(detached HEAD)"}`,
			`HEAD: ${head}`,
			`Uncommitted entries: ${changed}`,
			`Main checkout: ${mainDir}`,
			`Creating anyway forks a new worktree from this one: a new branch at this HEAD, carrying these ${changed} uncommitted entries; this worktree stays.${cleanSource ? " `worktree.cleanSource` is on, so this worktree is then reset and cleaned: its uncommitted changes survive only in the new one." : ""}`,
		].join("\n");
		return { confirm: Bun.hash(`wt\0${worktree}\0${branch}`).toString(16), report };
	};

	const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] });
	const fail = (value: string) => ({ ...text(value), isError: true });

	pi.on("session_start", async (_event, ctx) => {
		await activate(ctx);
	});

	pi.on("session_switch", async (_event, ctx) => {
		reset(ctx);
		await activate(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		reset(ctx);
	});

	pi.on("agent_start", async (_event, ctx) => {
		if (state.kind !== "armed") return;
		ctx.clearTimer(state.timer);
		state = { kind: "queued", request: state.request };
	});

	pi.on("agent_end", async (event, ctx) => {
		if (state.kind !== "queued" || event.willContinue === true) return;
		const request = state.request;
		const last = event.messages.findLast(message => message.role === "assistant");
		if (last?.role === "assistant" && last.stopReason === "aborted" && isUserInterruptAbort(last)) {
			state = { kind: "idle" };
			ctx.ui.notify(`Queued ${requestLabel(request).replaceAll("`", "")} cancelled: the turn was interrupted.`, "info");
			report(
				`The queued ${requestLabel(request)} was cancelled because the user interrupted the turn; nothing changed.`,
				{ deliverAs: "nextTurn" },
			);
			return;
		}
		arm(ctx, request);
	});

	pi.registerTool({
		name: CREATE_TOOL,
		label: "Worktree",
		description: CREATE_DESCRIPTION,
		approval: "exec",
		loadMode: "essential",
		defaultInactive: true,
		parameters: createParams,
		async execute(_toolCallId, rawParams, _signal, _onUpdate, ctx) {
			const blocked = queueBlocker(ctx, CREATE_TOOL);
			if (blocked !== undefined) return fail(blocked);
			const params = createParams.parse(rawParams);
			const branch = params.branch?.trim() || undefined;
			const current = await currentWorktree(ctx);
			if (current !== undefined && params.confirm?.trim() !== current.confirm) {
				const mismatch =
					params.confirm === undefined
						? ""
						: "The given confirm value does not match this worktree, so nothing was queued.\n";
				return text(
					`${mismatch}Nothing was created: this session is already in a linked worktree.\n${current.report}\nUsually keep working here. To create a new worktree from this one anyway, call ${CREATE_TOOL} again with confirm="${current.confirm}".`,
				);
			}
			state = { kind: "queued", request: { kind: "create", sessionId: ctx.sessionManager.getSessionId(), branch } };
			return text(
				`Queued \`/wt${branch ? ` ${branch}` : ""}\`. It runs once this turn ends, exactly as if the user typed it. End your turn now without further tool calls; the outcome arrives as the next message.`,
			);
		},
	});

	pi.registerTool({
		name: REMOVE_TOOL,
		label: "Remove Worktree",
		description: REMOVE_DESCRIPTION,
		approval: "exec",
		loadMode: "essential",
		defaultInactive: true,
		parameters: removeParams,
		async execute(_toolCallId, rawParams, _signal, _onUpdate, ctx) {
			const blocked = queueBlocker(ctx, REMOVE_TOOL);
			if (blocked !== undefined) return fail(blocked);
			const confirm = removeParams.parse(rawParams).confirm?.trim() || undefined;
			const result = await inspect(ctx, ctx.sessionManager.getCwd());
			if (result.kind === "error") return fail(`${REMOVE_TOOL}: ${result.reason}`);
			const check = result.check;
			if (confirm === undefined) {
				return text(
					`Check only; nothing changed.\n${formatCheck(check)}\nTo remove, call ${REMOVE_TOOL} again with confirm="${check.confirm}". Any change to the worktree invalidates this value.`,
				);
			}
			if (confirm !== check.confirm) {
				return fail(
					`${REMOVE_TOOL}: confirm does not match the worktree's current state, so nothing was queued. Either the value is from another check, or the worktree changed since the check: a file was added, removed or edited, or HEAD or the branch moved; edits inside a listed file count even when the lists look the same. Current state:\n${formatCheck(check)}`,
				);
			}
			if (check.blockers.length > 0) {
				return fail(`${REMOVE_TOOL}: the worktree is in use; nothing was queued.\n${check.blockers.join("\n")}`);
			}
			state = { kind: "queued", request: { kind: "remove", sessionId: ctx.sessionManager.getSessionId(), check } };
			return text(
				`Queued removal of \`${check.worktree}\` (branch \`${check.branch}\` is kept). End your turn now without further tool calls: once the session is idle it moves to \`${check.mainDir}\` and the worktree is removed, unless anything in it changed since the check. The outcome arrives as the next message.`,
			);
		},
	});
}
