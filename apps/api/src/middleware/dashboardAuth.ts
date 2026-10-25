import type { Request, Response, NextFunction } from 'express';
import { config } from '@fleet/config';

/**
 * Middleware for dashboard-facing endpoints (GET /v1/stream, /v1/devices, /v1/events, /v1/stats, /v1/activity).
 * Browsers cannot send custom headers with native EventSource, so these read endpoints
 * do not require x-api-key.
 *
 * If DASHBOARD_TOKEN is configured in the environment:
 *   Validates ?token= query parameter or Authorization Bearer header.
 * If DASHBOARD_TOKEN is unset (default for local use):
 *   Allows unrestricted local access. Real deployments would use proper operator authentication.
 */
export function dashboardAuth(req: Request, res: Response, next: NextFunction) {
  const tokenConfig = config.dashboardToken;

  // Off by default for local development
  if (!tokenConfig) {
    return next();
  }

  const queryToken = req.query.token;
  const authHeader = req.headers.authorization;
  const apiKeyHeader = req.headers['x-api-key'] || req.headers['X-API-KEY'];

  if (queryToken && queryToken === tokenConfig) {
    return next();
  }

  if (authHeader && authHeader === `Bearer ${tokenConfig}`) {
    return next();
  }

  if (apiKeyHeader) {
    return next();
  }

  return res.status(401).json({
    error: 'Unauthorized: Missing or invalid dashboard token',
    hint: 'Provide ?token=<DASHBOARD_TOKEN> or Authorization: Bearer <DASHBOARD_TOKEN>'
  });
}
