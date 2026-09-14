import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
	accessSync,
	chmodSync,
	copyFileSync,
	cpSync,
	constants as fsConstants,
	closeSync,
	mkdirSync,
	readFileSync,
	readSync,
	readdirSync,
	renameSync,
	rmSync,
	statSync,
	unlinkSync,
	writeFileSync,
	writeSync,
	type Stats,
} from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

const PTY_PACKAGE = "@homebridge/node-pty-prebuilt-multiarch";
const PTY_VERSION_FALLBACK = "unknown";
const NATIVE_CACHE_ROOT_NAME = "unified-exec-bun-pty-binding";
const READ_POLL_INTERVAL_MS = 50;
const EXIT_DRAIN_GRACE_MS = 250;
const MAX_READS_PER_TICK = 64;
const READ_BUFFER_BYTES = 64 * 1024;
const BUILD_TIMEOUT_MS = 120_000;
const PREBUILD_NODE_TARGETS = [
	// Bun 1.4.1 reports ABI 147; v0.13.1's newest published darwin-arm64 asset is Node ABI 137 (Node 24).
	"24.0.0",
	"22.0.0",
	"20.0.0",
	"18.0.0",
] as const;
const MAX_BUILD_OUTPUT_BYTES = 16 * 1024 * 1024;
const STAGING_STALE_AGE_MS = 10 * 60 * 1000;

const extensionRequire = createRequire(import.meta.url);

type Disposable = { dispose: () => void };

type TimerHandle = NodeJS.Timeout;

type PtyProcess = {
	pid: number;
	readonly processExited: boolean;
	onData: (handler: (data: string | Buffer) => void) => Disposable;
	onExit: (handler: (event: { exitCode: number; signal?: number }) => void) => Disposable;
	write: (data: string | Buffer) => void;
	resize: (cols: number, rows: number) => void;
	kill: (signal?: NodeJS.Signals) => void;
};

type PtyModule = {
	spawn: (
		file: string,
		args: string[] | string,
		options: {
			name?: string;
			cols?: number;
			rows?: number;
			cwd?: string;
			env?: NodeJS.ProcessEnv;
			encoding?: null | string;
		},
	) => PtyProcess;
};

type NativePtyProcess = { fd: number; pid: number };
type NativeFork = (
	file: string,
	args: string[],
	env: string[],
	cwd: string,
	cols: number,
	rows: number,
	uid: number,
	gid: number,
	useUtf8: boolean,
	helperPath: string,
	onExit: (code: number, signal: number) => void,
) => unknown;
type NativeResize = (fd: number, cols: number, rows: number) => void;
type NativeAddon = { fork: NativeFork; resize: NativeResize };
type NativeBuildPaths = {
	readonly root: string;
	readonly addon: string;
	readonly helper: string;
	readonly failureMarker: string;
	readonly originMarker: string;
};
type NativeBuildContext = {
	readonly packageDir: string;
	readonly paths: NativeBuildPaths;
};
type NativeCacheRoot = { readonly kind: "ready"; readonly root: string } | { readonly kind: "failed"; readonly reason: string };
type NativePreparation = { readonly kind: "ready"; readonly native: NativeAddon } | { readonly kind: "failed"; readonly reason: string };

type ReadySetup = {
	readonly kind: "ready";
	readonly module: PtyModule;
};
type FailedSetup = {
	readonly kind: "failed";
	readonly reason: string;
};
type UnsupportedSetup = { readonly kind: "unsupported" };
type SetupResult = ReadySetup | FailedSetup | UnsupportedSetup;

type PackageMetadata = { readonly name: string; readonly version: string };
type NodeGypCommand = { readonly executable: string; readonly prefixArgs: readonly string[] };

type ErrorRecord = Record<string, unknown>;

function isRecord(value: unknown): value is ErrorRecord {
	return typeof value === "object" && value !== null;
}

function stringProperty(value: unknown, key: string): string | undefined {
	if (!isRecord(value)) return undefined;
	const field = value[key];
	return typeof field === "string" ? field : undefined;
}

