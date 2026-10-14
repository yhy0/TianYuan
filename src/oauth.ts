import { ensureSteward } from "./actions";
import { getAgentById, getAgentByToken } from "./queries";
import type { AgentRow, Env } from "./types";
import {
  assertBinds,
  cleanText,
  clientIp,
  exec,
  json,
  PUBLIC_CORS,
  randomToken,
  safeEqual,
  sha256,
  tooFast,
} from "./util";

export const OAUTH_SCOPE = "tianyuan";

const ACCESS_TTL = 60 * 60 * 1000;
const REFRESH_TTL = 30 * 24 * 60 * 60 * 1000;
const CODE_TTL = 5 * 60 * 1000;
const CLIENT_ASSERTION_TYPE = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";
const TOKEN_SQL = `INSERT INTO oauth_tokens (
  token_hash, kind, client_id, agent_id, agent_token_hash, resource, scope, expires_at, created_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;

interface OauthClient {
  id: string;
  name: string;
  redirectUris: string[];
  allowsNone: boolean;
  jwksUri: string | null;
}

interface AuthContext {
  issuer: string;
  client: OauthClient;
  redirectUri: string;
  state: string;
  challenge: string;
  resource: string;
  scope: string;
}

interface CodeRow {
  client_id: string;
  agent_id: string;
  agent_token_hash: string;
  redirect_uri: string;
  code_challenge: string;
  resource: string;
  scope: string;
  expires_at: number;
  used_at: number | null;
}

interface TokenRow {
  kind: string;
  client_id: string;
  agent_id: string;
  agent_token_hash: string;
  resource: string;
  expires_at: number;
}

interface JwtHeader {
  alg?: unknown;
  kid?: unknown;
  typ?: unknown;
}

interface Jwk {
  kid?: string;
  n: string;
  e: string;
}

type ClientFailure = "invalid" | "unreachable" | "storage";
type ClientResult = { ok: true; client: OauthClient } | { ok: false; reason: ClientFailure };
type Payload = { form: URLSearchParams; json: Record<string, unknown> | null };

const jwksCache = new Map<string, { keys: Jwk[]; expires: number }>();

export function resourceOf(issuer: string): string {
  return `${issuer}/mcp`;
}

export function wwwAuthenticate(issuer: string): string {
  const metadata = `${issuer}/.well-known/oauth-protected-resource`;
  return `Bearer resource_metadata="${metadata}", scope="${OAUTH_SCOPE}", error="invalid_token", error_description="Login required"`;
}

export function authToolResult(issuer: string): Record<string, unknown> {
  const challenge = wwwAuthenticate(issuer);
  return {
    content: [{
      type: "text",
      text: "需要入界授权。网页版 ChatGPT 请按提示登录天元界；若请求头里已有令牌，则该令牌无效或已更换。",
    }],
    isError: true,
    _meta: { "mcp/www_authenticate": [`'${challenge}'`] },
  };
}

function authRefusal(agent: AgentRow): string | null {
  if (agent.status === "banned") return "此身已被拉黑，认证不通过。";
  if (agent.status !== "active") return "此身已被冻结，不能发言。";
  return null;
}

export async function resolveBearer(
  env: Env,
  token: string,
  issuer: string,
): Promise<{ agent: AgentRow | null; error?: string }> {
  try {
    if (token.startsWith("tyat_")) return await agentFromAccess(env, token, issuer);
    if (env.ADMIN_TOKEN && safeEqual(token, env.ADMIN_TOKEN)) {
      const steward = await ensureSteward(env.DB, token);
      if (!steward.ok) return { agent: null, error: steward.error };
    }
    const agent = await getAgentByToken(env.DB, await sha256(`token:${token}`));
    const refusal = agent ? authRefusal(agent) : null;
    if (refusal) return { agent: null, error: refusal };
    return { agent };
  } catch (error) {
    if (missingTable(error)) return { agent: null };
    throw error;
  }
}

export async function purgeOauth(db: D1Database): Promise<void> {
  try {
    const now = Date.now();
    await exec(db, `DELETE FROM oauth_codes WHERE expires_at < ? OR (used_at IS NOT NULL AND used_at < ?)`, [now, now - 86_400_000]);
    await exec(db, `DELETE FROM oauth_tokens WHERE expires_at < ?`, [now]);
  } catch (error) {
    if (!missingTable(error)) console.error(error);
  }
}

export async function handleWellKnown(request: Request, url: URL): Promise<Response> {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: PUBLIC_CORS });
  if (request.method !== "GET" && request.method !== "HEAD") return methodNotAllowed("GET, HEAD");
  const issuer = new URL(request.url).origin;
  const path = url.pathname;
  let body: unknown = null;
  if (path === "/.well-known/oauth-protected-resource" || path.startsWith("/.well-known/oauth-protected-resource/")) {
    body = {
      resource: resourceOf(issuer),
      authorization_servers: [issuer],
      scopes_supported: [OAUTH_SCOPE],
      bearer_methods_supported: ["header"],
      resource_documentation: `${issuer}/`,
    };
  } else if (path === "/.well-known/oauth-authorization-server" || path === "/.well-known/openid-configuration") {
    body = authorizationServer(issuer);
  }
  if (!body) return json({ error: "没有这份元数据。" }, 404, PUBLIC_CORS);
  const response = json(body, 200, PUBLIC_CORS);
  if (request.method === "HEAD") return new Response(null, { status: 200, headers: response.headers });
  return response;
}

export async function handleOauth(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: PUBLIC_CORS });
  if (url.pathname === "/oauth/authorize") {
    if (request.method !== "GET" && request.method !== "POST") return methodNotAllowed("GET, POST");
    return handleAuthorize(request, env, url);
  }
  if (url.pathname === "/oauth/token") {
    if (request.method !== "POST") return methodNotAllowed("POST");
    return handleToken(request, env);
  }
  if (url.pathname === "/oauth/register") {
    if (request.method !== "POST") return methodNotAllowed("POST");
    return handleRegister(request, env);
  }
  return json({ error: "没有这个入口。" }, 404, PUBLIC_CORS);
}

function authorizationServer(issuer: string): Record<string, unknown> {
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
    scopes_supported: [OAUTH_SCOPE],
  };
}

async function handleAuthorize(request: Request, env: Env, url: URL): Promise<Response> {
  const issuer = new URL(request.url).origin;
  if (await tooFast(env.API_LIMIT, `oauth-auth:${clientIp(request)}`)) return html(pageError("请求过于频繁，请稍后再试。"));
  const payload = request.method === "POST" ? await readPayload(request) : { form: url.searchParams, json: null };
  if (payload instanceof Response) return payload;
  const prepared = await prepareAuthorize(env, issuer, payload.form);
  if (prepared instanceof Response) return prepared;
  if (request.method === "GET") return html(consentPage(prepared, ""), prepared.redirectUri);
  const token = normalizePastedToken(payload.form.get("token") || "");
  if (!token) return html(consentPage(prepared, "请填写入界令牌。"), prepared.redirectUri);
  if (token.length > 200) return html(consentPage(prepared, "入界令牌无效。"), prepared.redirectUri);
  const identity = await agentFromCredential(env, token);
  if (!identity.ok) return html(consentPage(prepared, identity.error), prepared.redirectUri);
  const code = randomToken("tyac_");
  const now = Date.now();
  try {
    await exec(
      env.DB,
      `INSERT INTO oauth_codes (
        code_hash, client_id, agent_id, agent_token_hash, redirect_uri,
        code_challenge, resource, scope, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        await sha256(`oauth-code:${code}`),
        prepared.client.id,
        identity.agent.id,
        identity.agent.token_hash,
        prepared.redirectUri,
        prepared.challenge,
        prepared.resource,
        prepared.scope,
        now + CODE_TTL,
      ],
    );
  } catch (error) {
    if (missingTable(error)) return html(pageError("授权存储还没有就绪。请先完成数据库迁移。"));
    throw error;
  }
  return redirectClient(issuer, prepared.redirectUri, { code, state: prepared.state });
}

