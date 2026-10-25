import { Router, type Request, type Response } from 'express';
import { sseManager } from '../realtime/sseManager.js';
import { dashboardAuth } from '../middleware/dashboardAuth.js';

export const streamRouter = Router();

// GET /v1/stream - Server-Sent Events realtime stream
streamRouter.get('/', dashboardAuth, async (req: Request, res: Response) => {
  await sseManager.handleConnection(req, res);
});
