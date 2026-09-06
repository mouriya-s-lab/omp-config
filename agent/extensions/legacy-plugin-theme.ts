import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { setThemeInstance, theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

// The npm CLI is bundled, while legacy plugins import a separate source module
// graph. Give that graph the active host theme before plugins render Markdown.
export default function legacyPluginTheme(pi: ExtensionAPI): void {
	function syncTheme(ctx: ExtensionContext): void {
		if (ctx.hasUI && ctx.ui.theme !== theme) setThemeInstance(ctx.ui.theme);
	}

	pi.on("session_start", (_event, ctx) => syncTheme(ctx));
	pi.on("input", (_event, ctx) => {
		syncTheme(ctx);
		return { action: "continue" };
	});
	pi.on("before_agent_start", (_event, ctx) => syncTheme(ctx));
}