function textProperty(value: unknown, key: string): string | undefined {
	if (!isRecord(value)) return undefined;
	const field = value[key];
	if (typeof field === "string") return field;
	if (field instanceof Uint8Array) return new TextDecoder().decode(field);
	return undefined;
}

function errorText(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}

function errorCode(error: unknown): string | undefined {
	return stringProperty(error, "code");
}

function isRegularFile(file: string): boolean {
	try {
		const stats: Stats = statSync(file);
		return stats.isFile();
	} catch {
		return false;
	}
}

function isExecutableFile(file: string): boolean {
	if (!isRegularFile(file)) return false;
	try {
		accessSync(file, fsConstants.X_OK);
		return true;
	} catch {
		return false;
	}
}

function agentDirectory(): string {
	const configured = process.env.PI_CODING_AGENT_DIR?.trim();
	return resolve(configured || join(homedir(), ".omp", "agent"));
}

function candidatePackageDirectories(): readonly string[] {
	const agentDir = agentDirectory();
	const packageSuffix = join("node_modules", "@homebridge", "node-pty-prebuilt-multiarch");
	return [
		join(dirname(agentDir), "plugins", packageSuffix),
		join(homedir(), ".omp", "plugins", packageSuffix),
		join(process.cwd(), packageSuffix),
	];
}

function readPackageMetadata(packageDir: string): PackageMetadata | undefined {
	try {
		const parsed: unknown = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
		if (!isRecord(parsed)) return undefined;
		const name = parsed.name;
		const version = parsed.version;
		if (typeof name !== "string" || typeof version !== "string") return undefined;
		return { name, version };
	} catch {
		return undefined;
	}
}

function locatePackage(): { readonly directory: string; readonly metadata: PackageMetadata } | undefined {
	for (const directory of candidatePackageDirectories()) {
		const metadata = readPackageMetadata(directory);
		if (metadata?.name === PTY_PACKAGE) return { directory, metadata };
	}
	return undefined;
}

function nativeBuildRoot(metadata: PackageMetadata): NativeCacheRoot {
	const agentDir = agentDirectory();
	const parent = dirname(agentDir);
	if (parent === agentDir || dirname(parent) === parent) {
		return {
			kind: "failed",
			reason: `cannot derive a safe PTY cache parent from agent directory ${agentDir}`,
		};
	}
	const version = /^[A-Za-z0-9._-]+$/u.test(metadata.version) ? metadata.version : PTY_VERSION_FALLBACK;
	return {
		kind: "ready",
		root: join(parent, NATIVE_CACHE_ROOT_NAME, `${version}-${process.platform}-${process.arch}`),
	};
}

function nativePaths(root: string): NativeBuildPaths {
	return {
		root,
		addon: join(root, "build", "Release", "pty.node"),
		helper: join(root, "build", "Release", "spawn-helper"),
		failureMarker: join(root, "build-failure.txt"),
		originMarker: join(root, "build-origin.txt"),
	};
}

function stagingRoot(root: string): string {
	return `${root}.staging-${process.pid}-${randomUUID()}`;
}

function removeTree(path: string): void {
	try {
		rmSync(path, { recursive: true, force: true });
	} catch {
		// Cleanup is best effort; the next invocation can reap stale staging trees.
	}
}

function reapStagingDirectories(root: string): void {
	const parent = dirname(root);
	const prefix = `${basename(root)}.staging-`;
	let entries: readonly string[];
	try {
		entries = readdirSync(parent);
	} catch (error) {
		if (errorCode(error) === "ENOENT") return;
		return;
	}
	const now = Date.now();
	for (const entry of entries) {
		if (!entry.startsWith(prefix)) continue;
		const candidate = join(parent, entry);
		try {
			const stats = statSync(candidate);
			if (!stats.isDirectory() || now - stats.mtimeMs < STAGING_STALE_AGE_MS) continue;
			removeTree(candidate);
		} catch {
			// A concurrent cleanup or an unreadable entry is not a build blocker.
		}
	}
}

