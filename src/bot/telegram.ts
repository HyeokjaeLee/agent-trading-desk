import { runAnalysis } from "../agents/debate.js";
import { recordDecision } from "../agents/memory.js";
import {
	loadSession,
	saveExchange,
	formatConversation,
	type Exchange,
} from "./session.js";
import { TAX_CONTEXT_FILE, SNAPSHOT_FILE } from "../config/paths.js";
import { existsSync, readFileSync } from "node:fs";
import { loadConfig } from "../config/app-config.js";
import { getMarketState } from "../market/market-state.js";
import { describeImage } from "../agents/vision.js";
import type { AnalysisContext } from "../agents/roles.js";
import type { MarketSnapshot } from "../types.js";

/**
 * Telegram bot — long-polling server (no external dependency).
 *
 * UX: typing indicator (...) continuously while processing → result as new message.
 * Message batching: multiple messages within 5s combined into one question.
 * Run superseding: new messages invalidate old runs.
 *
 * SECURITY: NO account/portfolio access. Cached market snapshot + tax only.
 */

const API = "https://api.telegram.org/bot";
const BATCH_MS = 5000;

type R<T> = { ok: boolean; result?: T };
interface Msg {
	chat: { id: number };
	text?: string;
	message_id: number;
	photo?: { file_id: string }[];
	caption?: string;
}
interface Upd {
	update_id: number;
	message?: Msg;
}

