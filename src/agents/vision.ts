import { complete } from "@earendil-works/pi-ai/compat";
import type { Context, TextContent } from "@earendil-works/pi-ai";
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { resizeImage } from "@earendil-works/pi-coding-agent";
import type { AppConfig } from "../config/app-config.js";

/**
 * Vision side-call — same pattern as pi's image-vision extension.
 *
 * When a non-multimodal model (e.g. Mimo, DeepSeek-flash) needs to "see" an
 * image (chart screenshot, user-uploaded photo, news page capture), this
 * function makes a single side-call to a configured vision model, gets a text
 * description back, and returns it. The original model never sees the image —
 * only the text description. No model switching.
 *
 * Default vision model: zai/glm-5v-turbo (dedicated vision, cheap).
 * Configurable via `td agent assign vision zai glm-5v-turbo` or config.json.
 */

const VISION_PROMPT = `You are a precise vision assistant for investment analysis. Analyze the attached image and describe it in detail:
- If it's a PRICE CHART: describe the trend (up/down/sideways), key support/resistance levels, any visible patterns (head & shoulders, triangles, wedges), candlestick formations, indicator values (RSI, MACD, moving averages if visible), volume bars, and any text labels or annotations.
- If it's a SCREENSHOT (news article, financial page): extract all visible text, headlines, numbers, tables, and key data points.
- If it's a TABLE/SPREADSHEET: transcribe all rows and columns exactly.
Be factual and thorough. Output only the description, no commentary.`;

export interface VisionResult {
	text: string;
	model: string;
	cached: boolean;
}

// In-process cache: key = hash of image data.
const cache = new Map<string, { text: string; at: number }>();
const CACHE_TTL = 5 * 60 * 1000; // 5 min

/**
 * Describe an image via a vision model side-call.
 *
 * @param imageData base64-encoded image data
 * @param mimeType e.g. "image/png", "image/jpeg"
 * @param config app config (for vision model assignment)
 * @param maxDimension max width/height for resize (0 = no resize)
 * @returns text description, or undefined on failure
 */
export async function describeImage(
	imageData: string,
	mimeType: string,
	config: AppConfig,
	maxDimension = 1024,
): Promise<string | undefined> {
	// Resolve vision model from config.
	const assignment = config.visionModel ?? {
		provider: "zai",
		modelId: "glm-5v-turbo",
	};
	const auth = AuthStorage.create();
	const reg = ModelRegistry.create(auth);
	const model = reg.find(assignment.provider, assignment.modelId);
	if (!model) return undefined;
	if (!reg.hasConfiguredAuth(model)) return undefined;

	// Cache check (simple hash).
	const cacheKey = imageData.slice(0, 64);
	const hit = cache.get(cacheKey);
	if (hit && Date.now() - hit.at < CACHE_TTL) return hit.text;

	// Resolve auth.
	const authRes = await reg.getApiKeyAndHeaders(model);
	if (!authRes.ok || !authRes.apiKey) return undefined;

	// Resize if needed (avoid request size limits).
	let data = imageData;
	let dataMime = mimeType;
	if (maxDimension > 0) {
		try {
			const resized = await resizeImage(
				new Uint8Array(Buffer.from(imageData, "base64")),
				mimeType,
				{ maxWidth: maxDimension, maxHeight: maxDimension },
			);
			if (resized) {
				data = resized.data;
				dataMime = resized.mimeType;
			}
		} catch {
			/* use original */
		}
	}

	// Side-call to vision model.
	const ctx: Context = {
		systemPrompt: VISION_PROMPT,
		messages: [
			{
				role: "user",
				content: [{ type: "image", data, mimeType: dataMime }],
				timestamp: Date.now(),
			},
		],
	};

	try {
		const result = await complete(model, ctx, {
			apiKey: authRes.apiKey,
			headers: authRes.headers,
			timeoutMs: 30_000,
			maxRetries: 1,
		});
		const text = result.content
			.filter((block): block is TextContent => block.type === "text")
			.map((block) => block.text)
			.join("\n")
			.trim();
		if (!text) return undefined;
		cache.set(cacheKey, { text, at: Date.now() });
		return text;
	} catch {
		return undefined;
	}
}

/** Convenience: describe a Buffer. */
export async function describeImageBuffer(
	buffer: Buffer,
	mimeType: string,
	config: AppConfig,
): Promise<string | undefined> {
	return describeImage(buffer.toString("base64"), mimeType, config);
}
