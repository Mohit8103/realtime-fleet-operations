import { connectMongo, Rule, Operator } from '@fleet/database';

export async function seed() {
  console.log('🌱 Seeding database with default rules and operators...');
  await connectMongo();

  // Clean up any leftover legacy rules from manual testing
  await Rule.deleteMany({
    name: { $in: ['Manual High Heat', 'Manual Stale', 'Overspeed Alert'] }
  });

  // Exactly two default rules: 1 threshold and 1 no_report
  const defaultRules = [
    {
      name: 'High Heat Alert',
      type: 'threshold',
      severity: 'high',
      enabled: true,
      cooldownSeconds: 0,
      conditions: {
        metric: 'temperature',
        operator: '>',
        value: 70,
        deviceFilter: { type: 'all' }
      }
    },
    {
      name: 'Stale Device Alert',
      type: 'no_report',
      severity: 'medium',
      enabled: true,
      cooldownSeconds: 0,
      conditions: {
        seconds: 30,
        deviceFilter: { type: 'all' }
      }
    }
  ];

  for (const r of defaultRules) {
    const updated = await Rule.findOneAndUpdate(
      { name: r.name },
      { $set: r },
      { upsert: true, new: true }
    );
    console.log(`✅ Upserted default rule: ${updated.name} (${updated._id})`);
  }

  // Default Operator
  const defaultOperator = {
    operatorId: 'op-default-primary',
    name: 'Primary Fleet Operator',
    email: 'ops@fleet.local',
    locations: ['lab', 'warehouse', 'apac', 'emea', 'us-east', 'default']
  };

  const op = await Operator.findOneAndUpdate(
    { operatorId: defaultOperator.operatorId },
    { $set: defaultOperator },
    { upsert: true, new: true }
  );
  console.log(`✅ Upserted default operator: ${op.name} (${op.operatorId})`);

  console.log('🎉 Seeding completed successfully!');
}

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}`) {
  seed()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('❌ Seeding failed:', err);
      process.exit(1);
    });
}