async function prepareAuthorize(env: Env, issuer: string, params: URLSearchParams): Promise<AuthContext | Response> {
  const clientId = (params.get("client_id") || "").trim();
  const redirectUri = (params.get("redirect_uri") || "").trim();
  if (!clientId || clientId.length > 300 || redirectUri.length > 500) return html(pageError("授权请求不正确。"));
  const loaded = await loadClient(env, clientId);
  if (!loaded.ok) return html(pageError(clientFailureText(loaded.reason)));
  if (!redirectUri || !clientAllowsRedirect(loaded.client, redirectUri)) return html(pageError("回调地址不被允许。"));
  const state = (params.get("state") || "").trim();
  if (state.length > 512 || /[\u0000\r\n]/.test(state)) {
    return redirectClient(issuer, redirectUri, { error: "invalid_request", error_description: "state rejected" });
  }
  if ((params.get("response_type") || "") !== "code") {
    return redirectClient(issuer, redirectUri, { error: "unsupported_response_type", error_description: "Only code is supported", state });
  }
  const challenge = (params.get("code_challenge") || "").trim();
  if ((params.get("code_challenge_method") || "") !== "S256" || !/^[A-Za-z0-9_-]{43,128}$/.test(challenge)) {
    return redirectClient(issuer, redirectUri, { error: "invalid_request", error_description: "PKCE S256 required", state });
  }
  const resourceInput = (params.get("resource") || "").trim();
  if (resourceInput.length > 300) {
    return redirectClient(issuer, redirectUri, { error: "invalid_target", error_description: "resource rejected", state });
  }
  const resource = canonicalResource(issuer, resourceInput);
  if (!resource) return redirectClient(issuer, redirectUri, { error: "invalid_target", error_description: "resource rejected", state });
  const scopeInput = (params.get("scope") || "").trim();
  if (scopeInput.length > 200 || (scopeInput && !scopeInput.split(/\s+/).includes(OAUTH_SCOPE))) {
    return redirectClient(issuer, redirectUri, { error: "invalid_scope", error_description: "scope rejected", state });
  }
  return { issuer, client: loaded.client, redirectUri, state, challenge, resource, scope: OAUTH_SCOPE };
}

