import { Router, type Request, type Response } from 'express';
import { Rule } from '@fleet/database';
import { createRuleSchema, updateRuleSchema } from '../schemas/ruleSchema.js';

export const rulesRouter = Router();

// GET /v1/rules - List all rules with optional filters
rulesRouter.get('/', async (req: Request, res: Response) => {
  try {
    const filter: Record<string, unknown> = {};
    if (req.query.type) {
      filter.type = req.query.type;
    }
    if (req.query.enabled !== undefined) {
      filter.enabled = req.query.enabled === 'true';
    }

    const rules = await Rule.find(filter).sort({ createdAt: -1 }).lean();
    return res.status(200).json({
      count: rules.length,
      rules
    });
  } catch (err: any) {
    req.log?.error({ err: err.message }, 'Failed to query rules');
    return res.status(500).json({ error: 'Failed to query rules', message: err.message });
  }
});

// POST /v1/rules - Create a new rule
rulesRouter.post('/', async (req: Request, res: Response) => {
  const parseResult = createRuleSchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({
      error: 'Invalid rule configuration',
      details: parseResult.error.errors
    });
  }

  const { name } = parseResult.data;

  try {
    const existing = await Rule.findOne({ name });
    if (existing) {
      return res.status(409).json({
        error: 'Conflict',
        message: `Rule with name "${name}" already exists`,
        rule: existing
      });
    }

    const rule = await Rule.create(parseResult.data);
    return res.status(201).json({
      status: 'created',
      rule
    });
  } catch (err: any) {
    if (err.code === 11000 || String(err.message).includes('E11000')) {
      const existing = await Rule.findOne({ name });
      return res.status(409).json({
        error: 'Conflict',
        message: `Rule with name "${name}" already exists`,
        rule: existing || undefined
      });
    }
    req.log?.error({ err: err.message }, 'Failed to create rule');
    return res.status(500).json({ error: 'Failed to create rule', message: err.message });
  }
});

// GET /v1/rules/:id - Get rule by ID
rulesRouter.get('/:id', async (req: Request, res: Response) => {
  try {
    const rule = await Rule.findById(req.params.id).lean();
    if (!rule) {
      return res.status(404).json({ error: 'Rule not found' });
    }
    return res.status(200).json(rule);
  } catch (err: any) {
    return res.status(400).json({ error: 'Invalid rule ID', message: err.message });
  }
});

// PATCH /v1/rules/:id or PUT /v1/rules/:id - Update rule
rulesRouter.patch('/:id', async (req: Request, res: Response) => {
  const parseResult = updateRuleSchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({
      error: 'Invalid rule updates',
      details: parseResult.error.errors
    });
  }

  try {
    const rule = await Rule.findByIdAndUpdate(req.params.id, { $set: parseResult.data }, { new: true }).lean();
    if (!rule) {
      return res.status(404).json({ error: 'Rule not found' });
    }
    return res.status(200).json({
      status: 'updated',
      rule
    });
  } catch (err: any) {
    return res.status(400).json({ error: 'Failed to update rule', message: err.message });
  }
});

// DELETE /v1/rules/:id - Delete rule
rulesRouter.delete('/:id', async (req: Request, res: Response) => {
  try {
    const rule = await Rule.findByIdAndDelete(req.params.id).lean();
    if (!rule) {
      return res.status(404).json({ error: 'Rule not found' });
    }
    return res.status(200).json({
      status: 'deleted',
      ruleId: req.params.id
    });
  } catch (err: any) {
    return res.status(400).json({ error: 'Failed to delete rule', message: err.message });
  }
});
