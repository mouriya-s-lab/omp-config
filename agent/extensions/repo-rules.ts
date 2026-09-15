/**
 * repo-rules: inject repository-level rule directories that OMP's native
 * discovery does not read.
 *
 * OMP loads project rules from `.omp/rules`, `.agent(s)/rules`,
 * `.cursor/rules`, `.windsurf/rules`, `.clinerules` and
 * `.github/instructions`. It does not read `.claude/rules` or `.pi/rules` at
 * project level, so rules a repository ships for Claude Code / legacy pi are
 * silently ignored. This extension closes that gap only: it scans
 * `.claude/rules`, `.agents/rules` and `.pi/rules` from the cwd up to the
 * repository root and appends what it finds to the system prompt.
 *
 * Anything already present in the system prompt (native always-apply rules,
 * a user-level copy of the same file, a second brand directory holding the
 * same text) is skipped, so nothing is injected twice.
 */

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";

const RULE_DIRS = [".claude/rules", ".agents/rules", ".pi/rules"] as const;

type RuleKind =
	| { readonly tag: "always" }
	| { readonly tag: "catalog"; readonly description: string };

interface RepoRule {
	readonly name: string;
	readonly displayPath: string;
	readonly body: string;
	readonly kind: RuleKind;
}

function repoRoot(cwd: string): string {
	let dir = cwd;
	for (;;) {
		if (fs.existsSync(path.join(dir, ".git"))) return dir;
		const parent = path.dirname(dir);
		if (parent === dir) return cwd;
		dir = parent;
	}
}

/** cwd first, then each ancestor up to and including the repository root. */
function scanDirs(cwd: string): string[] {
	const root = repoRoot(cwd);
	const dirs: string[] = [];
	let dir = cwd;
	for (;;) {
		for (const rel of RULE_DIRS) dirs.push(path.join(dir, rel));
		if (dir === root) break;
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return dirs;
}

function markdownFiles(dir: string): string[] {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	let out: string[] = [];
	for (const entry of entries) {
		if (entry.name.startsWith(".")) continue;
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) out = out.concat(markdownFiles(full));
		else if (entry.isFile() && (entry.name.endsWith(".md") || entry.name.endsWith(".mdc"))) out.push(full);
	}
	return out.sort((a, b) => a.localeCompare(b));
}

/**
 * Splits leading `---` frontmatter from the body and reads the two keys that
 * decide placement. Values are read line-wise; anything else is ignored.
 */
function parseRuleFile(raw: string): { readonly body: string; readonly kind: RuleKind } {
	let body = raw.trim();
	let alwaysApply = true;
	let description = "";

	if (body.startsWith("---")) {
		const end = body.indexOf("\n---", 3);
		if (end !== -1) {
			const front = body.slice(3, end);
			body = body.slice(end + 4).trim();
			alwaysApply = false;
			for (const line of front.split("\n")) {
				const match = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line.trim());
				if (!match) continue;
				const key = match[1].toLowerCase();
				const value = match[2].trim().replace(/^["']|["']$/g, "");
				if (key === "alwaysapply") alwaysApply = value === "true";
				else if (key === "description") description = value;
			}
		}
	}

	if (alwaysApply) return { body, kind: { tag: "always" } };
	return { body, kind: { tag: "catalog", description: description || "(no description)" } };
}

function collect(cwd: string): RepoRule[] {
	const byName = new Map<string, RepoRule>();
	for (const dir of scanDirs(cwd)) {
		for (const filePath of markdownFiles(dir)) {
			const name = path.basename(filePath).replace(/\.mdc?$/, "");
			if (byName.has(name)) continue; // nearest directory wins
			let raw: string;
			try {
				raw = fs.readFileSync(filePath, "utf8");
			} catch {
				continue;
			}
			if (raw.trim() === "") continue;
			const { body, kind } = parseRuleFile(raw);
			if (body === "") continue;
			byName.set(name, {
				name,
				displayPath: path.relative(cwd, filePath) || filePath,
				body,
				kind,
			});
		}
	}
	return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function buildSection(rules: RepoRule[], systemPrompt: readonly string[]): string {
	const prompt = systemPrompt.join("\n").replace(/\s+/g, " ").trim();
	const always: RepoRule[] = [];
	const catalog: RepoRule[] = [];
	for (const rule of rules) {
		if (rule.kind.tag === "always") {
			if (prompt.includes(rule.body.replace(/\s+/g, " ").trim())) continue; // already injected natively
			always.push(rule);
		} else if (!prompt.includes(`rule://${rule.name}`)) {
			catalog.push(rule);
		}
	}
	if (always.length === 0 && catalog.length === 0) return "";

	const parts = ["<repo-level-rules>", "Repository rule files discovered outside OMP's native rule directories."];
	for (const rule of always) {
		parts.push(`<rule path="${rule.displayPath}">`, rule.body, "</rule>");
	}
	if (catalog.length > 0) {
		parts.push("Read these with the `read` tool when they become relevant:");
		for (const rule of catalog) {
			const description = rule.kind.tag === "catalog" ? rule.kind.description : "";
			parts.push(`- ${rule.name}: ${description} — \`${rule.displayPath}\``);
		}
	}
	parts.push("</repo-level-rules>");
	return parts.join("\n");
}

export default function repoRules(pi: ExtensionAPI) {
	let rules: RepoRule[] = [];

	pi.on("session_start", (_event, ctx) => {
		rules = collect(ctx.cwd);
		if (rules.length > 0) pi.logger?.info?.(`repo-rules: ${rules.length} repo-level rule file(s) from ${ctx.cwd}`);
	});

	pi.on("before_agent_start", (event) => {
		if (rules.length === 0) return;
		const section = buildSection(rules, event.systemPrompt);
		if (section === "") return;
		return { systemPrompt: [...event.systemPrompt, section] };
	});
}