async function handleToken(request: Request, env: Env): Promise<Response> {
  const issuer = new URL(request.url).origin;
  if (await tooFast(env.API_LIMIT, `oauth-token:${clientIp(request)}`)) {
    return oauthError("temporarily_unavailable", "请求过于频繁。", 429);
  }
  const payload = await readPayload(request);
  if (payload instanceof Response) return payload;
  const params = payload.form;
  const clientId = (params.get("client_id") || "").trim();
  if (!clientId || clientId.length > 300) return oauthError("invalid_client", "不认识这个客户端。", 401);
  const loaded = await loadClient(env, clientId);
  if (!loaded.ok) return clientTokenError(loaded.reason);
  const authError = await authenticateTokenClient(issuer, loaded.client, params);
  if (authError) {
    console.error(`OAuth 客户端认证被拒绝：${authError}`);
    return oauthError("invalid_client", authError, 401);
  }
  const grant = params.get("grant_type") || "";
  if (grant === "authorization_code") return exchangeCode(env, issuer, loaded.client, params);
  if (grant === "refresh_token") return exchangeRefresh(env, issuer, loaded.client, params);
  return oauthError("unsupported_grant_type", "只支持授权码和刷新令牌。");
}

async function exchangeCode(env: Env, issuer: string, client: OauthClient, params: URLSearchParams): Promise<Response> {
  const code = (params.get("code") || "").trim();
  const redirectUri = (params.get("redirect_uri") || "").trim();
  const verifier = (params.get("code_verifier") || "").trim();
  if (!code.startsWith("tyac_") || code.length > 80 || !redirectUri || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) {
    return oauthError("invalid_grant", "授权码无效。");
  }
  const requested = (params.get("resource") || "").trim();
  if (requested.length > 300) return oauthError("invalid_target", "resource rejected");
  const resource = canonicalResource(issuer, requested);
  let row: CodeRow | null;
  try {
    row = await runCode(env.DB, await sha256(`oauth-code:${code}`));
  } catch (error) {
    if (missingTable(error)) return oauthError("server_error", "授权存储还没有就绪。", 500);
    throw error;
  }
  const now = Date.now();
  if (!row || row.used_at || row.expires_at <= now) return oauthError("invalid_grant", "授权码无效。");
  if (!safeEqual(row.client_id, client.id) || !safeEqual(row.redirect_uri, redirectUri)) {
    return oauthError("invalid_grant", "授权码无效。");
  }
  if (!resource || resource !== row.resource) return oauthError("invalid_target", "resource rejected");
  if (!safeEqual(await s256(verifier), row.code_challenge)) return oauthError("invalid_grant", "授权码无效。");
  const updated = await exec(
    env.DB,
    `UPDATE oauth_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?`,
    [now, await sha256(`oauth-code:${code}`), now],
  );
  if ((updated.meta.changes ?? 0) !== 1) return oauthError("invalid_grant", "授权码无效。");
  const agent = await getAgentById(env.DB, row.agent_id);
  if (!agent || !safeEqual(agent.token_hash, row.agent_token_hash)) {
    return oauthError("invalid_grant", "入界身份已失效，请重新授权。");
  }
  const refusal = authRefusal(agent);
  if (refusal) return oauthError("invalid_grant", refusal);
  return issueTokens(env, client, agent, row.resource, row.scope, true);
}

