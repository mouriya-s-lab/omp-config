import type { ExtensionAPI } from '@oh-my-pi/pi-coding-agent';

const PATCH = Symbol.for('mouriya.omp.v2-compaction-timeout');
const ORIGINAL_TIMEOUT_MS = 180_000;
const COMPACTION_TIMEOUT_MS = 600_000;
type PatchedTimeout = typeof AbortSignal.timeout & { [PATCH]?: true };

/** Process-wide: preserve unrelated deadlines and the caller's cancellation signal. */
export default function v2CompactionTimeout(pi: ExtensionAPI): void {
    const original: PatchedTimeout = AbortSignal.timeout;
    if (original[PATCH]) return;

    const patched: PatchedTimeout = function ompV2CompactionTimeout(milliseconds: number): AbortSignal {
        // Match on the timeout value alone: the only 180_000 AbortSignal.timeout
        // call sites in pi-agent-core are the compaction constants
        // (V2_COMPACTION_TIMEOUT_MS, REMOTE_COMPACTION_TIMEOUT_MS); other 180s
        // values are Bun.sleep backoff, not abort deadlines. Stack-based sniffing
        // cannot work here — the installed omp is a minified bundle with no
        // source paths or original function names in stack frames.
        const isCompactionTimeout = milliseconds === ORIGINAL_TIMEOUT_MS;
        if (isCompactionTimeout) {
            pi.logger.info('V2 compaction timeout extended', {
                originalTimeoutMs: ORIGINAL_TIMEOUT_MS,
                timeoutMs: COMPACTION_TIMEOUT_MS,
            });
        }
        return original.call(AbortSignal, isCompactionTimeout ? COMPACTION_TIMEOUT_MS : milliseconds);
    };
    patched[PATCH] = true;
    AbortSignal.timeout = patched;
    pi.logger.info('V2 compaction timeout extension installed', { timeoutMs: COMPACTION_TIMEOUT_MS });
}