function addonApiDirectory(packageDir: string): string | undefined {
	const packageNodeModules = join(packageDir, "node_modules", "node-addon-api");
	if (isRegularFile(join(packageNodeModules, "package.json"))) return packageNodeModules;
	const hoisted = join(dirname(dirname(packageDir)), "node-addon-api");
	return isRegularFile(join(hoisted, "package.json")) ? hoisted : undefined;
}

function copyBuildInputs(packageDir: string, root: string): string | undefined {
	const addonApi = addonApiDirectory(packageDir);
	const inputs: readonly [string, string][] = [
		[join(packageDir, "binding.gyp"), join(root, "binding.gyp")],
		[join(packageDir, "src", "unix", "pty.cc"), join(root, "src", "unix", "pty.cc")],
		[join(packageDir, "src", "unix", "spawn-helper.cc"), join(root, "src", "unix", "spawn-helper.cc")],
	];
	if (!addonApi) return "node-addon-api is not installed beside the PTY package";
	try {
		mkdirSync(root, { recursive: true, mode: 0o700 });
		for (const [source, destination] of inputs) {
			if (!isRegularFile(source)) return `missing build input: ${source}`;
			mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
			copyFileSync(source, destination);
		}
		const destinationApi = join(root, "node_modules", "node-addon-api");
		if (!isRegularFile(join(destinationApi, "package.json"))) {
			mkdirSync(dirname(destinationApi), { recursive: true, mode: 0o700 });
			cpSync(addonApi, destinationApi, { recursive: true });
		}
		return undefined;
	} catch (error) {
		return `could not prepare extension-owned build inputs: ${errorText(error)}`;
	}
}
function readBuildFailure(marker: string): string | undefined {
	try {
		const detail = readFileSync(marker, "utf8").trim();
		return detail || "the previous PTY build failed without details";
	} catch (error) {
		if (errorCode(error) === "ENOENT") return undefined;
		return `could not read the PTY build-failure marker: ${errorText(error)}`;
	}
}

function rememberBuildFailure(paths: NativeBuildPaths, detail: string): string {
	const retry = `remove ${paths.failureMarker} (or ${paths.root}) to retry`;
	const temporaryMarker = `${paths.failureMarker}.tmp-${process.pid}-${randomUUID()}`;
	try {
		mkdirSync(paths.root, { recursive: true, mode: 0o700 });
		writeFileSync(temporaryMarker, `${detail}\n`, "utf8");
		chmodSync(temporaryMarker, 0o600);
		renameSync(temporaryMarker, paths.failureMarker);
	} catch (error) {
		try {
			unlinkSync(temporaryMarker);
		} catch {
			// The temporary marker may already have been renamed or removed.
		}
		return `${detail}; ${retry}; could not persist the failure marker: ${errorText(error)}`;
	}
	return `${detail}; ${retry}`;
}

function rememberNativeOrigin(paths: NativeBuildPaths, origin: "download" | "build"): string | undefined {
	const temporaryMarker = `${paths.originMarker}.tmp-${process.pid}-${randomUUID()}`;
	try {
		mkdirSync(paths.root, { recursive: true, mode: 0o700 });
		writeFileSync(temporaryMarker, `${origin}\n`, "utf8");
		chmodSync(temporaryMarker, 0o600);
		renameSync(temporaryMarker, paths.originMarker);
		return undefined;
	} catch (error) {
		try {
			unlinkSync(temporaryMarker);
		} catch {
			// The temporary marker may already have been renamed or removed.
		}
		return `could not persist the PTY artifact origin marker: ${errorText(error)}`;
	}
}

function clearBuildFailure(marker: string): void {
	try {
		unlinkSync(marker);
	} catch (error) {
		if (errorCode(error) !== "ENOENT") return;
	}
}