async function exchangeRefresh(env: Env, issuer: string, client: OauthClient, params: URLSearchParams): Promise<Response> {
  const refresh = (params.get("refresh_token") || "").trim();
  if (!refresh.startsWith("tyrt_") || refresh.length > 80) return oauthError("invalid_grant", "刷新令牌无效。");
  const requested = (params.get("resource") || "").trim();
  if (requested.length > 300) return oauthError("invalid_target", "resource rejected");
  const resource = canonicalResource(issuer, requested);
  let row: TokenRow | null;
  try {
    row = await runToken(env.DB, await sha256(`oauth-refresh:${refresh}`));
  } catch (error) {
    if (missingTable(error)) return oauthError("server_error", "授权存储还没有就绪。", 500);
    throw error;
  }
  if (!row || row.kind !== "refresh" || row.expires_at <= Date.now() || !safeEqual(row.client_id, client.id)) {
    return oauthError("invalid_grant", "刷新令牌无效。");
  }
  if (!resource || resource !== row.resource) return oauthError("invalid_target", "resource rejected");
  const agent = await getAgentById(env.DB, row.agent_id);
  if (!agent || !safeEqual(agent.token_hash, row.agent_token_hash)) {
    return oauthError("invalid_grant", "入界身份已失效，请重新授权。");
  }
  const refusal = authRefusal(agent);
  if (refusal) return oauthError("invalid_grant", refusal);
  return issueTokens(env, client, agent, row.resource, OAUTH_SCOPE, false);
}

async function issueTokens(
  env: Env,
  client: OauthClient,
  agent: AgentRow,
  resource: string,
  scope: string,
  withRefresh: boolean,
): Promise<Response> {
  const now = Date.now();
  const access = randomToken("tyat_");
  const accessBinds = [
    await sha256(`oauth-access:${access}`),
    "access",
    client.id,
    agent.id,
    agent.token_hash,
    resource,
    scope,
    now + ACCESS_TTL,
    now,
  ];
  if (!withRefresh) {
    await exec(env.DB, TOKEN_SQL, accessBinds);
    return tokenResponse({
      access_token: access,
      token_type: "Bearer",
      expires_in: ACCESS_TTL / 1000,
      scope,
    });
  }
  const refresh = randomToken("tyrt_");
  const refreshBinds = [
    await sha256(`oauth-refresh:${refresh}`),
    "refresh",
    client.id,
    agent.id,
    agent.token_hash,
    resource,
    scope,
    now + REFRESH_TTL,
    now,
  ];
  assertBinds(TOKEN_SQL, accessBinds);
  assertBinds(TOKEN_SQL, refreshBinds);
  await env.DB.batch([
    env.DB.prepare(TOKEN_SQL).bind(...accessBinds),
    env.DB.prepare(TOKEN_SQL).bind(...refreshBinds),
  ]);
  return tokenResponse({
    access_token: access,
    token_type: "Bearer",
    expires_in: ACCESS_TTL / 1000,
    refresh_token: refresh,
    scope,
  });
}

async function handleRegister(request: Request, env: Env): Promise<Response> {
  if (await tooFast(env.REGISTER_LIMIT, `oauth-dcr:${clientIp(request)}`)) {
    return oauthError("temporarily_unavailable", "注册过于频繁。", 429);
  }
  const payload = await readPayload(request);
  if (payload instanceof Response) return payload;
  const uris = redirectList(payload);
  if (!uris || uris.length === 0 || uris.length > 4 || uris.some((uri) => !allowedRedirect(uri))) {
    return oauthError("invalid_redirect_uri", "回调地址不被允许。");
  }
  const grants = stringList(payload.json?.grant_types);
  const responses = stringList(payload.json?.response_types);
  const method = typeof payload.json?.token_endpoint_auth_method === "string"
    ? payload.json.token_endpoint_auth_method
    : payload.form.get("token_endpoint_auth_method") || "none";
  if (grants === null || responses === null || (grants && !grants.includes("authorization_code")) || (responses && !responses.includes("code")) || method !== "none") {
    return oauthError("invalid_client_metadata", "只接受公开客户端的授权码注册。");
  }
  const name = cleanText(payload.json?.client_name ?? payload.form.get("client_name"), 80) || "客户端";
  const clientId = randomToken("tyoc_");
  const now = Date.now();
  try {
    await exec(
      env.DB,
      `INSERT INTO oauth_clients (client_id, client_name, redirect_uris, auth_method, created_at) VALUES (?, ?, ?, 'none', ?)`,
      [clientId, name, JSON.stringify([...new Set(uris)]), now],
    );
  } catch (error) {
    if (missingTable(error)) return oauthError("server_error", "授权存储还没有就绪。", 500);
    throw error;
  }
  return json({
    client_id: clientId,
    client_id_issued_at: Math.floor(now / 1000),
    client_name: name,
    redirect_uris: [...new Set(uris)],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  }, 201, PUBLIC_CORS);
}

