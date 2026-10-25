import { Router, type Request, type Response } from 'express';
import crypto from 'node:crypto';
import { Operator } from '@fleet/database';
import { z } from 'zod';

export const operatorsRouter = Router();

const createOperatorSchema = z.object({
  id: z.string().optional(),
  operatorId: z.string().optional(),
  name: z.string().min(1, 'Name is required'),
  email: z.string().email('Invalid email address'),
  locations: z.array(z.string()).default([])
});

// GET /v1/operators - List all operators
operatorsRouter.get('/', async (req: Request, res: Response) => {
  try {
    const operators = await Operator.find({}).sort({ createdAt: -1 }).lean();
    return res.status(200).json({
      count: operators.length,
      operators
    });
  } catch (err: any) {
    req.log?.error({ err: err.message }, 'Failed to query operators');
    return res.status(500).json({ error: 'Failed to query operators', message: err.message });
  }
});

// POST /v1/operators - Register or update an operator
operatorsRouter.post('/', async (req: Request, res: Response) => {
  const parseResult = createOperatorSchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({
      error: 'Invalid operator data',
      details: parseResult.error.errors
    });
  }

  const { id, operatorId: rawOpId, name, email, locations } = parseResult.data;
  const operatorId = rawOpId || id || `op-${crypto.randomUUID().slice(0, 8)}`;

  try {
    let operator = await Operator.findOne({ operatorId });

    if (operator) {
      operator.name = name;
      operator.email = email;
      operator.locations = locations;
      await operator.save();
      return res.status(200).json({
        status: 'updated',
        operator
      });
    }

    operator = await Operator.create({
      operatorId,
      name,
      email,
      locations
    });

    return res.status(201).json({
      status: 'created',
      operator
    });
  } catch (err: any) {
    req.log?.error({ err: err.message }, 'Failed to create operator');
    return res.status(500).json({ error: 'Failed to create operator', message: err.message });
  }
});
