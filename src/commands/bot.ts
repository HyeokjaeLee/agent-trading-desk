import type { Command } from "commander";
import { startTelegramBot } from "../bot/telegram.js";
import { out, fail } from "../output.js";

export function registerBotCommands(root: Command): void {
	root
		.command("bot")
		.description("텔레그램 봇 서버를 시작합니다 (td ask + 이미지 비전 지원)")
		.option(
			"-t, --token <token>",
			"텔레그램 봇 토큰 (또는 TELEGRAM_BOT_TOKEN env)",
		)
		.action(async (opts) => {
			const token = opts.token ?? process.env.TELEGRAM_BOT_TOKEN;
			if (!token) {
				fail(
					"봇 토큰이 필요합니다. @BotFather에서 토큰을 발급받아 --token <TOKEN> 또는 TELEGRAM_BOT_TOKEN 환경변수로 설정하세요.",
					2,
				);
			}
			out("텔레그램 봇을 시작합니다...");
			await startTelegramBot(token);
		});
}