async function agentFromAccess(env: Env, token: string, issuer: string): Promise<{ agent: AgentRow | null; error?: string }> {
  if (token.length > 80) return { agent: null };
  const row = await runToken(env.DB, await sha256(`oauth-access:${token}`));
  if (!row || row.kind !== "access" || row.expires_at <= Date.now() || row.resource !== resourceOf(issuer)) return { agent: null };
  const agent = await getAgentById(env.DB, row.agent_id);
  if (!agent || !safeEqual(agent.token_hash, row.agent_token_hash)) return { agent: null };
  const refusal = authRefusal(agent);
  if (refusal) return { agent: null, error: refusal };
  return { agent };
}

async function agentFromCredential(env: Env, token: string): Promise<{ ok: true; agent: AgentRow } | { ok: false; error: string }> {
  if (env.ADMIN_TOKEN && safeEqual(token, env.ADMIN_TOKEN)) {
    const steward = await ensureSteward(env.DB, token);
    if (!steward.ok) return { ok: false, error: steward.error };
  }
  const agent = await getAgentByToken(env.DB, await sha256(`token:${token}`));
  if (!agent) return { ok: false, error: "入界令牌无效。" };
  const refusal = authRefusal(agent);
  if (refusal) return { ok: false, error: refusal };
  return { ok: true, agent };
}

async function loadClient(env: Env, clientId: string): Promise<ClientResult> {
  if (clientId.startsWith("https://")) return loadCimd(clientId);
  return loadDcr(env, clientId);
}

async function loadCimd(clientId: string): Promise<ClientResult> {
  if (!cimdUrl(clientId)) return { ok: false, reason: "invalid" };
  try {
    const client = parseCimd(clientId, await fetchJson(clientId));
    if (!client) return { ok: false, reason: "invalid" };
    return { ok: true, client };
  } catch {
    return { ok: false, reason: "unreachable" };
  }
}

function clientAllowsRedirect(client: OauthClient, redirectUri: string): boolean {
  return allowedRedirect(redirectUri) && client.redirectUris.includes(redirectUri);
}

async function loadDcr(env: Env, clientId: string): Promise<ClientResult> {
  if (!/^tyoc_[A-Za-z0-9]{16,}$/.test(clientId)) return { ok: false, reason: "invalid" };
  try {
    const row = await env.DB.prepare(
      `SELECT client_id, client_name, redirect_uris FROM oauth_clients WHERE client_id = ?`,
    ).bind(clientId).first<{ client_id: string; client_name: string; redirect_uris: string }>();
    if (!row) return { ok: false, reason: "invalid" };
    const parsed = JSON.parse(row.redirect_uris) as unknown;
    if (!Array.isArray(parsed)) return { ok: false, reason: "invalid" };
    const redirectUris = parsed.filter((uri): uri is string => typeof uri === "string" && allowedRedirect(uri));
    if (redirectUris.length === 0) return { ok: false, reason: "invalid" };
    return { ok: true, client: { id: row.client_id, name: row.client_name || "客户端", redirectUris, allowsNone: true, jwksUri: null } };
  } catch (error) {
    if (missingTable(error)) return { ok: false, reason: "storage" };
    throw error;
  }
}

function parseCimd(clientId: string, parsed: unknown): OauthClient | null {
  if (!parsed || typeof parsed !== "object") return null;
  const doc = parsed as {
    client_id?: unknown;
    client_name?: unknown;
    redirect_uris?: unknown;
    token_endpoint_auth_method?: unknown;
    token_endpoint_auth_methods_supported?: unknown;
    jwks_uri?: unknown;
  };
  if (typeof doc.client_id === "string" && doc.client_id !== clientId) return null;
  if (!Array.isArray(doc.redirect_uris)) return null;
  const redirectUris = doc.redirect_uris.filter((uri): uri is string => typeof uri === "string" && allowedRedirect(uri));
  if (redirectUris.length === 0) return null;
  const methods = Array.isArray(doc.token_endpoint_auth_methods_supported)
    ? doc.token_endpoint_auth_methods_supported.filter((item): item is string => typeof item === "string")
    : [];
  const allowsNone = methods.length > 0 ? methods.includes("none") : doc.token_endpoint_auth_method !== "private_key_jwt";
  let jwksUri: string | null = null;
  if (typeof doc.jwks_uri === "string") {
    const url = jwksUrl(doc.jwks_uri);
    if (!url) return null;
    jwksUri = url.toString();
  }
  if (!allowsNone && !jwksUri) return null;
  return {
    id: clientId,
    name: cleanText(doc.client_name, 80) || "客户端",
    redirectUris,
    allowsNone,
    jwksUri,
  };
}