async function call<T>(
	t: string,
	m: string,
	b: Record<string, unknown>,
): Promise<R<T>> {
	return (
		await fetch(`${API}${t}/${m}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(b),
		})
	).json() as Promise<R<T>>;
}

/**
 * Convert markdown output to Telegram HTML.
 * Handles: ##/### → <b>, **text** → <b>, *text* → <i>, `code` → <code>,
 * --- → separator, escape HTML special chars.
 */
function mdToTelegramHtml(text: string): string {
	// 1. Escape HTML special chars first.
	let out = text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");

	// 2. Code blocks ```...``` → <pre>...</pre>
	out = out.replace(/```([\s\S]*?)```/g, (_m, code: string) => `<pre>${code.trim()}</pre>`);

	// 3. Inline code `text` → <code>text</code>
	out = out.replace(/`([^`]+)`/g, "<code>$1</code>");

	// 4. Bold **text** or __text__ → <b>text</b>
	out = out.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
	out = out.replace(/__([^_]+)__/g, "<b>$1</b>");

	// 5. Italic *text* or _text_ → <i>text</i> (after bold so ** is consumed first)
	out = out.replace(/(?<!\*)\*(?!\*)([^*\n]+)\*(?!\*)/g, "<i>$1</i>");

	// 6. Headings ## text → <b>text</b> (line-level)
	out = out.replace(/^#{2,}\s+(.+)$/gm, "<b>$1</b>");
	out = out.replace(/^#\s+(.+)$/gm, "<b>$1</b>");

	// 7. Horizontal rules --- → \n━━━━━━━\n
	out = out.replace(/^---+$/gm, "\n━━━━━━━━━━━");

	// 8. Bullet points • or - → keep as-is (Telegram renders them fine as text)
	// 9. Links [text](url) → <a href="url">text</a>
	out = out.replace(/\[([^]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

	return out;
}

async function send(
	t: string,
	c: number,
	txt: string,
	rt?: number,
): Promise<void> {
	const html = mdToTelegramHtml(txt);
	let remaining = html;
	while (remaining.length > 4000) {
		let cut = remaining.lastIndexOf("\n\n", 4000);
		if (cut < 1000) cut = remaining.lastIndexOf("\n", 4000);
		if (cut < 1000) cut = 4000;
		await call(t, "sendMessage", {
			chat_id: c,
			text: remaining.slice(0, cut),
			parse_mode: "HTML",
			reply_to_message_id: rt,
		});
		rt = undefined;
		remaining = remaining.slice(cut).trimStart();
	}
	if (remaining)
		await call(t, "sendMessage", {
			chat_id: c,
			text: remaining,
			parse_mode: "HTML",
		});
}

// ── Per-chat state ─────────────────────────────────────────────────

interface S {
	msgs: string[];
	timer: ReturnType<typeof setTimeout> | null;
	runId: number;
	photo?: string;
}
const states = new Map<number, S>();
function st(c: number): S {
	let s = states.get(c);
	if (!s) {
		s = { msgs: [], timer: null, runId: 0 };
		states.set(c, s);
	}
	return s;
}

// ── Bot-safe context (NO portfolio/account) ───────────────────────

function ctxFor(question: string, conv?: string): AnalysisContext {
	const cfg = loadConfig();
	const snap = existsSync(SNAPSHOT_FILE)
		? (JSON.parse(readFileSync(SNAPSHOT_FILE, "utf8")) as MarketSnapshot)
		: undefined;
	const tb: Record<string, MarketSnapshot["tickers"][number]> = {};
	if (snap) for (const t of snap.tickers) tb[t.ticker] = t;
	const c: AnalysisContext = {
		objective: "portfolio-recommend",
		marketState: { KR: getMarketState("KR"), US: getMarketState("US") },
		portfolio: {
			asOf: new Date().toISOString(),
			cash: [],
			holdings: [],
			accounts: [],
		},
		snapshot: snap ?? {
			generatedAt: new Date().toISOString(),
			requested: [],
			tickers: [],
			marketState: {},
		},
		tickersByYahoo: tb,
		config: cfg,
		userQuestion: question,
		taxContext: existsSync(TAX_CONTEXT_FILE)
			? readFileSync(TAX_CONTEXT_FILE, "utf8")
			: undefined,
	};
	if (conv)
		(c as unknown as { conversationHistory: string }).conversationHistory =
			conv;
	return c;
}

// ── Run desk + format result ──────────────────────────────────────

async function runDesk(q: string, hist: Exchange[]): Promise<string> {
	const outcome = await runAnalysis(
		ctxFor(q, formatConversation(hist)),
		loadConfig(),
	);
	recordDecision(outcome.recommendation);
	// Bot = Q&A mode: deliver ONLY the PM's full answer. No positions table, no warnings.
	return (
		outcome.recommendation.strategy ||
		outcome.recommendation.cashGuidance ||
		"답변을 생성하지 못했습니다."
	);
}

// ── Process: typing loop → result ─────────────────────────────────

async function processChat(t: string, c: number): Promise<void> {
	const s = st(c);
	const msgs = [...s.msgs];
	const photo = s.photo;
	s.msgs = [];
	s.photo = undefined;
	s.runId++;
	const my = s.runId;
	const hist = loadSession(c);

	// Typing indicator loop (every 4s until done).
	const ti = setInterval(() => {
		void call(t, "sendChatAction", { chat_id: c, action: "typing" });
	}, 4000);
	void call(t, "sendChatAction", { chat_id: c, action: "typing" });

	try {
		let q = msgs.join(" ").trim();
		if (photo) {
			const desc = await describeImage(photo, "image/jpeg", loadConfig());
			if (desc)
				q = `[사용자가 이미지 전송. 비전 분석:\n${desc.slice(0, 800)}]\n\n${q || "이 차트를 분석해줘."}`;
		}
		const answer = await runDesk(q || "투자 분석을 해줘", hist);
		clearInterval(ti);
		if (s.runId !== my) return; // superseded
		await send(t, c, answer);
		saveExchange(c, q || "(이미지)", answer);
	} catch (e) {
		clearInterval(ti);
		if (s.runId !== my) return;
		await send(
			t,
			c,
			`❌ ${e instanceof Error ? e.message.slice(0, 300) : String(e)}`,
		);
	}
}

// ── Server ────────────────────────────────────────────────────────

export async function startTelegramBot(token: string): Promise<void> {
	let offset = 0;
	const me = await call<{ username?: string }>(token, "getMe", {});
	if (!me.ok) {
		console.error("토큰 오류");
		process.exit(1);
	}
	console.log(`✅ @${me.result?.username}`);

	for (;;) {
		try {
			const d = await call<Upd[]>(token, "getUpdates", { offset, timeout: 30 });
			if (!d.ok || !d.result) continue;
			for (const u of d.result) {
				offset = u.update_id + 1;
				const m = u.message;
				if (!m) continue;
				const cid = m.chat.id;
				const s = st(cid);

				if (m.text) {
					s.msgs.push(m.text);
					if (s.timer) clearTimeout(s.timer);
					s.timer = setTimeout(() => void processChat(token, cid), BATCH_MS);
				}

				if (m.photo?.length) {
					try {
						const fi = await call<{ file_path?: string }>(token, "getFile", {
							file_id: m.photo[m.photo.length - 1]!.file_id,
						});
						if (fi.ok && fi.result?.file_path) {
							const buf = Buffer.from(
								await (
									await fetch(`${API}${token}/${fi.result.file_path}`)
								).arrayBuffer(),
							);
							s.photo = buf.toString("base64");
							if (m.caption) s.msgs.push(m.caption);
							if (s.timer) clearTimeout(s.timer);
							s.timer = setTimeout(
								() => void processChat(token, cid),
								BATCH_MS,
							);
						}
					} catch {
						/* ignore */
					}
				}
			}
		} catch (e) {
			console.error(e instanceof Error ? e.message : String(e));
			await new Promise((r) => setTimeout(r, 5000));
		}
	}
}
