import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import {
	handle,
	accessTokenFromRequest,
	identityFromClaims,
	metadataError,
	type Env,
	type Identity,
	type VerifyToken,
} from "../src/index";

const GATEWAY = `https://${env.GATEWAY_HOST}`;

// Stubs standing in for Access JWTs the edge would have already validated.
const userVerify: VerifyToken = async () => ({
	iss: env.TEAM_DOMAIN,
	aud: env.ACCESS_AUD,
	sub: "access-user-123",
	email: "ada@example.com",
});

const serviceVerify: VerifyToken = async () => ({
	iss: env.TEAM_DOMAIN,
	aud: env.ACCESS_AUD,
	common_name: "ci-agent.access",
});

const failingVerify: VerifyToken = async () => {
	throw new Error("signature verification failed");
};

function post(
	path: string,
	headers: Record<string, string> = {},
	body = '{"model":"claude-sonnet-4-5","messages":[{"role":"user","content":"hi"}]}',
): Request {
	return new Request(`${GATEWAY}${path}`, {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body,
	});
}

const USER_JWT = "fake.user.jwt";
const SERVICE_JWT = "fake.service.jwt";

interface Echo {
	url: string;
	method: string;
	headers: Record<string, string>;
	body: string;
}

async function run(
	request: Request,
	verify: VerifyToken = userVerify,
): Promise<Response> {
	return handle(request, env as unknown as Env, verify);
}

describe("rejections", () => {
	it("503 when the request is not routed on the gateway custom domain", async () => {
		const response = await run(
			new Request("https://something-else.example.com/anthropic/v1/messages", {
				method: "POST",
				body: "{}",
			}),
		);
		expect(response.status).toBe(503);
	});

	it("401 when no Access token is present", async () => {
		const response = await run(post("/anthropic/v1/messages"));
		expect(response.status).toBe(401);
	});

	it("401 when the bearer token is a provider key, not a JWT", async () => {
		const response = await run(
			post("/openai/v1/chat/completions", {
				authorization: "Bearer sk-openai-key", // two segments: not a JWT
			}),
		);
		expect(response.status).toBe(401);
	});

	it("401 when token verification fails", async () => {
		const response = await run(
			post("/anthropic/v1/messages", { "cf-access-jwt-assertion": USER_JWT }),
			failingVerify,
		);
		expect(response.status).toBe(401);
		expect(await response.json()).toMatchObject({
			error: expect.stringContaining("signature verification failed"),
		});
	});

	it("400 when a service token sends no cf-aig-metadata", async () => {
		const response = await run(
			post("/openai/v1/chat/completions", {
				"cf-access-jwt-assertion": SERVICE_JWT,
			}),
			serviceVerify,
		);
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({
			error: expect.stringContaining("cf-aig-metadata"),
		});
	});

	it("400 when a service token sends invalid JSON metadata", async () => {
		const response = await run(
			post("/openai/v1/chat/completions", {
				"cf-access-jwt-assertion": SERVICE_JWT,
				"cf-aig-metadata": '{"app": ', // truncated JSON
			}),
			serviceVerify,
		);
		expect(response.status).toBe(400);
	});

	it("400 when a service token sends metadata without an app key", async () => {
		const response = await run(
			post("/openai/v1/chat/completions", {
				"cf-access-jwt-assertion": SERVICE_JWT,
				"cf-aig-metadata": '{"team": "research"}',
			}),
			serviceVerify,
		);
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({
			error: expect.stringContaining('"app"'),
		});
	});

	it("400 when a service token sends a blank app key", async () => {
		const response = await run(
			post("/openai/v1/chat/completions", {
				"cf-access-jwt-assertion": SERVICE_JWT,
				"cf-aig-metadata": '{"app": "   "}',
			}),
			serviceVerify,
		);
		expect(response.status).toBe(400);
	});

	it("400 when a user sends invalid JSON metadata", async () => {
		const response = await run(
			post("/anthropic/v1/messages", {
				"cf-access-jwt-assertion": USER_JWT,
				"cf-aig-metadata": "not json",
			}),
		);
		expect(response.status).toBe(400);
	});

	it("400 when metadata is not a JSON object", async () => {
		const response = await run(
			post("/anthropic/v1/messages", {
				"cf-access-jwt-assertion": USER_JWT,
				"cf-aig-metadata": '["not","an","object"]',
			}),
		);
		expect(response.status).toBe(400);
	});
});