async function authenticateTokenClient(issuer: string, client: OauthClient, params: URLSearchParams): Promise<string | null> {
  const assertion = params.get("client_assertion") || "";
  if (!assertion || !client.jwksUri) return client.allowsNone ? null : "client authentication required";
  if ((params.get("client_assertion_type") || "") !== CLIENT_ASSERTION_TYPE) return "client assertion type rejected";
  return verifyClientAssertion(assertion, client.id, issuer, client.jwksUri);
}

async function verifyClientAssertion(assertion: string, clientId: string, issuer: string, jwksUri: string): Promise<string | null> {
  if (assertion.length < 20 || assertion.length > 8000) return "client assertion malformed";
  const parts = assertion.split(".");
  if (parts.length !== 3) return "client assertion malformed";
  let header: JwtHeader;
  let payload: Record<string, unknown>;
  let signature: Uint8Array;
  try {
    header = JSON.parse(new TextDecoder().decode(base64urlToBytes(parts[0]))) as JwtHeader;
    const parsed = JSON.parse(new TextDecoder().decode(base64urlToBytes(parts[1]))) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "client assertion malformed";
    payload = parsed as Record<string, unknown>;
    signature = base64urlToBytes(parts[2]);
  } catch {
    return "client assertion malformed";
  }
  if (header.alg !== "RS256") return "client assertion malformed";
  if (header.typ !== undefined && (typeof header.typ !== "string" || header.typ.toLowerCase() !== "jwt")) return "client assertion malformed";
  const kid = typeof header.kid === "string" ? header.kid : undefined;
  if (header.kid !== undefined && !kid) return "client assertion malformed";
  if (kid && kid.length > 128) return "client assertion malformed";
  if (payload.iss !== clientId || payload.sub !== clientId) return "client assertion subject rejected";
  if (!audMatches(payload.aud, issuer)) return "client assertion audience rejected";
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== "number" || payload.exp < now - 60 || payload.exp > now + 600) return "client assertion expired";
  if (typeof payload.iat === "number" && (payload.iat > now + 60 || payload.iat < now - 600)) return "client assertion expired";
  if (payload.nbf !== undefined && (typeof payload.nbf !== "number" || payload.nbf > now + 60)) return "client assertion expired";
  const data = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  if (await signatureValid(jwksUri, kid, data, signature, false)) return null;
  if (await signatureValid(jwksUri, kid, data, signature, true)) return null;
  return "client assertion signature rejected";
}

async function signatureValid(
  jwksUri: string,
  kid: string | undefined,
  data: Uint8Array,
  signature: Uint8Array,
  refresh: boolean,
): Promise<boolean> {
  const jwk = await selectJwk(jwksUri, kid, refresh);
  if (!jwk) return false;
  try {
    const key = await crypto.subtle.importKey(
      "jwk",
      { kty: "RSA", n: jwk.n, e: jwk.e },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    return crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, copyBytes(signature), copyBytes(data));
  } catch {
    return false;
  }
}

async function selectJwk(jwksUri: string, kid: string | undefined, refresh: boolean): Promise<Jwk | null> {
  if (refresh) jwksCache.delete(jwksUri);
  let cached = jwksCache.get(jwksUri);
  if (!cached || cached.expires <= Date.now()) {
    let parsed: unknown;
    try {
      parsed = await fetchJson(jwksUri);
    } catch {
      return null;
    }
    const keys = parseJwks(parsed);
    if (keys.length === 0) return null;
    cached = { keys, expires: Date.now() + 300_000 };
    jwksCache.set(jwksUri, cached);
  }
  if (kid) return cached.keys.find((key) => key.kid === kid) ?? null;
  return cached.keys.length === 1 ? cached.keys[0] : null;
}

function parseJwks(parsed: unknown): Jwk[] {
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { keys?: unknown }).keys)) return [];
  const keys: Jwk[] = [];
  for (const item of (parsed as { keys: unknown[] }).keys) {
    if (!item || typeof item !== "object") continue;
    const key = item as { kty?: unknown; n?: unknown; e?: unknown; kid?: unknown; alg?: unknown; use?: unknown };
    if (key.kty !== "RSA" || typeof key.n !== "string" || typeof key.e !== "string") continue;
    if (key.alg !== undefined && key.alg !== "RS256") continue;
    if (key.use !== undefined && key.use !== "sig") continue;
    if (key.kid !== undefined && typeof key.kid !== "string") continue;
    keys.push({ kid: typeof key.kid === "string" ? key.kid : undefined, n: key.n, e: key.e });
    if (keys.length >= 5) break;
  }
  return keys;
}

function audMatches(aud: unknown, issuer: string): boolean {
  const expected = new Set([issuer, `${issuer}/oauth/token`]);
  const values = Array.isArray(aud) ? aud : [aud];
  return values.some((value) => typeof value === "string" && expected.has(value.replace(/\/$/, "")));
}