function resolveNodeGypCommand(): NodeGypCommand | undefined {
	let nodePath = "node";
	try {
		const resolved = execFileSync("node", ["-p", "process.execPath"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		}).trim();
		if (resolved) nodePath = resolved;
	} catch {
		// The direct node-gyp probe below may still succeed through PATH.
	}
	const nodeRoot = dirname(dirname(nodePath));
	const scriptCandidates = [
		join(nodeRoot, "libexec", "lib", "node_modules", "npm", "node_modules", "node-gyp", "bin", "node-gyp.js"),
		join(nodeRoot, "lib", "node_modules", "npm", "node_modules", "node-gyp", "bin", "node-gyp.js"),
	];
	for (const script of scriptCandidates) {
		if (isRegularFile(script)) return { executable: nodePath, prefixArgs: [script] };
	}
	try {
		execFileSync("node-gyp", ["--version"], { stdio: ["ignore", "ignore", "ignore"] });
		return { executable: "node-gyp", prefixArgs: [] };
	} catch {
		return undefined;
	}
}

function buildNativeAddon(root: string): string | undefined {
	const command = resolveNodeGypCommand();
	if (!command) {
		return "node-gyp is unavailable; install Node.js with npm/node-gyp and Xcode Command Line Tools";
	}
	try {
		execFileSync(command.executable, [...command.prefixArgs, "rebuild"], {
			cwd: root,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			timeout: BUILD_TIMEOUT_MS,
			maxBuffer: MAX_BUILD_OUTPUT_BYTES,
		});
		return undefined;
	} catch (error) {
		const stderr = textProperty(error, "stderr")?.trim();
		const detail = stderr || errorText(error);
		return `node-gyp could not build the PTY addon (Xcode Command Line Tools and Node headers are required): ${detail.slice(-2000)}`;
	}
}

function nativeAddon(value: unknown): value is NativeAddon {
	if (!isRecord(value)) return false;
	return typeof value.fork === "function" && typeof value.resize === "function";
}

function nativeProcess(value: unknown): NativePtyProcess {
	if (!isRecord(value)) throw new Error("PTY addon returned an invalid process handle");
	const fd = value.fd;
	const pid = value.pid;
	if (typeof fd !== "number" || !Number.isInteger(fd) || typeof pid !== "number" || !Number.isInteger(pid)) {
		throw new Error("PTY addon returned an invalid process handle");
	}
	return { fd, pid };
}

function loadNativeAddon(addonPath: string): NativeAddon {
	const loaded: unknown = extensionRequire(addonPath);
	if (!nativeAddon(loaded)) throw new Error("PTY addon does not expose the expected Node-API fork/resize functions");
	return loaded;
}
function loadReadyNative(paths: NativeBuildPaths): NativeAddon | undefined {
	if (!isRegularFile(paths.addon) || !isRegularFile(paths.helper)) return undefined;
	try {
		chmodSync(paths.helper, 0o755);
		if (!isExecutableFile(paths.helper)) return undefined;
		return loadNativeAddon(paths.addon);
	} catch {
		return undefined;
	}
}

function prebuildInstallScript(packageDir: string): string | undefined {
	const packageLocal = join(packageDir, "node_modules", "prebuild-install", "bin.js");
	if (isRegularFile(packageLocal)) return packageLocal;
	const pluginRoot = dirname(dirname(packageDir));
	const hoisted = join(pluginRoot, "prebuild-install", "bin.js");
	return isRegularFile(hoisted) ? hoisted : undefined;
}

function tryPrebuiltNative(packageDir: string, root: string): string | undefined {
	const script = prebuildInstallScript(packageDir);
	if (!script) return "published PTY prebuild download unavailable: prebuild-install is not installed beside the PTY package";

	const packageJson = join(root, "package.json");
	const targets = [process.versions.node, ...PREBUILD_NODE_TARGETS];
	const attempted = new Set<string>();
	const failures: string[] = [];
	try {
		copyFileSync(join(packageDir, "package.json"), packageJson);
		for (const target of targets) {
			if (attempted.has(target)) continue;
			attempted.add(target);
			try {
				execFileSync(
					process.execPath,
					[
						script,
						"--verbose",
						"--target",
						target,
						"--runtime",
						"node",
						"--platform",
						process.platform,
						"--arch",
						process.arch,
					],
					{
						cwd: root,
						encoding: "utf8",
						stdio: ["ignore", "pipe", "pipe"],
						timeout: BUILD_TIMEOUT_MS,
						maxBuffer: MAX_BUILD_OUTPUT_BYTES,
					},
				);
			} catch (error) {
				const detail = (textProperty(error, "stderr") || textProperty(error, "stdout") || errorText(error)).trim();
				failures.push(`${target}: ${detail.slice(-400)}`);
				removeTree(join(root, "build"));
				continue;
			}

			if (loadReadyNative(nativePaths(root))) return undefined;
			failures.push(`${target}: downloaded prebuild could not load in Bun`);
			removeTree(join(root, "build"));
		}
		return `published PTY prebuild download unavailable: no Bun-loadable asset found (${failures.join("; ")})`;
	} catch (error) {
		return `published PTY prebuild download unavailable: ${errorText(error)}`;
	} finally {
		try {
			unlinkSync(packageJson);
		} catch {
			// The temporary package manifest is best-effort cleanup.
		}
	}
}


