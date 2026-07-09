/**
 * Minimal HTTPS helper over the built-in fetch (Node 22 / Bun). Replaces undici
 * so the broker layer has no extra HTTP dependency.
 */

export interface HttpResponse {
	status: number;
	text: string;
}

export async function http(
	url: string,
	init: RequestInit & { method: string },
): Promise<HttpResponse> {
	const res = await fetch(url, init);
	const text = await res.text();
	return { status: res.status, text };
}

export function safeJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}