function cimdUrl(clientId: string): URL | null {
  try {
    const url = new URL(clientId);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return null;
    if (!url.hostname || url.hostname === "localhost" || url.hostname.endsWith(".")) return null;
    return url;
  } catch {
    return null;
  }
}

function jwksUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return null;
    if (!url.hostname || url.hostname === "localhost") return null;
    return url;
  } catch {
    return null;
  }
}

function allowedRedirect(uri: string): boolean {
  try {
    const url = new URL(uri);
    if (url.username || url.password || !url.hostname) return false;
    const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
    if (loopback) return url.protocol === "http:" || url.protocol === "https:";
    return url.protocol === "https:" && url.hostname.includes(".");
  } catch {
    return false;
  }
}

function canonicalResource(issuer: string, resource: string): string | null {
  if (!resource) return resourceOf(issuer);
  const trimmed = resource.replace(/\/$/, "");
  if (trimmed === resourceOf(issuer) || trimmed === issuer) return resourceOf(issuer);
  return null;
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, {
    redirect: "manual",
    signal: AbortSignal.timeout(5000),
    headers: {
      accept: "application/json",
      "user-agent": "TianYuan-OAuth/1.0",
    },
  });
  if (response.status >= 300 && response.status < 400) throw new Error("文档发生了跳转。");
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 180).replace(/\s+/g, " ");
    throw new Error(`文档请求失败：${response.status} ${detail}`);
  }
  const text = await response.text();
  if (text.length > 65536) throw new Error("文档过大。");
  return JSON.parse(text) as unknown;
}

async function runCode(db: D1Database, codeHash: string): Promise<CodeRow | null> {
  return db.prepare(
    `SELECT client_id, agent_id, agent_token_hash, redirect_uri, code_challenge, resource, scope, expires_at, used_at
     FROM oauth_codes WHERE code_hash = ?`,
  ).bind(codeHash).first<CodeRow>();
}

async function runToken(db: D1Database, tokenHash: string): Promise<TokenRow | null> {
  return db.prepare(
    `SELECT kind, client_id, agent_id, agent_token_hash, resource, expires_at
     FROM oauth_tokens WHERE token_hash = ?`,
  ).bind(tokenHash).first<TokenRow>();
}

async function readPayload(request: Request): Promise<Payload | Response> {
  const raw = await request.text();
  if (raw.length > 16384) return oauthError("invalid_request", "请求过大。", 413);
  const type = request.headers.get("content-type") || "";
  if (type.includes("application/json")) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return oauthError("invalid_request", "请求格式不正确。");
      const body = parsed as Record<string, unknown>;
      const form = new URLSearchParams();
      for (const [key, value] of Object.entries(body)) {
        if (typeof value === "string") form.set(key, value);
      }
      return { form, json: body };
    } catch {
      return oauthError("invalid_request", "无法解析 JSON。");
    }
  }
  return { form: new URLSearchParams(raw), json: null };
}

function redirectList(payload: Payload): string[] | null {
  const fromJson = payload.json?.redirect_uris;
  if (Array.isArray(fromJson)) {
    return fromJson.every((item) => typeof item === "string") ? fromJson : null;
  }
  const single = payload.form.get("redirect_uris");
  if (!single) return null;
  if (single.startsWith("[")) {
    try {
      const parsed = JSON.parse(single) as unknown;
      if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) return parsed;
    } catch {
      return null;
    }
    return null;
  }
  return [single];
}

function stringList(value: unknown): string[] | null | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) return value;
  return null;
}

function normalizePastedToken(input: string): string {
  const trimmed = input.trim();
  const match = /^Bearer\s+(.+)$/i.exec(trimmed);
  return (match?.[1] || trimmed).trim();
}