describe("user path", () => {
	it("forwards untouched: body, provider credentials and path preserved, cf-aig-authorization stripped", async () => {
		const response = await run(
			post(
				"/anthropic/v1/messages",
				{
					"cf-access-jwt-assertion": USER_JWT,
					"cf-aig-authorization": "Bearer leaked-gateway-token",
					"x-api-key": "sk-ant-provider-key",
				},
			),
		);
		expect(response.status).toBe(200);
		const echo: Echo = await response.json();
		expect(echo.method).toBe("POST");
		expect(echo.url).toBe(`${GATEWAY}/anthropic/v1/messages`);
		expect(echo.headers["cf-access-jwt-assertion"]).toBe(USER_JWT);
		expect(echo.headers["x-api-key"]).toBe("sk-ant-provider-key");
		expect(echo.headers["cf-aig-authorization"]).toBeUndefined();
		expect(echo.headers["cf-aig-metadata"]).toBeUndefined();
		expect(echo.body).toContain("claude-sonnet-4-5");
	});

	it("passes user-supplied cf-aig-metadata through untouched", async () => {
		const metadata = '{"task": "demo", "cost_centre": 42}';
		const response = await run(
			post("/anthropic/v1/messages", {
				"cf-access-jwt-assertion": USER_JWT,
				"cf-aig-metadata": metadata,
			}),
		);
		const echo: Echo = await response.json();
		expect(echo.headers["cf-aig-metadata"]).toBe(metadata);
	});

	it("GET / serves a usage page", async () => {
		const response = await run(new Request(`${GATEWAY}/`));
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("text/plain");
		expect(await response.text()).toContain("demo-ai-gateway-proxy");
	});
});

describe("service path", () => {
	it("forwards a compliant service token request with metadata intact", async () => {
		const metadata = '{"app": "codex", "team": "research", "env": "prod"}';
		const response = await run(
			post(
				"/openai/v1/chat/completions",
				{
					"cf-access-jwt-assertion": SERVICE_JWT,
					"cf-aig-metadata": metadata,
					authorization: "Bearer sk-openai-key",
				},
			),
			serviceVerify,
		);
		expect(response.status).toBe(200);
		const echo: Echo = await response.json();
		expect(echo.url).toBe(`${GATEWAY}/openai/v1/chat/completions`);
		expect(echo.headers["cf-aig-metadata"]).toBe(metadata);
		expect(echo.headers["authorization"]).toBe("Bearer sk-openai-key");
		expect(echo.headers["cf-aig-authorization"]).toBeUndefined();
	});
});

describe("helpers", () => {
	it("identityFromClaims maps email to a user and common_name to a service token", () => {
		const user: Identity = identityFromClaims({
			sub: "user-1",
			email: "ada@example.com",
		});
		expect(user).toMatchObject({ kind: "user", id: "user-1" });
		const service: Identity = identityFromClaims({
			common_name: "ci-agent.access",
		});
		expect(service).toMatchObject({ kind: "service", id: "ci-agent.access" });
	});

	it("accessTokenFromRequest prefers the assertion header and falls back to a bearer JWT", () => {
		const withAssertion = new Headers({
			"cf-access-jwt-assertion": "a.b.c",
			authorization: "Bearer other.token.here",
		});
		expect(accessTokenFromRequest(withAssertion)).toBe("a.b.c");

		const bearerOnly = new Headers({ authorization: "Bearer f.a.k" });
		expect(accessTokenFromRequest(bearerOnly)).toBe("f.a.k");

		const providerKeyOnly = new Headers({ authorization: "Bearer sk-key" });
		expect(accessTokenFromRequest(providerKeyOnly)).toBeNull();
	});

	it("metadataError requires app only from service tokens", () => {
		const user: Identity = { kind: "user", id: "u", email: "u@x.io" };
		const service: Identity = { kind: "service", id: "t.access" };
		expect(metadataError(user, null)).toBeNull();
		expect(metadataError(service, '{"app": "x"}')).toBeNull();
		expect(metadataError(service, null)).toMatch(/cf-aig-metadata/);
		expect(metadataError(service, "{}")).toMatch(/"app"/);
	});
});
