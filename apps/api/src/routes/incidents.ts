import { Router, type Request, type Response } from 'express';
import { Incident, Event, RuleEvaluation } from '@fleet/database';

export const incidentsRouter = Router();

// GET /v1/incidents - List incidents with optional filters (state, severity, deviceId)
incidentsRouter.get('/', async (req: Request, res: Response) => {
  try {
    const filter: Record<string, unknown> = {};

    if (req.query.state) {
      filter.state = req.query.state;
    }
    if (req.query.severity) {
      filter.severity = req.query.severity;
    }
    if (req.query.deviceId) {
      filter.deviceId = req.query.deviceId;
    }

    const limit = Math.min(Number(req.query.limit) || 50, 200);

    const incidents = await Incident.find(filter)
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    return res.status(200).json({
      count: incidents.length,
      incidents
    });
  } catch (err: any) {
    req.log?.error({ err: err.message }, 'Failed to list incidents');
    return res.status(500).json({ error: 'Failed to query incidents', message: err.message });
  }
});

// GET /v1/incidents/:id - Get single incident with associated events and rule evaluations
incidentsRouter.get('/:id', async (req: Request, res: Response) => {
  const id = String(req.params.id);

  try {
    // Find incident by incidentId or Mongo _id
    const incident = await Incident.findOne({
      $or: [{ incidentId: id }, ...(id.match(/^[0-9a-fA-F]{24}$/) ? [{ _id: id }] : [])]
    }).lean();

    if (!incident) {
      return res.status(404).json({ error: 'Incident not found' });
    }

    // Query associated triggering events
    const eventIds = incident.triggeringEvents || [];
    if (incident.eventId && !eventIds.includes(incident.eventId)) {
      eventIds.push(incident.eventId);
    }

    const events = eventIds.length
      ? await Event.find({ eventId: { $in: eventIds } }).sort({ timestamp: 1 }).lean()
      : [];

    // Query associated rule evaluations
    const ruleEvaluations = await RuleEvaluation.find({
      $or: [
        { ruleId: incident.ruleId, deviceId: incident.deviceId },
        ...(eventIds.length ? [{ eventId: { $in: eventIds } }] : [])
      ]
    })
      .sort({ evaluatedAt: -1 })
      .limit(50)
      .lean();

    return res.status(200).json({
      incident,
      events,
      ruleEvaluations
    });
  } catch (err: any) {
    req.log?.error({ id, err: err.message }, 'Failed to fetch incident details');
    return res.status(500).json({ error: 'Failed to fetch incident', message: err.message });
  }
});

// POST /v1/incidents/:id/acknowledge - Transition open -> acknowledged
incidentsRouter.post('/:id/acknowledge', async (req: Request, res: Response) => {
  const id = String(req.params.id);
  const { operator, note } = req.body || {};

  try {
    const incident = await Incident.findOne({
      $or: [{ incidentId: id }, ...(id.match(/^[0-9a-fA-F]{24}$/) ? [{ _id: id }] : [])]
    });

    if (!incident) {
      return res.status(404).json({ error: 'Incident not found' });
    }

    // Only valid transition: open -> acknowledged. Anything else returns 409.
    if (incident.state !== 'open') {
      return res.status(409).json({
        error: `Invalid state transition: Cannot acknowledge incident in '${incident.state}' state`,
        currentState: incident.state
      });
    }

    const now = new Date();
    incident.state = 'acknowledged';
    incident.acknowledgedAt = now;
    incident.acknowledgedBy = operator || 'operator';
    incident.timeline.push({
      action: 'acknowledged',
      timestamp: now,
      operator: operator || 'operator',
      note: note || 'Incident acknowledged by operator'
    });

    await incident.save();

    return res.status(200).json({
      status: 'acknowledged',
      incident
    });
  } catch (err: any) {
    req.log?.error({ id, err: err.message }, 'Failed to acknowledge incident');
    return res.status(500).json({ error: 'Failed to acknowledge incident', message: err.message });
  }
});

// POST /v1/incidents/:id/resolve - Transition open/acknowledged -> resolved
incidentsRouter.post('/:id/resolve', async (req: Request, res: Response) => {
  const id = String(req.params.id);
  const { operator, note } = req.body || {};

  try {
    const incident = await Incident.findOne({
      $or: [{ incidentId: id }, ...(id.match(/^[0-9a-fA-F]{24}$/) ? [{ _id: id }] : [])]
    });

    if (!incident) {
      return res.status(404).json({ error: 'Incident not found' });
    }

    // Only valid transitions: open -> resolved or acknowledged -> resolved. Anything else returns 409.
    if (incident.state !== 'open' && incident.state !== 'acknowledged') {
      return res.status(409).json({
        error: `Invalid state transition: Cannot resolve incident in '${incident.state}' state`,
        currentState: incident.state
      });
    }

    const now = new Date();
    incident.state = 'resolved';
    incident.resolvedAt = now;
    incident.resolvedBy = operator || 'operator';
    incident.timeline.push({
      action: 'resolved',
      timestamp: now,
      operator: operator || 'operator',
      note: note || 'Incident resolved by operator'
    });

    await incident.save();

    return res.status(200).json({
      status: 'resolved',
      incident
    });
  } catch (err: any) {
    req.log?.error({ id, err: err.message }, 'Failed to resolve incident');
    return res.status(500).json({ error: 'Failed to resolve incident', message: err.message });
  }
});
