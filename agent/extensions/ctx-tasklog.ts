import { appendFile, mkdir, stat } from "node:fs/promises";
import { dirname, join, resolve as resolvePath } from "node:path";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { resolveLocalRoot, type LocalProtocolOptions } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { isRecord } from "@oh-my-pi/pi-utils";

type TodoOperation = "init" | "start" | "done" | "rm" | "drop" | "block" | "unblock" | "append" | "view";
type GoalOperation = "create" | "get" | "complete" | "resume" | "drop";

interface TodoPhaseDetails {
	name: string;
	taskCount: number;
}

interface TodoResultDetails {
	op?: TodoOperation;
	phases?: TodoPhaseDetails[];
	completedTasks?: string[];
}

interface GoalResultDetails {
	op?: GoalOperation;
	objective?: string;
}

interface TodoCounts {
	phases: number;
	tasks: number;
}

let writeTail: Promise<void> = Promise.resolve();

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function oneLine(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function quote(value: string | undefined): string {
	const normalized = value === undefined ? "-" : oneLine(value);
	return JSON.stringify(normalized || "-");
}

function todoOperation(value: unknown): TodoOperation | undefined {
	if (
		value === "init" ||
		value === "start" ||
		value === "done" ||
		value === "rm" ||
		value === "drop" ||
		value === "block" ||
		value === "unblock" ||
		value === "append" ||
		value === "view"
	) {
		return value;
	}
	return undefined;
}

function goalOperation(value: unknown): GoalOperation | undefined {
	if (value === "create" || value === "get" || value === "complete" || value === "resume" || value === "drop") {
		return value;
	}
	return undefined;
}

function parseTodoDetails(value: unknown): TodoResultDetails | undefined {
	if (!isRecord(value)) return undefined;
	const op = todoOperation(value.op);
	const phasesValue = value.phases;
	let phases: TodoPhaseDetails[] | undefined;
	if (Array.isArray(phasesValue)) {
		const parsed: TodoPhaseDetails[] = [];
		for (const phaseValue of phasesValue) {
			if (!isRecord(phaseValue) || typeof phaseValue.name !== "string" || !Array.isArray(phaseValue.tasks)) {
				phases = undefined;
				break;
			}
			if (!phaseValue.tasks.every(task => isRecord(task) && typeof task.content === "string")) {
				phases = undefined;
				break;
			}
			parsed.push({ name: phaseValue.name, taskCount: phaseValue.tasks.length });
		}
		if (phases === undefined && parsed.length === phasesValue.length) phases = parsed;
	}
	let completedTasks: string[] | undefined;
	if (Array.isArray(value.completedTasks) && value.completedTasks.every(item => isRecord(item) && typeof item.content === "string")) {
		completedTasks = value.completedTasks.map(item => String((item as Record<string, unknown>).content));
	}
	if (op === undefined && phases === undefined && completedTasks === undefined) return undefined;
	return { op, phases, completedTasks };
}

function parseGoalDetails(value: unknown): GoalResultDetails | undefined {
	if (!isRecord(value)) return undefined;
	const op = goalOperation(value.op);
	let objective: string | undefined;
	if (isRecord(value.goal)) objective = stringValue(value.goal.objective);
	if (op === undefined && objective === undefined) return undefined;
	return { op, objective };
}

function parseInputPhases(value: unknown): TodoCounts | undefined {
	if (!isRecord(value)) return undefined;
	if (Array.isArray(value.list)) {
		let tasks = 0;
		for (const phaseValue of value.list) {
			if (!isRecord(phaseValue) || typeof phaseValue.phase !== "string" || !Array.isArray(phaseValue.items)) {
				return undefined;
			}
			if (!phaseValue.items.every(item => typeof item === "string")) return undefined;
			tasks += phaseValue.items.length;
		}
		return { phases: value.list.length, tasks };
	}
	if (Array.isArray(value.items) && value.items.every(item => typeof item === "string")) {
		return { phases: 1, tasks: value.items.length };
	}
	return undefined;
}

function countsFromDetails(details: TodoResultDetails | undefined): TodoCounts | undefined {
	if (!details?.phases) return undefined;
	return {
		phases: details.phases.length,
		tasks: details.phases.reduce((total, phase) => total + phase.taskCount, 0),
	};
}

function formatTodoDetail(op: TodoOperation, input: Record<string, unknown>, details: TodoResultDetails | undefined): string | undefined {
	switch (op) {
		case "init": {
			const counts = countsFromDetails(details) ?? parseInputPhases(input);
			return counts ? `${counts.phases} phases / ${counts.tasks} tasks` : "0 phases / 0 tasks";
		}
		case "start":
		case "done":
		case "drop":
		case "block":
		case "unblock": {
			const task = stringValue(input.task);
			const phase = stringValue(input.phase);
			const completed = details?.completedTasks?.[0];
			const target = task ?? phase ?? completed ?? ((op === "done" || op === "drop") ? "all tasks" : undefined);
			const reason = op === "block" ? stringValue(input.reason) : undefined;
			return `${quote(target)}${reason ? ` (${oneLine(reason)})` : ""}`;
		}
		case "append": {
			const phase = stringValue(input.phase);
			const items = Array.isArray(input.items) ? input.items : undefined;
			const count = items?.every(item => typeof item === "string") ? items.length : 0;
			return `phase ${quote(phase)}: +${count}`;
		}
		case "rm": {
			const task = stringValue(input.task);
			if (task !== undefined) return quote(task);
			const phase = stringValue(input.phase);
			if (phase !== undefined) return `phase ${quote(phase)}`;
			return "all tasks";
		}
		case "view":
			return undefined;
	}
}

function formatGoalDetail(op: GoalOperation, input: Record<string, unknown>, details: GoalResultDetails | undefined): string | undefined {
	switch (op) {
		case "create":
			return quote(stringValue(input.objective) ?? details?.objective);
		case "resume":
		case "complete":
		case "drop":
			return quote(details?.objective ?? stringValue(input.objective));
		case "get":
			return undefined;
	}
}

function formatLocalTimestamp(date: Date): string {
	const pad = (value: number): string => String(value).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function resolveAgentId(ctx: ExtensionContext): string {
	const sessionFile = ctx.sessionManager.getSessionFile();
	if (sessionFile) {
		const normalizedSessionFile = resolvePath(sessionFile);
		const ref = AgentRegistry.global()
			.list()
			.find(candidate => candidate.sessionFile !== null && resolvePath(candidate.sessionFile) === normalizedSessionFile);
		if (ref) return ref.id;
	}
	return MAIN_AGENT_ID;
}

function resolveTaskLogPath(ctx: ExtensionContext): { path: string; agentId: string } {
	const localProtocolOptions: LocalProtocolOptions =
		ctx.localProtocolOptions ?? {
			getArtifactsDir: () => ctx.sessionManager.getArtifactsDir(),
			getSessionId: () => ctx.sessionManager.getSessionId(),
		};
	const localRoot = resolveLocalRoot(localProtocolOptions);
	const agentId = resolveAgentId(ctx);
	return { path: join(localRoot, "task-log", `${agentId}.md`), agentId };
}

async function appendTaskLog(path: string, agentId: string, line: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	let needsHeader = false;
	try {
		needsHeader = (await stat(path)).size === 0;
	} catch {
		needsHeader = true;
	}
	if (needsHeader) await appendFile(path, `# Task log: ${agentId}\n`, "utf8");
	await appendFile(path, `${line}\n`, "utf8");
}

function safeWarn(pi: ExtensionAPI, error: unknown): void {
	try {
		pi.logger.warn("ctx-tasklog failed", { error: error instanceof Error ? error.message : String(error) });
	} catch {
		// Logging must never become an extension-handler failure.
	}
}

function queueTaskLog(pi: ExtensionAPI, path: string, agentId: string, line: string): Promise<void> {
	writeTail = writeTail
		.then(() => appendTaskLog(path, agentId, line))
		.catch(error => safeWarn(pi, error));
	return writeTail;
}

export default function ctxTaskLog(pi: ExtensionAPI): void {
	pi.on("tool_result", async (event, ctx): Promise<void> => {
		try {
			if ((event.toolName !== "todo" && event.toolName !== "goal") || event.isError !== false) return;
			const input = event.input;
			const timestamp = formatLocalTimestamp(new Date());
			let detail: string | undefined;
			let operation: TodoOperation | GoalOperation | undefined;
			if (event.toolName === "todo") {
				const details = parseTodoDetails(event.details);
				const op = todoOperation(input.op) ?? details?.op;
				if (op === undefined) return;
				operation = op;
				detail = formatTodoDetail(op, input, details);
			} else {
				const details = parseGoalDetails(event.details);
				const op = goalOperation(input.op) ?? details?.op;
				if (op === undefined) return;
				operation = op;
				detail = formatGoalDetail(op, input, details);
			}
			if (detail === undefined || operation === undefined) return;
			const target = resolveTaskLogPath(ctx);
			await queueTaskLog(pi, target.path, target.agentId, `- ${timestamp} ${event.toolName} ${operation}: ${detail}`);
		} catch (error) {
			safeWarn(pi, error);
		}
	});
}
