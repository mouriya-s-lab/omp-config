/**
 * ctx-post-compact-hint: after a compaction boundary finishes, inject
 * the rendered `ctx list` output plus the current main session's
 * `ctx show` (handoff + per-task timeline) directly into the session,
 * so the model sees pre-compaction context without spending tool
 * calls to fetch it.
 *
 * Rationale. Compaction replaces the working transcript with a short
 * digest. Per-context handoff, task log, and subagent history stay on
 * disk and are exactly what `ctx list` and `ctx show` surface. Nudging
 * the model to call them costs round trips and is easy to skip; this
 * plugin renders the same text through the tool's own helpers
 * (`renderCtxListText`, `renderCtxShowText`) and delivers a single
 * user message right after the boundary. The show payload is the main
 * session's own — subagents' details still require an explicit
 * `ctx show <id>` to keep the injection bounded.
 *
 * Scope. Main session only, mirroring tool-policy-nag: subagents run
 * short, decomposed slices and do not benefit from a post-compaction
 * ctx dump. Both `session_compact` and `auto_compaction_end` fire per
 * auto-compaction; a small time window dedupes them so the payload is
 * injected once per boundary.
 */

import type { ExtensionAPI, ExtensionContext } from '@oh-my-pi/pi-coding-agent';
import { renderCtxListText, renderCtxShowText } from './ctx-tool';

/**
 * Two events fire per compaction boundary. Any pair within this window
 * is treated as the same boundary; only the first triggers injection.
 */
const DEDUP_WINDOW_MS = 5_000;

/**
 * Same pattern tool-policy-nag uses to distinguish the main session
 * file from subagent session files. Kept in sync intentionally: any
 * change to OMP's naming applies to both plugins.
 */
const MAIN_SESSION_FILE_PATTERN =
    /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i;

const isMainSession = (ctx: ExtensionContext): boolean => {
    const sessionFile = ctx.sessionManager.getSessionFile();
    const fileName = sessionFile?.split(/[\\/]/).pop();
    return fileName !== undefined && MAIN_SESSION_FILE_PATTERN.test(fileName);
};

type MessagePayload = {
    readonly listText: string;
    readonly total: number;
    readonly showText: string | undefined;
    readonly showId: string | undefined;
};

const buildMessage = (payload: MessagePayload): string => {
    // Delimited block so the model treats the payload as an
    // auto-attached artifact, not as a fresh user instruction that
    // must be acted on.
    const { listText, total, showText, showId } = payload;
    const lines: string[] = [
        '<post-compact-ctx>',
        `Auto-attached after compaction. Same output as \`ctx list\` (${total} context(s)).`,
        'Sibling contexts: `ctx show <id>` for their handoff + per-task timeline;',
        'read `history://<id>` only when the timeline is not enough.',
        '',
        '## List',
        '',
        listText,
    ];
    if (showText !== undefined) {
        lines.push('', `## Current session (\`ctx show ${showId ?? ''}\`)`.trimEnd(), '', showText);
    }
    lines.push('</post-compact-ctx>');
    return lines.join('\n');
};

export default function ctxPostCompactHint(pi: ExtensionAPI): void {
    let lastSentAt = 0;

    const inject = async (reason: string, ctx: ExtensionContext): Promise<void> => {
        if (!isMainSession(ctx)) return;
        const now = Date.now();
        if (now - lastSentAt < DEDUP_WINDOW_MS) {
            pi.logger.info('Post-compaction ctx injection skipped (dedup window)', {
                reason,
                sinceLastMs: now - lastSentAt,
                windowMs: DEDUP_WINDOW_MS,
            });
            return;
        }
        // Claim the window before the async render so a paired event
        // arriving mid-flight cannot double-inject.
        lastSentAt = now;
        try {
            const [list, show] = await Promise.all([
                renderCtxListText(ctx),
                renderCtxShowText(ctx),
            ]);
            if (!list) return;
            pi.logger.info('Post-compaction ctx injected', {
                reason,
                total: list.total,
                shown: list.shown,
                hidden: list.hidden,
                showId: show?.id,
            });
            pi.sendUserMessage(
                buildMessage({
                    listText: list.text,
                    total: list.total,
                    showText: show?.text,
                    showId: show?.id,
                }),
                { deliverAs: 'steer' },
            );
        } catch (error) {
            pi.logger.warn('Post-compaction ctx injection failed', {
                reason,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    };

    pi.on('session_compact', (_event, ctx) => {
        void inject('session_compact', ctx);
    });

    pi.on('auto_compaction_end', (event, ctx) => {
        // Skip aborted / skipped / result-less finishes: the summary
        // was never produced, so there is nothing new to attach a
        // fresh context tree to.
        if (event.aborted || event.skipped === true || event.result === undefined) return;
        void inject(`auto_compaction_end:${event.action}`, ctx);
    });
}
