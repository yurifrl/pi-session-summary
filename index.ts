/**
 * pi-session-summary — belowEditor widget showing a one-line LLM-generated session summary.
 *
 * Triggers on agent_end, debounced (default 120s).  Uses a separately configured
 * model (default google/gemini-2.5-flash-lite) so the main conversation model is untouched.
 *
 * NOTE: openai-codex does NOT work for standalone complete() calls
 * (returns "invalid_workspace_selected"). Use google, openai, anthropic, etc.
 *
 * Between LLM updates the widget shows a hybrid line:
 *   "[compaction | last summary] + N new turns since"
 * so the user always has recency context.
 */

import { complete } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

// ── Configuration ────────────────────────────────────────────────────
const SUMMARY_PROVIDER = "anthropic";
const SUMMARY_MODEL_ID = "claude-haiku-4-5";
const DEBOUNCE_SECONDS = 120;
const MAX_TOKENS = 300;
/** After this many tokens of new conversation we re-summarize from scratch
 *  instead of asking to update the previous line. */
const RESUMMARIZE_TOKEN_THRESHOLD = 10_000;

// ── Types ────────────────────────────────────────────────────────────

interface ContentBlock {
	type?: string;
	text?: string;
	name?: string;
	arguments?: Record<string, unknown>;
}

interface SessionEntry {
	type: string;
	message?: {
		role?: string;
		content?: unknown;
		toolName?: string;
		toolCallId?: string;
		isError?: boolean;
	};
}

// ── Helpers ──────────────────────────────────────────────────────────

/** Rough token estimate: ~4 chars per token. */
function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

/** Extract only user+assistant text from a content field, collapsing tool i/o. */
function renderContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";

	const parts: string[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const b = block as ContentBlock;
		if (b.type === "text" && typeof b.text === "string") {
			parts.push(b.text);
		} else if (b.type === "toolCall" && typeof b.name === "string") {
			parts.push(`[tool call: ${b.name}]`);
		}
	}
	return parts.join("\n");
}

/** Build a compact conversation string from session entries.
 *  Skips tool results except for a tiny marker. */
function buildConversation(entries: SessionEntry[]): string {
	const lines: string[] = [];

	for (const entry of entries) {
		if (entry.type !== "message" || !entry.message?.role) continue;
		const role = entry.message.role;

		if (role === "user") {
			const text = renderContent(entry.message.content).trim();
			if (text) lines.push(`User: ${text}`);
		} else if (role === "assistant") {
			const text = renderContent(entry.message.content).trim();
			if (text) lines.push(`Assistant: ${text}`);
		} else if (role === "toolResult") {
			// Tiny marker only
			const contentStr = renderContent(entry.message.content);
			const bytes = new TextEncoder().encode(contentStr).length;
			lines.push(`[tool result: ${bytes} bytes]`);
		} else if (role === "compactionSummary") {
			const text = renderContent(entry.message.content).trim();
			if (text) lines.push(`[compaction summary: ${text}]`);
		}
	}

	return lines.join("\n");
}

/** Get the most recent compaction summary from the branch (if any). */
function getCompactionSummary(entries: SessionEntry[]): string | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i];
		if (e.type === "message" && e.message?.role === "compactionSummary") {
			const text = renderContent(e.message.content).trim();
			if (text) return text;
		}
		// Also check compaction entry type
		if ((e as any).type === "compaction" && typeof (e as any).summary === "string") {
			return (e as any).summary;
		}
	}
	return undefined;
}

// ── Extension ────────────────────────────────────────────────────────

