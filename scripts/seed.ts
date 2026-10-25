import { connectMongo, Rule, Operator } from '@fleet/database';

async function seed() {
  console.log('🌱 Seeding database with default rules and operators...');
  await connectMongo();

  // 1. Default Rules
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
      name: 'Manual Stale',
      type: 'no_report',
      severity: 'medium',
      enabled: true,
      cooldownSeconds: 0,
      conditions: {
        seconds: 30,
        deviceFilter: { type: 'all' }
      }
    },
    {
      name: 'Overspeed Alert',
      type: 'threshold',
      severity: 'critical',
      enabled: true,
      cooldownSeconds: 0,
      conditions: {
        metric: 'speed',
        operator: '>',
        value: 80,
        deviceFilter: { type: 'all' }
      }
    }
  ];

  for (const r of defaultRules) {
    const exists = await Rule.findOne({ name: r.name });
    if (!exists) {
      await Rule.create(r);
      console.log(`✅ Created default rule: ${r.name}`);
    } else {
      console.log(`ℹ️ Rule already exists: ${r.name}`);
    }
  }

  // 2. Default Operator
  const defaultOperator = {
    operatorId: 'op-default-primary',
    name: 'Primary Fleet Operator',
    email: 'ops@fleet.local',
    locations: ['lab', 'warehouse', 'apac', 'emea', 'us-east', 'default']
  };

  const opExists = await Operator.findOne({
    $or: [{ operatorId: defaultOperator.operatorId }, { email: defaultOperator.email }]
  });
  if (!opExists) {
    await Operator.create(defaultOperator);
    console.log(`✅ Created default operator: ${defaultOperator.name}`);
  } else {
    console.log(`ℹ️ Default operator already exists: ${defaultOperator.name}`);
  }

  console.log('🎉 Seeding completed successfully!');
  process.exit(0);
}

seed().catch((err) => {
  console.error('❌ Seeding failed:', err);
  process.exit(1);
});