function pathExists(path: string): boolean {
	try {
		statSync(path);
		return true;
	} catch (error) {
		return errorCode(error) !== "ENOENT";
	}
}

function hasNativeArtifacts(paths: NativeBuildPaths): boolean {
	return isRegularFile(paths.addon) || isRegularFile(paths.helper);
}

function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

function publishNative(destination: NativeBuildPaths, staging: NativeBuildPaths): NativePreparation {
	const existing = loadReadyNative(destination);
	if (existing) return { kind: "ready", native: existing };
	if (hasNativeArtifacts(destination)) {
		return { kind: "failed", reason: "an existing extension-owned PTY artifact could not load in Bun" };
	}

	for (let attempt = 0; attempt < 2; attempt += 1) {
		if (pathExists(destination.root)) {
			if (hasNativeArtifacts(destination)) {
				return { kind: "failed", reason: "an existing extension-owned PTY artifact could not load in Bun" };
			}
			if (!isDirectory(destination.root)) {
				return { kind: "failed", reason: `cannot publish the PTY addon because ${destination.root} is not a directory` };
			}
			removeTree(destination.root);
			if (pathExists(destination.root)) {
				return { kind: "failed", reason: `could not remove stale PTY build directory ${destination.root}` };
			}
		}

		try {
			renameSync(staging.root, destination.root);
		} catch (error) {
			const winner = loadReadyNative(destination);
			if (winner) return { kind: "ready", native: winner };
			if (attempt === 0 && isDirectory(destination.root) && !hasNativeArtifacts(destination)) {
				removeTree(destination.root);
				continue;
			}
			return { kind: "failed", reason: `could not publish the PTY addon atomically: ${errorText(error)}` };
		}

		const published = loadReadyNative(destination);
		if (published) return { kind: "ready", native: published };
		return { kind: "failed", reason: "published PTY addon could not load in Bun" };
	}
	return { kind: "failed", reason: "could not publish the PTY addon atomically after a concurrent publish" };
}

function environmentFor(options: { cwd?: string; env?: NodeJS.ProcessEnv; name?: string }): { cwd: string; env: string[] } {
	const cwd = options.cwd ?? process.cwd();
	const source = options.env ?? process.env;
	const values: NodeJS.ProcessEnv = {
		...source,
		PWD: cwd,
		TERM: options.name ?? source.TERM ?? "xterm",
	};
	return {
		cwd,
		env: Object.entries(values).flatMap(([key, value]) => (typeof value === "string" ? [`${key}=${value}`] : [])),
	};
}

