/**
 * `bugsecure-mcp serve --http`: wire configuration into the hosted app and
 * start listening. Fails fast if the authorization server is unreachable or
 * its metadata is invalid, rather than serving 500s.
 */
import { createAccessTokenVerifier, remoteJwks } from '../auth/hosted/jwt.js';
import { TokenExchanger } from '../auth/hosted/token-exchange.js';
import { discoverAuthorizationServer } from '../auth/oauth.js';
import type { HostedConfig } from '../config.js';
import type { Logger } from '../logger.js';
import { createHttpApp } from './http-app.js';
import { startHttpServer, type StartedServer } from './http-server.js';

export const runHosted = async (config: HostedConfig, logger: Logger): Promise<StartedServer> => {
  const metadata = await discoverAuthorizationServer(config.issuer);
  if (
    metadata.grant_types_supported &&
    !metadata.grant_types_supported.includes('urn:ietf:params:oauth:grant-type:token-exchange')
  ) {
    logger.warn('authorization server does not advertise the token-exchange grant; API calls will fail');
  }

  const app = createHttpApp({
    config,
    logger,
    verifyAccessToken: createAccessTokenVerifier({
      issuer: config.issuer,
      audience: config.resource,
      keys: remoteJwks(config.jwksUrl ?? metadata.jwks_uri ?? `${config.issuer}/.well-known/jwks.json`),
    }),
    exchanger: new TokenExchanger({
      tokenEndpoint: metadata.token_endpoint,
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      apiResource: config.apiUrl,
      cacheSize: config.tokenCacheSize,
      logger,
    }),
  });

  const started = await startHttpServer(
    app,
    { host: config.host, port: config.port },
    { maxBodyBytes: config.maxBodyBytes, handlerTimeoutMs: config.requestTimeoutMs * 3, logger },
  );
  logger.info('bugsecure-mcp listening', {
    listen: started.url,
    resource: config.resource,
    issuer: config.issuer,
    readOnly: config.readOnly,
  });
  return started;
};
