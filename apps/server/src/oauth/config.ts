export interface OAuthConfig {
  publicUrl: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

export const ALLOWED_REDIRECTS: readonly string[] = [
  'https://claude.ai/api/mcp/auth_callback',
  'https://claude.com/api/mcp/auth_callback',
];

export const SCOPES = ['hub.read', 'hub.save', 'offline_access'] as const;
export type HubScope = (typeof SCOPES)[number];

export const TTL = {
  code: 60_000,
  access: 3_600_000,
  refreshIdle: 90 * 86_400_000,
  grace: 60_000,
  connectCode: 600_000,
};

const base = (cfg: OAuthConfig): string => cfg.publicUrl.replace(/\/+$/, '');

export function resourceUrl(cfg: OAuthConfig): string {
  return `${base(cfg)}/mcp`;
}

export function protectedResourceMetadata(cfg: OAuthConfig): object {
  return {
    resource: resourceUrl(cfg),
    authorization_servers: [base(cfg)],
    scopes_supported: SCOPES,
  };
}

export function authorizationServerMetadata(cfg: OAuthConfig): object {
  const issuer = base(cfg);
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    scopes_supported: SCOPES,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    client_id_metadata_document_supported: true,
  };
}
