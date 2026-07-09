import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { APP_DIR } from "../config/paths.js";

/**
 * Per-chat session store for conversation context.
 * Each chat keeps the last N exchanges (question + answer) so follow-up
 * questions are answered with awareness of the ongoing conversation.
 */

const SESSIONS_DIR = join(APP_DIR, "chat-sessions");
const MAX_HISTORY = 5;

export interface Exchange {
	question: string;
	answer: string;
	timestamp: string;
}

function sessionFile(chatId: number): string {
	return join(SESSIONS_DIR, `${chatId}.json`);
}

/** Load conversation history for a chat. */
export function loadSession(chatId: number): Exchange[] {
	if (!existsSync(sessionFile(chatId))) return [];
	try {
		const raw = readFileSync(sessionFile(chatId), "utf8");
		return JSON.parse(raw) as Exchange[];
	} catch {
		return [];
	}
}

/** Save a new exchange to the chat session (keeps last MAX_HISTORY). */
export function saveExchange(
	chatId: number,
	question: string,
	answer: string,
): void {
	if (!existsSync(SESSIONS_DIR)) mkdirSync(SESSIONS_DIR, { recursive: true });
	const history = loadSession(chatId);
	history.push({
		question,
		answer: answer.slice(0, 2000),
		timestamp: new Date().toISOString(),
	});
	while (history.length > MAX_HISTORY) history.shift();
	writeFileSync(sessionFile(chatId), JSON.stringify(history, null, 2), {
		mode: 0o600,
	});
}

/** Format conversation history for agent injection. */
export function formatConversation(history: Exchange[]): string {
	if (history.length === 0) return "";
	return history
		.map(
			(h, i) =>
				`[대화 ${i + 1}] 사용자: ${h.question}\n데스크: ${h.answer.slice(0, 500)}`,
		)
		.join("\n\n");
}