export default function sessionSummaryExtension(pi: ExtensionAPI) {
	// ── State ─────────────────────────────────────────────────────────
	let lastSummary = "";          // last successful LLM-generated summary
	let lastSummaryConvTokens = 0; // token count of conversation when last summary was made
	let turnsSinceSummary = 0;     // agent_end calls since last summary update
	let lastSummaryTime = 0;       // Date.now() of last summary completion
	let pendingLLMCall = false;    // is an LLM call in flight?
	let lastError = "";            // last error (code only)
	let latestCtx: ExtensionContext | undefined; // most recent ctx for widget updates

	// ── Widget rendering ──────────────────────────────────────────────

	function updateWidget(ctx: ExtensionContext) {
		if (!ctx.hasUI) return;

		// Build the display line
		const parts: string[] = [];

		// Primary content: compaction + last summary
		const branch = ctx.sessionManager.getBranch();
		const compaction = getCompactionSummary(branch);

		if (compaction || lastSummary) {
			if (compaction && lastSummary) {
				// Truncate compaction to keep it short
				const shortCompaction = compaction.length > 80
					? compaction.slice(0, 77) + "..."
					: compaction;
				parts.push(`${shortCompaction} | ${lastSummary}`);
			} else if (lastSummary) {
				parts.push(lastSummary);
			} else if (compaction) {
				const shortCompaction = compaction.length > 120
					? compaction.slice(0, 117) + "..."
					: compaction;
				parts.push(shortCompaction);
			}
		}

		if (parts.length === 0 && turnsSinceSummary === 0) {
			// Nothing to show yet
			ctx.ui.setWidget("session-summary", undefined);
			return;
		}

		let line = parts.join("");

		// Staleness indicators
		if (turnsSinceSummary > 0) {
			if (lastSummary) {
				// Summary exists but is stale — prepend age
				line = `[${turnsSinceSummary} turn${turnsSinceSummary > 1 ? "s" : ""} ago] ${line}`;
			} else {
				// No summary yet — show turn count as the content
				const turnsLabel = turnsSinceSummary === 1 ? "1 new turn" : `${turnsSinceSummary} new turns`;
				line = line ? `${line} + ${turnsLabel}` : turnsLabel;
			}
		}

		// Append error code if any
		if (lastError) {
			line = `${line} [err: ${lastError}]`;
		}

		// Truncate to terminal width to prevent wrapping
		const cols = process.stdout.columns || 120;
		if (line.length > cols - 2) {
			line = line.slice(0, cols - 5) + "...";
		}

		ctx.ui.setWidget("session-summary", [line], { placement: "belowEditor" });
	}

	// ── LLM summary generation ────────────────────────────────────────

	async function generateSummary(ctx: ExtensionContext) {
		if (pendingLLMCall) return;

		const model = ctx.modelRegistry.find(SUMMARY_PROVIDER, SUMMARY_MODEL_ID);
		if (!model) {
			lastError = "MODEL_NOT_FOUND";
			updateWidget(ctx);
			return;
		}

		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth?.ok || !auth.apiKey) {
			lastError = "NO_API_KEY";
			updateWidget(ctx);
			return;
		}

		const branch = ctx.sessionManager.getBranch();
		const conversation = buildConversation(branch);
		const convTokens = estimateTokens(conversation);

		if (!conversation.trim()) return;

		// Decide: update previous summary or re-summarize from scratch
		const tokensSinceLastSummary = convTokens - lastSummaryConvTokens;
		const shouldResummarize = !lastSummary || tokensSinceLastSummary >= RESUMMARIZE_TOKEN_THRESHOLD;

		let prompt: string;
		if (shouldResummarize) {
			prompt = [
				"Summarize this coding session in a SINGLE line (max ~200 chars).",
				"Include: what the user is working on, current progress, and immediate next step.",
				"Be specific and concrete, not vague.",
				"",
				"<conversation>",
				conversation,
				"</conversation>",
			].join("\n");
		} else {
			prompt = [
				"Here is the previous one-line summary of this coding session:",
				`"${lastSummary}"`,
				"",
				"Here is the conversation since that summary was generated:",
				"<conversation>",
				conversation,
				"</conversation>",
				"",
				"Update the summary ONLY if there has been material progress or a change in direction.",
				"If nothing material changed, return the previous summary exactly.",
				"Output a SINGLE line (max ~200 chars): what the user is working on, current progress, next step.",
			].join("\n");
		}

		pendingLLMCall = true;

		// Fire-and-forget: non-blocking async LLM call
		complete(model, {
			messages: [{
				role: "user" as const,
				content: [{ type: "text" as const, text: prompt }],
				timestamp: Date.now(),
			}],
		}, {
			apiKey: auth.apiKey,
			headers: auth.headers,
			maxTokens: MAX_TOKENS,
			sessionId: ctx.sessionManager.getSessionId(),
		} as any)
			.then((response) => {
				// Handle provider-level errors (e.g. codex "invalid_workspace_selected")
				if (response.stopReason === "error") {
					const errMsg = response.errorMessage || "unknown provider error";
					// Try to extract a short code from JSON error messages
					let code = errMsg;
					try {
						const parsed = JSON.parse(errMsg);
						code = parsed?.detail?.code || parsed?.error?.code || errMsg;
					} catch {}
					throw new Error(String(code));
				}

				const text = response.content
					.filter((c): c is { type: "text"; text: string } => c.type === "text")
					.map((c) => c.text)
					.join(" ")
					.trim()
					// Collapse to single line
					.replace(/\n+/g, " ");

				if (text) {
					lastSummary = text;
					lastSummaryConvTokens = convTokens;
					turnsSinceSummary = 0;
					lastSummaryTime = Date.now();
					lastError = "";
				}
			})
			.catch((err) => {
				const msg = err?.message || String(err);
				const code = err?.code || err?.status || err?.name || msg.slice(0, 60);
				lastError = String(code);
				console.error("[session-summary] LLM error:", msg);
			})
			.finally(() => {
				pendingLLMCall = false;
				if (latestCtx) updateWidget(latestCtx);
			});
	}

	// ── Event handlers ────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		// Restore state from custom entries
		lastSummary = "";
		lastSummaryConvTokens = 0;
		turnsSinceSummary = 0;
		lastSummaryTime = 0;
		pendingLLMCall = false;
		lastError = "";
		latestCtx = ctx;

		// Check for persisted summary
		for (const entry of ctx.sessionManager.getEntries()) {
			if ((entry as any).type === "custom" && (entry as any).customType === "session-summary") {
				const data = (entry as any).data;
				if (data?.summary) {
					lastSummary = data.summary;
					lastSummaryConvTokens = data.convTokens ?? 0;
				}
			}
		}

		updateWidget(ctx);
	});

	pi.on("session_switch", async (_event, ctx) => {
		lastSummary = "";
		lastSummaryConvTokens = 0;
		turnsSinceSummary = 0;
		lastSummaryTime = 0;
		pendingLLMCall = false;
		lastError = "";
		latestCtx = ctx;

		// Restore from new session
		for (const entry of ctx.sessionManager.getEntries()) {
			if ((entry as any).type === "custom" && (entry as any).customType === "session-summary") {
				const data = (entry as any).data;
				if (data?.summary) {
					lastSummary = data.summary;
					lastSummaryConvTokens = data.convTokens ?? 0;
				}
			}
		}

		updateWidget(ctx);
	});

	pi.on("agent_end", async (_event, ctx) => {
		latestCtx = ctx;
		turnsSinceSummary++;
		updateWidget(ctx);

		// Debounce: only call LLM if enough time has passed
		const now = Date.now();
		const elapsed = now - lastSummaryTime;
		if (elapsed < DEBOUNCE_SECONDS * 1000 && lastSummary) {
			// Too soon — widget already shows hybrid line with turn count
			return;
		}

		// Generate summary asynchronously (non-blocking)
		generateSummary(ctx);
	});

	// Persist summary on shutdown so it survives restarts
	pi.on("session_shutdown", async (_event, _ctx) => {
		if (lastSummary) {
			pi.appendEntry("session-summary", {
				summary: lastSummary,
				convTokens: lastSummaryConvTokens,
			});
		}
	});
}
