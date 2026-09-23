import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { GameCommand, Season, WorldSnapshot } from '@shanhai/contracts';
import { createApp } from '../src/app.ts';

describe('closed-loop API', () => {
  let app: ReturnType<typeof createApp>['app'];
  let store: ReturnType<typeof createApp>['store'];
  let agent: ReturnType<typeof request.agent>;

  beforeAll(() => {
    const created = createApp({ databasePath: ':memory:', loggerEnabled: false });
    app = created.app;
    store = created.store;
    agent = request.agent(app);
  });

  afterAll(() => store.close());

  it('accepts configured browser origins and rejects unknown origins', async () => {
    await request(app)
      .post('/api/save')
      .set('Origin', 'http://127.0.0.1:5173')
      .expect(201);
    await request(app)
      .post('/api/save')
      .set('Origin', 'https://attacker.example')
      .expect(403);
  });

  it('returns a client error for malformed JSON', async () => {
    await request(app)
      .post('/api/save/import')
      .set('Content-Type', 'application/json')
      .send('{"token":')
      .expect(400)
      .expect((response) => {
        expect(response.body.code).toBe('INVALID_JSON');
      });
  });

  it('creates, observes, samples, evolves and continues into the next year', async () => {
    const createResponse = await agent.post('/api/save').expect(201);
    let world = createResponse.body as WorldSnapshot;
    expect(world.year).toBe(1);
    expect(world.season).toBe('spring');
    expect(world.sites.length).toBe(4);
    const baseline = store.db
      .prepare('SELECT year_start_species_json FROM saves WHERE id = ?')
      .get(world.saveId) as unknown as { year_start_species_json: string };
    expect(JSON.parse(baseline.year_start_species_json).length).toBeGreaterThan(0);

    world = await command(agent, world, {
      type: 'OBSERVE_PLANT',
      speciesId: 'prunus-davidiana',
      values: {
        phenology: 'leafing',
        leafTexture: 'smooth',
        dominantColor: '#557a45',
        temperatureC: 16,
        humidity: 60,
        soilMoisture: 50,
        lightLux: 30000,
        note: '自动化闭环观察'
      }
    });
    expect(world.recentEvents[0]?.type).toBe('OBSERVE_PLANT');

    const beforeSample = world.sites
      .flatMap((site) => site.species)
      .find((species) => species.id === 'prunus-davidiana')!;
    world = await command(agent, world, {
      type: 'TAKE_SAMPLE',
      speciesId: 'prunus-davidiana',
      method: 'litter'
    });
    const afterSample = world.sites
      .flatMap((site) => site.species)
      .find((species) => species.id === 'prunus-davidiana')!;
    expect(afterSample.health).toBeLessThan(beforeSample.health);
    expect(world.recentEvents[0]?.message).toContain('不符合采集协议');

    const requestBody = {
      expectedRevision: world.revision,
      idempotencyKey: 'idempotency-test-key-001',
      command: { type: 'WAIT' as const }
    };
    const first = await agent.post(`/api/save/${world.saveId}/commands`).send(requestBody).expect(200);
    const second = await agent.post(`/api/save/${world.saveId}/commands`).send(requestBody).expect(200);
    expect(second.body.world.revision).toBe(first.body.world.revision);
    expect(second.body.event.id).toBe(first.body.event.id);
    world = first.body.world as WorldSnapshot;

    for (const season of ['spring', 'summer', 'autumn', 'winter'] as Season[]) {
      expect(world.season).toBe(season);
      world = await advanceToDayEight(agent, world);
      world = await command(agent, world, { type: 'END_SEASON' });
      if (season !== 'winter') {
        expect(world.phase).toBe('season_review');
        world = await command(agent, world, { type: 'BEGIN_NEXT_SEASON' });
      }
    }

    expect(world.phase).toBe('year_review');
    expect(world.annualReview?.year).toBe(1);
    expect(world.annualReview?.incorrectSamples).toBeGreaterThan(0);
    expect(world.annualReview?.speciesChanges.length).toBeGreaterThan(0);
    expect(world.annualReview?.speciesChanges.some((item) => item.populationChangePercent === 100)).toBe(false);
    expect(world.annualReview?.populationChangePercent).not.toBe(100);
    expect(world.annualReview?.speciesChanges.every((item) => Number.isFinite(item.populationChangePercent))).toBe(true);
    expect(world.annualReview?.speciesChanges.every((item) => Number.isFinite(item.healthChange))).toBe(true);

    world = await command(agent, world, { type: 'BEGIN_NEXT_YEAR' });
    expect(world.year).toBe(2);
    expect(world.season).toBe('spring');
    expect(world.phase).toBe('active');

    const journal = await agent.get(`/api/save/${world.saveId}/journal`).expect(200);
    expect(journal.body.entries.length).toBeGreaterThan(0);
    expect(journal.body.entries.find((entry: { kind: string }) => entry.kind === 'sample').slot).toBeGreaterThan(0);
    const historyCount = store.db
      .prepare('SELECT COUNT(*) AS count FROM environment_history WHERE save_id = ?')
      .get(world.saveId) as unknown as { count: number };
    expect(Number(historyCount.count)).toBeGreaterThan(0);
    const report = await agent.get(`/api/save/${world.saveId}/report/1`).expect(200);
    expect(report.body.year).toBe(1);

    const firstExport = await agent.post(`/api/save/${world.saveId}/export`).expect(200);
    expect(firstExport.body.token).toHaveLength(43);
    const latestExport = await agent.post(`/api/save/${world.saveId}/export`).expect(200);
    await agent.post('/api/save/import').send({ token: firstExport.body.token }).expect(400);
    const imported = await agent.post('/api/save/import').send({ token: latestExport.body.token }).expect(200);
    expect(imported.body.saveId).toBe(world.saveId);
    expect(imported.body.year).toBe(2);
    expect(store.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  }, 30_000);

  it('bumps revision when read-repairing a legacy save baseline and rejects stale commands', async () => {
    const repairAgent = request.agent(app);
    const created = await repairAgent.post('/api/save').expect(201);
    const world = created.body as WorldSnapshot;

    // 模拟缺少年初基线的旧档：状态行已存在，但基线列为空，revision 停在创建时的值。
    const before = store.db
      .prepare('SELECT revision, year_start_species_json FROM saves WHERE id = ?')
      .get(world.saveId) as unknown as { revision: number; year_start_species_json: string };
    expect(JSON.parse(before.year_start_species_json).length).toBeGreaterThan(0);
    store.db
      .prepare("UPDATE saves SET year_start_species_json = '[]', year_start_sites_json = '[]' WHERE id = ?")
      .run(world.saveId);
    const staleRevision = before.revision;

    // GET 触发读取修复：基线被补回，且 revision 必须推进。
    const repaired = await repairAgent.get(`/api/save/${world.saveId}/world`).expect(200);
    const repairedWorld = repaired.body as WorldSnapshot;
    expect(repairedWorld.revision).toBe(staleRevision + 1);
    expect(
      (
        store.db
          .prepare('SELECT revision, year_start_species_json FROM saves WHERE id = ?')
          .get(world.saveId) as unknown as { revision: number; year_start_species_json: string }
      ).revision
    ).toBe(staleRevision + 1);

    // 冲突客户端仍持旧版本直接提交指令，必须被 REVISION_CONFLICT 拒绝，不能落事件污染年报。
    const rejected = await repairAgent
      .post(`/api/save/${world.saveId}/commands`)
      .send({
        expectedRevision: staleRevision,
        idempotencyKey: 'stale-client-legacy-baseline-1',
        command: { type: 'WAIT' }
      })
      .expect(409);
    expect(rejected.body.code).toBe('REVISION_CONFLICT');
    expect(rejected.body.details.actual).toBe(staleRevision + 1);
    expect(
      (
        store.db
          .prepare('SELECT COUNT(*) AS count FROM game_events WHERE save_id = ?')
          .get(world.saveId) as unknown as { count: number }
      ).count
    ).toBe(0);

    // 修复在独立事务中提交：即便指令因版本冲突失败，基线仍然保留，且 revision 不回退。
    const persisted = store.db
      .prepare('SELECT revision, year_start_species_json FROM saves WHERE id = ?')
      .get(world.saveId) as unknown as { revision: number; year_start_species_json: string };
    expect(persisted.revision).toBe(staleRevision + 1);
    expect(JSON.parse(persisted.year_start_species_json).length).toBeGreaterThan(0);

    // 未先读取的客户端直接 POST：修复同样先于指令提交，旧版本指令依旧被拒。
    store.db
      .prepare("UPDATE saves SET year_start_species_json = '[]', year_start_sites_json = '[]' WHERE id = ?")
      .run(world.saveId);
    const secondStaleRevision = persisted.revision;
    const rejectedAgain = await repairAgent
      .post(`/api/save/${world.saveId}/commands`)
      .send({
        expectedRevision: secondStaleRevision,
        idempotencyKey: 'stale-client-legacy-baseline-2',
        command: { type: 'WAIT' }
      })
      .expect(409);
    expect(rejectedAgain.body.code).toBe('REVISION_CONFLICT');
    expect(rejectedAgain.body.details.actual).toBe(secondStaleRevision + 1);

    // 客户端按 409 提示刷新到新版本后，指令可以正常提交。
    const refreshed = await repairAgent.get(`/api/save/${world.saveId}/world`).expect(200);
    const accepted = await repairAgent
      .post(`/api/save/${world.saveId}/commands`)
      .send({
        expectedRevision: (refreshed.body as WorldSnapshot).revision,
        idempotencyKey: 'fresh-client-after-repair-1',
        command: { type: 'WAIT' }
      })
      .expect(200);
    expect((accepted.body.world as WorldSnapshot).revision).toBe(secondStaleRevision + 2);
  });
});

async function command(
  agent: ReturnType<typeof request.agent>,
  world: WorldSnapshot,
  commandBody: GameCommand
): Promise<WorldSnapshot> {
  const response = await agent
    .post(`/api/save/${world.saveId}/commands`)
    .send({
      expectedRevision: world.revision,
      idempotencyKey: `test-${world.revision}-${commandBody.type}-${Math.random().toString(16).slice(2)}`,
      command: commandBody
    });
  if (response.status !== 200) {
    throw new Error(
      `${commandBody.type} failed at year ${world.year} ${world.season} day ${world.day}: ${response.status} ${JSON.stringify(response.body)}`
    );
  }
  return response.body.world as WorldSnapshot;
}

async function advanceToDayEight(
  agent: ReturnType<typeof request.agent>,
  initialWorld: WorldSnapshot
): Promise<WorldSnapshot> {
  let world = initialWorld;
  let guard = 0;
  while (world.day < 8) {
    world = await command(agent, world, { type: 'WAIT' });
    guard += 1;
    if (guard > 40) {
      throw new Error('Unable to advance to day 8');
    }
  }
  return world;
}
