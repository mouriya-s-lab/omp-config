import type { UsageLimit, UsageProvider, UsageReport } from "@oh-my-pi/pi-ai";
import { type ExtensionAPI, z } from "@oh-my-pi/pi-coding-agent";
import { getApiKey } from "../../plugins/node_modules/pi-commandcode-provider/src/converters.ts";

// API contract: https://github.com/gaigaichao/dsh-commandcode-usage
// Only augment quota reporting; registering the provider again would replace
// the installed plugin's models, streaming implementation, and authentication.
const BILLING_URL = "https://api.commandcode.ai/alpha/billing/credits";
const HOUR_MS = 60 * 60 * 1000;
const windowSchema = z.object({
	used: z.number().nonnegative(),
	cap: z.number().nonnegative(),
	exceeded: z.boolean().nullable(),
	resetAt: z.number().nonnegative(),
});
const billingSchema = z.object({
	credits: z.object({
		belowThreshold: z.boolean(),
		creditThreshold: z.number(),
		monthlyCredits: z.number(),
		purchasedCredits: z.number(),
		freeCredits: z.number(),
	}),
	windowLimits: z.object({
		limited: z.boolean(),
		fiveHour: windowSchema,
		weekly: windowSchema,
	}),
});
type BillingWindow = z.infer<typeof windowSchema>;
type BillingResponse = z.infer<typeof billingSchema>;

function windowLimit(id: "5h" | "7d", window: BillingWindow): UsageLimit {
	const usedFraction = window.cap > 0 ? window.used / window.cap : undefined;
	return {
		id: `commandcode:${id}`,
		label: id === "5h" ? "5 Hour" : "Weekly",
		scope: { provider: "commandcode", windowId: id },
		window: {
			id,
			label: id === "5h" ? "5 Hour" : "Weekly",
			durationMs: (id === "5h" ? 5 : 7 * 24) * HOUR_MS,
			// Zero means no active reset clock, not January 1970.
			resetsAt: window.resetAt > 0 ? window.resetAt : undefined,
		},
		amount: {
			unit: "usd",
			used: window.used,
			limit: window.cap,
			remaining: Math.max(0, window.cap - window.used),
			usedFraction,
		},
		status:
			window.exceeded === true || (usedFraction !== undefined && usedFraction >= 1)
				? "exhausted"
				: usedFraction === undefined
					? "unknown"
					: usedFraction >= 0.9
						? "warning"
						: "ok",
		notes: [`$${window.used.toFixed(2)} used / $${window.cap.toFixed(2)} limit`],
	};
}

function usageReport(billing: BillingResponse): UsageReport {
	const { credits, windowLimits } = billing;
	return {
		provider: "commandcode",
		fetchedAt: Date.now(),
		limits: [
			windowLimit("5h", windowLimits.fiveHour),
			windowLimit("7d", windowLimits.weekly),
		],
		// Native /usage renders percentage windows, not balance-only amounts.
		// Show the actual balances as notes rather than inventing a monthly cap.
		notes: [
			`Credit balances — monthly: $${credits.monthlyCredits.toFixed(2)}; purchased: $${credits.purchasedCredits.toFixed(2)}; free: $${credits.freeCredits.toFixed(2)}.`,
			...(credits.belowThreshold ? ["Balance below the provider's credit threshold."] : []),
		],
		metadata: { credits },
	};
}

export const commandcodeUsageProvider: UsageProvider = {
	id: "commandcode",
	validatesCredentials: true,
	retainLastGoodOnFailure: false,
	async fetchUsage({ credential, signal }, ctx) {
		const key = credential.type === "oauth" ? credential.accessToken : credential.apiKey;
		if (!key) return null;
		const timeout = AbortSignal.timeout(15_000);
		const response = await ctx.fetch(BILLING_URL, {
			headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
			signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
		});
		// Never include upstream bodies or request headers in authentication errors.
		if (!response.ok) throw new Error(`Command Code quota request failed (HTTP ${response.status}).`);
		let body: unknown;
		try {
			body = await response.json();
		} catch {
			throw new Error("Command Code quota endpoint returned invalid JSON.");
		}
		const parsed = billingSchema.safeParse(body);
		if (!parsed.success) throw new Error("Command Code quota endpoint returned an unexpected response shape.");
		return usageReport(parsed.data);
	},
};

export default function commandcodeUsage(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		// Reuse the installed plugin's env/legacy-file lookup without copying its
		// key into a new secret store. Stored OMP credentials take precedence.
		ctx.modelRegistry.authStorage.setRuntimeUsageProvider("commandcode", commandcodeUsageProvider, getApiKey());
	});
	pi.on("session_shutdown", (_event, ctx) => {
		const storage = ctx.modelRegistry.authStorage;
		if (storage.usageProviderFor("commandcode") === commandcodeUsageProvider) {
			storage.removeRuntimeUsageProvider("commandcode");
		}
	});
}