function createDirectFdModule(native: NativeAddon, helperPath: string): PtyModule {
	return {
		spawn(file, args, options): PtyProcess {
			if (typeof args === "string") throw new Error("Bun PTY adapter only accepts argv arrays on POSIX");
			const { cwd, env } = environmentFor(options);
			let processExited = false;
			let finished = false;
			let readClosed = false;
			let exitEvent: { exitCode: number; signal?: number } | undefined;
			let pollTimer: TimerHandle | undefined;
			let postExitTimer: TimerHandle | undefined;
			const dataHandlers = new Set<(data: string | Buffer) => void>();
			const exitHandlers = new Set<(event: { exitCode: number; signal?: number }) => void>();
			const buffer = Buffer.allocUnsafe(READ_BUFFER_BYTES);
			let term: NativePtyProcess;
			let fd = -1;

			function finish(): void {
				if (finished) return;
				finished = true;
				clearInterval(pollTimer);
				clearTimeout(postExitTimer);
				try {
					closeSync(fd);
				} catch {
					// The descriptor may already have been closed by the runtime.
				}
				const event = exitEvent ?? { exitCode: 1, signal: undefined };
				for (const handler of exitHandlers) {
					try {
						handler(event);
					} catch {
						// Match node-pty: a consumer callback cannot break PTY cleanup.
					}
				}
				exitHandlers.clear();
				dataHandlers.clear();
			}

			function drain(maxReads = MAX_READS_PER_TICK): void {
				if (finished) return;
				let reads = 0;
				while (!readClosed && reads < maxReads) {
					reads += 1;
					try {
						const length = readSync(fd, buffer, 0, buffer.length, null);
						if (length <= 0) {
							readClosed = true;
							break;
						}
						const chunk = Buffer.from(buffer.subarray(0, length));
						for (const handler of dataHandlers) {
							try {
								handler(chunk);
							} catch {
								// Match node-pty's best-effort data dispatch.
							}
						}
					} catch (error) {
						const code = errorCode(error);
						if (code === "EAGAIN" || code === "EWOULDBLOCK") break;
						readClosed = true;
						break;
					}
				}
				if (exitEvent && readClosed) finish();
			}

			function onNativeExit(code: number, signal: number): void {
				queueMicrotask(() => {
					if (finished) return;
					processExited = true;
					exitEvent = { exitCode: code, signal };
					drain(Number.POSITIVE_INFINITY);
					if (readClosed) {
						finish();
						return;
					}
					postExitTimer = setTimeout(() => {
						drain(Number.POSITIVE_INFINITY);
						finish();
					}, EXIT_DRAIN_GRACE_MS);
					postExitTimer.unref?.();
				});
			}

			const created = native.fork(
				file,
				args,
				env,
				cwd,
				options.cols ?? 80,
				options.rows ?? 24,
				-1,
				-1,
				true,
				helperPath,
				onNativeExit,
			);
			term = nativeProcess(created);
			fd = term.fd;
			pollTimer = setInterval(drain, READ_POLL_INTERVAL_MS);
			pollTimer.unref?.();
			drain();

			return {
				pid: term.pid,
				get processExited() {
					return processExited;
				},
				onData(handler) {
					if (!finished) dataHandlers.add(handler);
					return { dispose: () => void dataHandlers.delete(handler) };
				},
				onExit(handler) {
					if (!finished) exitHandlers.add(handler);
					return { dispose: () => void exitHandlers.delete(handler) };
				},
				write(data) {
					if (finished || readClosed) return;
					writeSync(fd, typeof data === "string" ? Buffer.from(data) : data);
				},
				resize(cols, rows) {
					if (!finished) native.resize(fd, cols, rows);
				},
				kill(signal = "SIGTERM") {
					if (finished || !term.pid) return;
					try {
						process.kill(-term.pid, signal);
					} catch {
						try {
							process.kill(term.pid, signal);
						} catch {
							// The process may have exited between the two checks.
						}
					}
				},
			};
		},
	};
}

function seedPackageCache(packageDir: string, module: PtyModule): FailedSetup | undefined {
	const nodeModulesDir = dirname(dirname(packageDir));
	const pluginDir = dirname(nodeModulesDir);
	const packageRequire = createRequire(join(pluginDir, "package.json"));
	let entryPath: string;
	try {
		entryPath = packageRequire.resolve(PTY_PACKAGE);
	} catch (error) {
		return { kind: "failed", reason: `could not resolve ${PTY_PACKAGE}: ${errorText(error)}` };
	}
	if (packageRequire.cache[entryPath] !== undefined) {
		return { kind: "failed", reason: `${PTY_PACKAGE} was already loaded before the compatibility extension` };
	}
	const cacheEntry: NodeJS.Module = {
		children: [],
		exports: module,
		filename: entryPath,
		id: entryPath,
		isPreloading: false,
		loaded: true,
		parent: undefined,
		path: dirname(entryPath),
		paths: [],
		require: packageRequire,
	};
	packageRequire.cache[entryPath] = cacheEntry;
	return undefined;
}

