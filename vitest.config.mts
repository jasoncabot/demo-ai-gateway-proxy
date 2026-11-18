import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: "./wrangler.jsonc" },
			// Intercept every outbound fetch from the Worker and echo the
			// forwarded request back as JSON, so tests can assert on exactly
			// what would hit the AI Gateway origin.
			miniflare: {
				outboundService: async (request) => {
					const body = await request.text();
					return Response.json(
						{
							url: request.url,
							method: request.method,
							headers: Object.fromEntries(request.headers),
							body,
						},
						{ headers: { "x-mock": "origin" } },
					);
				},
			},
		}),
	],
});