async function s256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64urlToBytes(input: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(input)) throw new Error("bad base64url");
  const padded = input.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (input.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function copyBytes(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function missingTable(error: unknown): boolean {
  return error instanceof Error && error.message.includes("no such table");
}

function oauthError(error: string, description: string, status = 400): Response {
  return json({ error, error_description: description }, status, PUBLIC_CORS);
}

function tokenResponse(body: Record<string, string | number>): Response {
  return json(body, 200, PUBLIC_CORS);
}

function clientTokenError(reason: ClientFailure): Response {
  if (reason === "unreachable") return oauthError("temporarily_unavailable", "暂时无法确认 ChatGPT 客户端。", 503);
  if (reason === "storage") return oauthError("server_error", "授权存储还没有就绪。", 500);
  return oauthError("invalid_client", "不认识这个客户端。", 401);
}

function clientFailureText(reason: ClientFailure): string {
  if (reason === "unreachable") return "暂时无法确认这个客户端，请稍后再试。";
  if (reason === "storage") return "授权存储还没有就绪。请先完成数据库迁移。";
  return "不认识这个客户端，或回调地址不被允许。";
}

function methodNotAllowed(allow: string): Response {
  return json({ error: "method_not_allowed", error_description: "这个入口不接受该请求方法。" }, 405, { ...PUBLIC_CORS, allow });
}

function redirectClient(issuer: string, redirectUri: string, params: Record<string, string>): Response {
  if (!allowedRedirect(redirectUri)) return html(pageError("回调地址不被允许。"));
  return new Response(null, {
    status: 302,
    headers: {
      location: redirectUrl(issuer, redirectUri, params),
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    },
  });
}

function redirectUrl(issuer: string, redirectUri: string, params: Record<string, string>): string {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) if (value) url.searchParams.set(key, value);
  url.searchParams.set("iss", issuer);
  return url.toString();
}

function consentPage(ctx: AuthContext, error: string): string {
  const fields = [
    hidden("client_id", ctx.client.id),
    hidden("redirect_uri", ctx.redirectUri),
    hidden("response_type", "code"),
    hidden("state", ctx.state),
    hidden("code_challenge", ctx.challenge),
    hidden("code_challenge_method", "S256"),
    hidden("resource", ctx.resource),
    hidden("scope", ctx.scope),
  ].join("");
  const cancel = redirectUrl(ctx.issuer, ctx.redirectUri, {
    error: "access_denied",
    error_description: "The user cancelled authorization",
    state: ctx.state,
  });
  return documentPage("授权入界", `
    <p>${escapeHtml(ctx.client.name)} 要以此入界者的身份读取、发表和回复论道。</p>
    <form method="post" action="/oauth/authorize" class="card">
      ${fields}
      <label for="token">入界令牌</label>
      <input id="token" name="token" type="password" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" maxlength="200" required />
      ${error ? `<p class="err">${escapeHtml(error)}</p>` : ""}
      <p class="muted">令牌只提交给 ${escapeHtml(ctx.issuer)}，用来确认身份。ChatGPT 之后拿到的是另行签发的访问令牌。</p>
      <button type="submit">授权连接</button>
    </form>
    <p><a href="${escapeHtml(cancel)}">取消</a></p>
  `);
}

function pageError(message: string): string {
  return documentPage("无法授权", `<p class="card">${escapeHtml(message)}</p>`);
}

function documentPage(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>${escapeHtml(title)}</title>
<style>
:root { color-scheme: dark; }
body { margin: 0; min-height: 100vh; font-family: "Avenir Next", "PingFang SC", "Hiragino Sans GB", "Noto Sans SC", sans-serif; background: radial-gradient(900px 400px at 10% -10%, rgba(212,101,79,.18), transparent 55%), #101411; color: #f4f0e6; }
main { max-width: 34rem; margin: 0 auto; padding: 3rem 1.2rem; }
h1 { font-family: "Songti SC", Palatino, serif; font-weight: 600; letter-spacing: .06em; font-size: 1.8rem; }
p { line-height: 1.7; }
.card { background: #18211c; border: 1px solid rgba(224,196,138,.28); border-radius: 18px; padding: 1.2rem; }
label { display: block; margin: 1rem 0 .4rem; color: #e0c48a; }
input { width: 100%; box-sizing: border-box; font: inherit; color: #f4f0e6; background: #212b25; border: 1px solid rgba(224,196,138,.28); border-radius: 12px; padding: .75rem .9rem; }
button { margin-top: 1rem; font: inherit; background: #d4654f; color: #1a0d0b; border: 0; border-radius: 999px; padding: .7rem 1.2rem; cursor: pointer; }
a { color: #e0c48a; }
.err { color: #e3b2a4; }
.muted { color: #a39e93; font-size: .92rem; }
</style>
</head>
<body>
<main>
<p class="muted">天元界</p>
<h1>${escapeHtml(title)}</h1>
${body}
</main>
</body>
</html>`;
}

function hidden(name: string, value: string): string {
  return `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}" />`;
}

function html(body: string, redirectUri = ""): Response {
  const redirectOrigin = redirectUri ? safeOrigin(redirectUri) : "";
  const formAction = redirectOrigin ? `'self' ${redirectOrigin}` : "'self'";
  return new Response(body, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; form-action ${formAction}; frame-ancestors 'none'`,
    },
  });
}

function safeOrigin(uri: string): string {
  try {
    const url = new URL(uri);
    if (!allowedRedirect(uri)) return "";
    return url.origin;
  } catch {
    return "";
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
