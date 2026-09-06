// User-local overlay. Survives `omp update` because it lives in ~/.omp, not the install tree.
// SuperGrok /v1/responses already returns usage.cost_in_usd_ticks. omp's Responses parser
// drops that field and then calculateCost() multiplies a zero catalog. This wraps fetch,
// records ticks while the SDK reads the SSE, and stamps usage.cost.total on message_end
// before persist.

const USD_TICKS_PER_DOLLAR = 10_000_000_000;
const FETCH_MARK = Symbol.for("omp.xai-oauth-cost-ticks.fetch");
const RECENT_TTL_MS = 30_000;
const RECENT_CAP = 16;
const ID_CAP = 64;

type TicksEntry = { ticks: number; at: number };

const ticksByResponseId = new Map<string, number>();
const recent: TicksEntry[] = [];

function noteTicks(id: unknown, ticks: unknown): void {
	if (typeof ticks !== "number" || !Number.isFinite(ticks)) return;
	if (typeof id === "string" && id.length > 0) {
		ticksByResponseId.set(id, ticks);
		while (ticksByResponseId.size > ID_CAP) {
			const oldest = ticksByResponseId.keys().next().value;
			if (oldest === undefined) break;
			ticksByResponseId.delete(oldest);
		}
	}
	recent.push({ ticks, at: Date.now() });
	if (recent.length > RECENT_CAP) recent.shift();
}

function lookupTicks(responseId: unknown): number | undefined {
	if (typeof responseId === "string" && responseId.length > 0) {
		const byId = ticksByResponseId.get(responseId);
		if (byId !== undefined) return byId;
	}
	const now = Date.now();
	for (let i = recent.length - 1; i >= 0; i--) {
		const entry = recent[i];
		if (entry && now - entry.at <= RECENT_TTL_MS) return entry.ticks;
	}
	return undefined;
}

function applyTicksToUsage(usage: unknown, ticks: number): void {
	if (!usage || typeof usage !== "object" || !("cost" in usage)) return;
	const cost = usage.cost;
	if (!cost || typeof cost !== "object" || !("total" in cost)) return;
	if (typeof cost.total === "number" && Number.isFinite(cost.total) && cost.total !== 0) return;
	cost.total = ticks / USD_TICKS_PER_DOLLAR;
}

function requestUrl(input: RequestInfo | URL): string {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.href;
	return input.url;
}

function requestMethod(input: RequestInfo | URL, init?: RequestInit): string {
	if (init?.method) return init.method.toUpperCase();
	if (typeof input !== "string" && !(input instanceof URL)) return (input.method || "GET").toUpperCase();
	return "GET";
}

function extractTicksFromJson(payload: unknown): void {
	if (!payload || typeof payload !== "object") return;
	let usage: unknown;
	let id: unknown;
	if ("usage" in payload) usage = payload.usage;
	if ("id" in payload) id = payload.id;
	if ("response" in payload && payload.response && typeof payload.response === "object") {
		if ("usage" in payload.response) usage = payload.response.usage;
		if ("id" in payload.response) id = payload.response.id;
	}
	let ticks: unknown;
	if (usage && typeof usage === "object" && "cost_in_usd_ticks" in usage) {
		ticks = usage.cost_in_usd_ticks;
	}
	noteTicks(id, ticks);
}

function tapSseBody(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
	const decoder = new TextDecoder();
	let buf = "";
	return body.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				buf += decoder.decode(chunk, { stream: true });
				const parts = buf.split("\n\n");
				buf = parts.pop() ?? "";
				for (const part of parts) {
					const line = part.split("\n").find((row) => row.startsWith("data: "));
					if (!line) continue;
					const data = line.slice(6);
					if (data !== "[DONE]") {
						try {
							extractTicksFromJson(JSON.parse(data));
						} catch {
							// ignore malformed SSE data lines
						}
					}
				}
				controller.enqueue(chunk);
			},
		}),
	);
}

function wrapFetch(original: typeof fetch): typeof fetch {
	const wrapped = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const response = await original(input, init);
		const url = requestUrl(input);
		const isXaiInference =
			url.includes("api.x.ai") && (url.includes("/responses") || url.includes("/chat/completions"));
		if (requestMethod(input, init) !== "POST" || !isXaiInference || !response.body) {
			return response;
		}
		const contentType = response.headers.get("content-type") ?? "";
		if (contentType.includes("text/event-stream")) {
			return new Response(tapSseBody(response.body), {
				status: response.status,
				statusText: response.statusText,
				headers: response.headers,
			});
		}
		void response
			.clone()
			.json()
			.then(extractTicksFromJson)
			.catch(() => undefined);
		return response;
	}) as typeof fetch;
	Object.defineProperty(wrapped, FETCH_MARK, { value: true });
	return wrapped;
}

function installFetchWrap(): void {
	const current = globalThis.fetch as typeof fetch & { [key: symbol]: unknown };
	if (current[FETCH_MARK]) return;
	globalThis.fetch = wrapFetch(current);
}

export function __testables() {
	return { noteTicks, lookupTicks, applyTicksToUsage, extractTicksFromJson, tapSseBody, wrapFetch, USD_TICKS_PER_DOLLAR };
}

export default function xaiOauthCostTicks(pi: { on: (event: string, handler: (event: unknown) => void) => void }) {
	installFetchWrap();
	pi.on("message_end", (event) => {
		if (!event || typeof event !== "object" || !("message" in event)) return;
		const message = event.message;
		if (!message || typeof message !== "object") return;
		if (!("role" in message) || message.role !== "assistant") return;
		if (!("provider" in message) || message.provider !== "xai-oauth") return;
		const responseId = "responseId" in message ? message.responseId : undefined;
		const ticks = lookupTicks(responseId);
		if (ticks === undefined) return;
		const usage = "usage" in message ? message.usage : undefined;
		applyTicksToUsage(usage, ticks);
	});
}
