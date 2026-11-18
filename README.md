# AI Gateway proxy demo

One URL that gives your AI traffic identity-aware attribution: point Claude
Code, Codex, or any OpenAI/Anthropic SDK at `ai.example.com` and every request
is authenticated with [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/) before it
reaches [AI Gateway](https://developers.cloudflare.com/ai-gateway/) — with each
request attributed to the human or application that made it.

The demo is a Worker deployed **as a route on the gateway's custom domain**.
Access runs before the Worker, so by the time the Worker sees a request it is
already authenticated. The Worker then enforces the attribution rule and
forwards the native provider request — path, provider credentials, streaming
body — untouched to the AI Gateway origin:

```
claude / codex / curl
  → https://ai.example.com/anthropic/v1/messages   (or /openai/...)
      → Cloudflare Access (edge validation: IdP users + service tokens)
      → Worker route (attribution enforcement)
      → AI Gateway origin → provider (BYOK / Unified Billing / passthrough key)
```

## The attribution rule

| Caller | Auth | Identity recorded by AI Gateway | Metadata required? |
| --- | --- | --- | --- |
| Human (IdP login via `cloudflared`, browser, agent helper) | Access JWT with a user subject | **`cf.user_id`** — written automatically from the JWT `sub`; nothing to send | Optional — anything sent passes through |
| Service token (`CF-Access-Client-Id`/`-Secret` headers) | Access Service Auth | none (no user subject) | **Required** — `cf-aig-metadata` must be a JSON object with a non-empty string `app` key, e.g. `{"app": "codex"}`; rejected with 400 otherwise |

Service-token metadata values are trusted, not normalized: send whatever keys
billing needs (`team`, `env`, `cost_centre`, ... — strings, numbers, booleans,
max 5 entries). Invalid JSON is rejected for everyone. This is the "trust the
caller" version of attribution: the gateway guarantees *user* identity
(spoof-proof `cf.user_id`), while applications self-declare `app` — the proxy
merely rejects calls that would land in the logs as an unattributable blob.

## One-time setup

All of it happens outside the code — the Worker itself holds **no secrets**.

1. **Gateway + custom domain** — Dashboard → **AI** → **AI Gateway** → create
   a gateway → **Domains** tab → add a hostname on your zone, e.g.
   `ai.example.com`. The DNS record is created for you.
2. **Provider credentials** — store keys under the gateway's provider keys
   (BYOK) or use Unified Billing. The header slot that would carry a provider
   key carries the Access token instead for agent clients (Claude Code's
   `apiKeyHelper` token, Codex's bearer `auth` block), so keys must come from
   the gateway. Requests authenticated via `Cf-Access-Jwt-Assertion` can still
   pass their own provider key in `x-api-key`/`Authorization` — it forwards
   untouched.
3. **Access on the gateway** — gateway → **Access** tab → set up. This creates
   the Access application for the custom domain. Add:
   - a policy including your IdP users (Allow),
   - a **Service Auth** policy including the service token(s) you created
     under **Zero Trust → Access controls → Service credentials**.
   Copy the application's **AUD tag** (**Zero Trust → Access controls →
   Applications → your gateway app → Additional settings**).
4. **Worker route + vars** — in `wrangler.jsonc`:
   - uncomment the `route` and point it at the gateway hostname
     (`"pattern": "ai.example.com/*"`, your `zone_name`),
   - set `GATEWAY_HOST` and `TEAM_DOMAIN`
     (`https://<team>.cloudflareaccess.com`),
   - set `ACCESS_AUD` to the AUD tag from step 3.
5. **Deploy** — `npm run deploy`.

Order matters: set up Access *before* deploying the route Worker; once the
route is live, every request to the gateway hostname flows through it.

## Use it

**Human, from the terminal** — `cloudflared` handles login + token refresh:

```sh
cloudflared access curl https://ai.example.com/anthropic/v1/messages \
  --json '{"model":"claude-sonnet-4-5","max_tokens":64,
           "messages":[{"role":"user","content":"What is AI Gateway?"}]}'
```

**Claude Code** — official pattern ([docs](https://developers.cloudflare.com/ai-gateway/integrations/coding-agents/claude-code/#use-with-cloudflare-access)):

```jsonc
// ~/.claude/settings.json
{
  "apiKeyHelper": "cloudflared access login --no-verbose https://ai.example.com",
  "env": { "ANTHROPIC_BASE_URL": "https://ai.example.com/anthropic" }
}
```

**Codex** — official pattern ([docs](https://developers.cloudflare.com/ai-gateway/integrations/coding-agents/openai-codex/#use-with-cloudflare-access)), in `~/.codex/cloudflare-aig.config.toml`:

```toml
model_provider = "cloudflare-ai-gateway"
model = "gpt-5.5"

[model_providers.cloudflare-ai-gateway]
name = "Cloudflare AI Gateway"
base_url = "https://ai.example.com/openai"
wire_api = "responses"

[model_providers.cloudflare-ai-gateway.auth]
command = "cloudflared"
args = ["access", "login", "--no-verbose", "https://ai.example.com"]
timeout_ms = 30000
refresh_interval_ms = 0
```

**opencode** — [`opencode.json`](opencode.json) in this repo points opencode's
providers at the gateway (OpenAI-compatible `baseURL` + the Access JWT header),
and [`auth.sh`](auth.sh) mints a token with `cloudflared` and launches it.

**Service token (headless / CI / an app running anywhere, not just Workers)**:

```sh
curl https://ai.example.com/openai/v1/chat/completions \
  -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" \
  -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET" \
  -H 'cf-aig-metadata: {"app": "buildme", "team": "research"}' \
  -H 'content-type: application/json' \
  --data '{"model":"gpt-4.1-mini","messages":[{"role":"user","content":"hi"}]}'
```

Drop the metadata header (or the `app` key) and the same call is rejected with
400 before it can reach the gateway — that is the enforcement. Omit nothing
else: the request still carries its provider path and credentials, and the
response streams back as-is.

**See the result**: gateway → **Logs** shows every request with `cf.user_id`
(humans), the client's `app`/custom keys (service tokens), cost, tokens, and
model. User Insights attributes spend per identity; GraphQL
`aiGatewayRequestsAdaptiveGroups` filters on `custom-metadata:{key}`.

## How it works

- `src/index.ts` verifies the edge-validated Access JWT it receives
  (`Cf-Access-Jwt-Assertion`, team JWKS, app AUD tag) and reads the `email`
  claim: present → human user; absent → service token (`common_name` claim is
  the token's client ID).
- Enforcement is one function — `metadataError()` — plus a header strip:
  client-supplied `cf-aig-authorization` is dropped so Access is the only
  credential path. Everything else is forwarded verbatim; `fetch(new
  Request(request, { headers }))` streams bodies both ways.
- Rejections never hit the gateway, so no unattributable traffic can appear in
  the logs: 401 without a token, 401 with an unverifiable one, 400 for service
  tokens missing `cf-aig-metadata`.
- The Worker refuses to serve requests whose hostname isn't `GATEWAY_HOST`
  (503) — deploying it on the default `*.workers.dev` domain would otherwise
  loop `fetch(request)` back onto itself.

## Trade-offs worth knowing

- **Single point of enforcement = single point of failure**: the route Worker
  is in the path of *all* gateway traffic. A broken Worker takes the gateway
  hostname down with it; fix is `wrangler deploy` a good version or remove the
  route. For a demo that's the point; in production consider a second
  hostname/gateway without the route as a break-glass path.
- **No bypass**: because the proxy *is* the gateway hostname, a service token
  can't reach the gateway without passing the metadata check. (With two
  separate hostnames — proxy on one, gateway on another — service tokens could
  call the gateway directly and skip attribution.)
- **One Access app, one AUD**: clients mint tokens for the gateway's own
  Access app (`cloudflared access login <gateway-url>`), so there is no
  audience-chaining between apps.
- **Email-claim discrimination**: user-vs-service is decided by the `email`
  claim. If your IdP doesn't emit email, users are treated as service tokens
  and must send `app` metadata (their requests still work; they just won't get
  automatic `cf.user_id`).
- **`wrangler dev` can't reproduce Access or the gateway origin**; the
  enforcement logic is covered by `npm test` (17 tests) with the outbound
  origin mocked.

## Run tests

```sh
npm test
```

## Troubleshooting

- **`invalid Access token: unexpected "aud" claim value`** — the `ACCESS_AUD`
  var doesn't match the Access app actually fronting the hostname. This happens
  easily when two Access apps cover the same hostname (e.g. one created
  manually, one by the gateway's Access tab). The winning app's AUD tag is
  visible in the login redirect's `meta` JWT, or in the app's **Additional
  settings**. Align `ACCESS_AUD` with it (and delete the stray app; service
  tokens must also be allowed by a policy on that same app).
- **Service token requests get a 302 login redirect** — Access doesn't know
  the client ID (token created in a different Zero Trust org than the app) or
  the policy action isn't **Service Auth** (an Allow policy including a service
  token makes Access prompt for IdP login). Check the org of both, and prefer
  turning on strict service token authentication so failures return 403
  instead of a redirect.

## Learn more

- https://developers.cloudflare.com/ai-gateway/configuration/custom-domains/
- https://developers.cloudflare.com/ai-gateway/configuration/cloudflare-access/
- https://developers.cloudflare.com/ai-gateway/observability/custom-metadata/
- https://developers.cloudflare.com/cloudflare-one/access-controls/authenticate-agents/
