/**
 * demo-ai-gateway-proxy
 *
 * A single-URL, authenticated AI Gateway proxy. This Worker is deployed as a
 * route on the gateway's custom domain, which is protected by Cloudflare
 * Access. Access validates every request before this Worker runs; the Worker
 * then enforces usage attribution before forwarding to the AI Gateway origin:
 *
 * - Human users (IdP login): identified by their Access JWT — the gateway
 *   records them automatically as `cf.user_id`. `cf-aig-metadata` optional.
 * - Service tokens (CF-Access-Client-Id/Secret): must send their own
 *   `cf-aig-metadata` with a non-empty string `app` key — otherwise rejected
 *   with 400. Values are trusted, not normalized.
 *
 * Everything else — native provider path (`/anthropic/v1/messages`,
 * `/openai/v1/chat/completions`, ...), provider credentials, streaming — is
 * forwarded untouched to the AI Gateway origin.
 */

import { createRemoteJWKSet, jwtVerify } from "jose";

export interface Env {
	/** Zero Trust team domain, e.g. https://myteam.cloudflareaccess.com */
	TEAM_DOMAIN: string;
	/** AUD tag of the Access application created on the gateway's Access tab */
	ACCESS_AUD: string;
	/** The gateway custom domain this Worker is routed on, e.g. ai.example.com */
	GATEWAY_HOST: string;
}

export type Identity =
	| { kind: "user"; id: string; email: string }
	| { kind: "service"; id: string | null };

export type VerifyToken = (
	token: string,
	env: Env,
) => Promise<Record<string, unknown>>;

// JWKS clients are immutable per team domain — safe to cache at module scope.
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function jsonError(status: number, message: string): Response {
	return Response.json({ error: message }, { status });
}

/**
 * Pull the Access token off the request. The edge normally hands the Worker a
 * validated `Cf-Access-Jwt-Assertion`; also accept `cf-access-token` and a
 * bearer JWT so every documented client auth mode (cloudflared, agents, raw
 * headers) lands on the same path.
 */
export function accessTokenFromRequest(headers: Headers): string | null {
	const assertion =
		headers.get("cf-access-jwt-assertion") ?? headers.get("cf-access-token");
	if (assertion) return assertion;
	const authorization = headers.get("authorization");
	if (authorization?.startsWith("Bearer ")) {
		const token = authorization.slice(7).trim();
		// Only treat it as an Access token if it is actually a JWT, so provider
		// bearer credentials (e.g. an OpenAI key) are never mistaken for one.
		if (token.split(".").length === 3) return token;
	}
	return null;
}

/**
 * Default verification: signature against the team JWKS, issuer = team domain,
 * audience = the Access app on the gateway custom domain.
 */
export async function verifyAccessJwt(
	token: string,
	env: Env,
): Promise<Record<string, unknown>> {
	if (!env.TEAM_DOMAIN || !env.ACCESS_AUD) {
		throw new Error("TEAM_DOMAIN and ACCESS_AUD are not configured");
	}
	let jwks = jwksCache.get(env.TEAM_DOMAIN);
	if (!jwks) {
		jwks = createRemoteJWKSet(
			new URL(`${env.TEAM_DOMAIN}/cdn-cgi/access/certs`),
		);
		jwksCache.set(env.TEAM_DOMAIN, jwks);
	}
	const { payload } = await jwtVerify(token, jwks, {
		issuer: env.TEAM_DOMAIN,
		audience: env.ACCESS_AUD,
	});
	return payload;
}

/**
 * Access JWTs issued to people carry an `email` claim; service-token JWTs do
 * not (they carry `common_name`, the token's client ID). The gateway maps this
 * same distinction onto `cf.user_id`: written for user subjects only.
 */
export function identityFromClaims(claims: Record<string, unknown>): Identity {
	const email = typeof claims.email === "string" ? claims.email : null;
	const sub = typeof claims.sub === "string" ? claims.sub : null;
	if (email) return { kind: "user", id: sub ?? email, email };
	return {
		kind: "service",
		id: typeof claims.common_name === "string" ? claims.common_name : sub,
	};
}

/**
 * Usage-attribution rule. Returns an error message when the request must be
 * rejected, null when it may pass.
 *
 * - Users: metadata optional (cf.user_id is recorded automatically).
 * - Service tokens: `cf-aig-metadata` required — valid JSON object with a
 *   non-empty string `app` key. All other keys are trusted as sent.
 */
export function metadataError(
	identity: Identity,
	metadata: string | null,
): string | null {
	if (metadata === null || metadata.trim() === "") {
		if (identity.kind === "service") {
			return 'service tokens must send a cf-aig-metadata header, e.g. {"app": "my-app"}';
		}
		return null;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(metadata);
	} catch {
		return "cf-aig-metadata must be valid JSON";
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return "cf-aig-metadata must be a JSON object";
	}
	if (identity.kind === "service") {
		const app = (parsed as Record<string, unknown>).app;
		if (typeof app !== "string" || app.trim() === "") {
			return 'service tokens must include a non-empty string "app" key in cf-aig-metadata';
		}
	}
	return null;
}

function usagePage(env: Env): Response {
	const text = `demo-ai-gateway-proxy

Authenticated AI Gateway proxy on ${env.GATEWAY_HOST}.

  Human user (browser or cloudflared):
    cloudflared access curl https://${env.GATEWAY_HOST}/anthropic/v1/messages ...

  Service token (must carry its own metadata):
    curl https://${env.GATEWAY_HOST}/openai/v1/chat/completions \\
      -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" \\
      -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET" \\
      -H 'cf-aig-metadata: {"app": "my-app"}' \\
      --data '{...}'

Users are recorded as cf.user_id automatically. Service tokens are rejected
without cf-aig-metadata. Native provider paths pass through unchanged.
`;
	return new Response(text, {
		headers: { "content-type": "text/plain; charset=utf-8" },
	});
}

export async function handle(
	request: Request,
	env: Env,
	verify: VerifyToken = verifyAccessJwt,
): Promise<Response> {
	const url = new URL(request.url);

	// The Worker only behaves correctly behind the route on the gateway custom
	// domain (fetching the request URL from any other host would loop).
	if (url.hostname !== env.GATEWAY_HOST) {
		return jsonError(
			503,
			`this proxy must be routed on the gateway custom domain ${env.GATEWAY_HOST || "(GATEWAY_HOST not set)"}; got ${url.hostname}`,
		);
	}

	if (url.pathname === "/" && request.method === "GET") {
		return usagePage(env);
	}

	const token = accessTokenFromRequest(request.headers);
	if (!token) {
		return jsonError(
			401,
			"missing Access token (cf-access-jwt-assertion header)",
		);
	}

	let claims: Record<string, unknown>;
	try {
		claims = await verify(token, env);
	} catch (error) {
		return jsonError(
			401,
			`invalid Access token: ${error instanceof Error ? error.message : "unknown error"}`,
		);
	}

	const identity = identityFromClaims(claims);
	const metadataFailure = metadataError(
		identity,
		request.headers.get("cf-aig-metadata"),
	);
	if (metadataFailure) return jsonError(400, metadataFailure);

	// Forward to the AI Gateway origin: same URL, same body (streams through),
	// same headers except our own control header. cf-aig-metadata and the
	// client's provider credentials pass through exactly as sent.
	const headers = new Headers(request.headers);
	headers.delete("cf-aig-authorization");
	return fetch(new Request(request, { headers }));
}

export default {
	async fetch(request, env, ctx): Promise<Response> {
		return handle(request, env);
	},
} satisfies ExportedHandler<Env>;
