import { Router, type Request, type Response } from 'express';
import { config } from '@fleet/config';

export const healthRouter = Router();

healthRouter.get('/healthz', (req: Request, res: Response) => {
  res.status(200).json({
    status: 'ok',
    service: 'api',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    environment: config.env,
    correlationId: req.correlationId
  });
});