function failedNativePreparation(paths: NativeBuildPaths, detail: string): NativePreparation {
	const winner = loadReadyNative(paths);
	if (winner) {
		clearBuildFailure(paths.failureMarker);
		return { kind: "ready", native: winner };
	}
	return { kind: "failed", reason: rememberBuildFailure(paths, detail) };
}

function prepareNative(context: NativeBuildContext): NativePreparation {
	const { paths } = context;
	reapStagingDirectories(paths.root);
	const existing = loadReadyNative(paths);
	if (existing) {
		clearBuildFailure(paths.failureMarker);
		return { kind: "ready", native: existing };
	}
	const previousFailure = readBuildFailure(paths.failureMarker);
	if (previousFailure) {
		return {
			kind: "failed",
			reason: `previous PTY build failed: ${previousFailure}; remove ${paths.failureMarker} (or ${paths.root}) to retry`,
		};
	}

	const staging = nativePaths(stagingRoot(paths.root));
	try {
		const inputError = copyBuildInputs(context.packageDir, staging.root);
		if (inputError) return failedNativePreparation(paths, inputError);
		const prebuildError = tryPrebuiltNative(context.packageDir, staging.root);
		if (!prebuildError) {
			const originError = rememberNativeOrigin(staging, "download");
			if (originError) return failedNativePreparation(paths, originError);
			const published = publishNative(paths, staging);
			if (published.kind === "ready") {
				clearBuildFailure(paths.failureMarker);
				return published;
			}
			return failedNativePreparation(paths, published.reason);
		}
		removeTree(join(staging.root, "build"));
		const buildError = buildNativeAddon(staging.root);
		if (buildError) return failedNativePreparation(paths, `${prebuildError}; source build fallback unavailable: ${buildError}`);
		if (!loadReadyNative(staging)) {
			return failedNativePreparation(paths, `${prebuildError}; source build fallback produced an addon that could not load in Bun`);
		}
		const originError = rememberNativeOrigin(staging, "build");
		if (originError) return failedNativePreparation(paths, originError);
		const published = publishNative(paths, staging);
		if (published.kind === "ready") {
			clearBuildFailure(paths.failureMarker);
			return published;
		}
		return failedNativePreparation(paths, published.reason);
	} finally {
		removeTree(staging.root);
	}
}

function preparePty(): SetupResult {
	if (process.platform !== "darwin" || process.arch !== "arm64") return { kind: "unsupported" };
	const located = locatePackage();
	if (!located) {
		return {
			kind: "failed",
			reason: `${PTY_PACKAGE}@0.13.1 is not installed; install the pi-unified-exec plugin first`,
		};
	}
	const cacheRoot = nativeBuildRoot(located.metadata);
	if (cacheRoot.kind === "failed") return cacheRoot;
	const paths = nativePaths(cacheRoot.root);
	const preparation = prepareNative({ packageDir: located.directory, paths });
	if (preparation.kind === "failed") return preparation;
	const module = createDirectFdModule(preparation.native, paths.helper);
	const cacheError = seedPackageCache(located.directory, module);
	if (cacheError) return cacheError;
	return { kind: "ready", module };
}

export default function unifiedExecBunPty(pi: ExtensionAPI): void {
	let setup: SetupResult;
	try {
		setup = preparePty();
	} catch (error) {
		setup = { kind: "failed", reason: `PTY compatibility setup failed: ${errorText(error)}` };
	}
	pi.on("session_start", () => {
		switch (setup.kind) {
			case "ready":
				return;
			case "unsupported":
				return;
			case "failed":
				pi.logger.warn(`unified-exec: Bun PTY compatibility skipped: ${setup.reason}`);
				return;
		}
	});
}
