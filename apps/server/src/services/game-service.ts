import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import type {
  AnnualReview,
  GameCommand,
  GamePhase,
  JournalEntry,
  RecentEvent,
  SampleMethod,
  Season,
  SeasonReview,
  SiteId,
  SpeciesSnapshot,
  WorldSnapshot
} from '@shanhai/contracts';
import { SEASON_LABELS } from '@shanhai/contracts';
import {
  applyOverwinter,
  applySampleEffects,
  CATALOG_VERSION,
  createSpeciesState,
  disperseSpecies,
  evaluateSample,
  evolveSeason,
  generateSiteState,
  getPhenologyWindow,
  getPlantPresentation,
  getStatus,
  getSuitability,
  nextSeason,
  round,
  SPECIES_BY_ID,
  SITES,
  SITES_BY_ID,
  type SiteState,
  type SpeciesState
} from '@shanhai/game-core';
import type { Store } from '../db/store.ts';
import { config } from '../config.ts';
import { AppError } from '../errors.ts';

interface SaveRecord {
  id: string;
  session_id: string;
  seed: string;
  revision: number;
  year: number;
  season: Season;
  day: number;
  slot: number;
  action_points: number;
  phase: GamePhase;
  current_site_id: SiteId;
  year_start_species_json: string;
  year_start_sites_json: string;
  restoration_unlocked: number;
  created_at: string;
  updated_at: string;
}

interface SiteStateRow {
  save_id: string;
  year: number;
  site_id: SiteId;
  weather: string;
  temperature_c: number;
  humidity: number;
  soil_moisture: number;
  light_lux: number;
  wind_speed: number;
  disturbance: number;
}

interface SpeciesStateRow {
  save_id: string;
  year: number;
  site_id: SiteId;
  species_id: string;
  population: number;
  health: number;
  seed_bank: number;
  suitability: number;
  status: string;
  phenology_json: string;
}

interface EventRow {
  id: string;
  sequence: number;
  type: string;
  message: string;
  effects_json: string;
  created_at: string;
}

interface EventDraft {
  type: string;
  message: string;
  effects: string[];
  payload: Record<string, unknown>;
}

interface CommandOutcome {
  event: EventDraft;
  evaluation?: unknown;
}

interface SessionRecord {
  id: string;
  token_hash: string;
}

const SAMPLE_LIMITS: Record<SampleMethod, number> = {
  photo: 99,
  rubbing: 3,
  litter: 3,
  cutting: 1
};

const SAMPLE_LABELS: Record<SampleMethod, string> = {
  photo: '拍照',
  rubbing: '拓印',
  litter: '落叶采集',
  cutting: '标准剪取'
};

const RESTORATION_LABELS: Record<string, string> = {
  reduce_disturbance: '降低区域干扰',
  protect_seed_bank: '保留种子区',
  restore_wetland: '恢复湿生带',
  establish_plot: '设置长期观察样方'
};

export class GameService {
  constructor(private readonly store: Store) {}

  createSession(tokenHash: string): string {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.store.db
      .prepare('INSERT INTO sessions (id, token_hash, created_at, last_seen_at) VALUES (?, ?, ?, ?)')
      .run(id, tokenHash, now, now);
    return id;
  }

  findSessionByTokenHash(tokenHash: string): SessionRecord | null {
    const row = this.store.db
      .prepare('SELECT id, token_hash FROM sessions WHERE token_hash = ?')
      .get(tokenHash) as unknown as SessionRecord | undefined;
    if (row) {
      this.store.db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').run(new Date().toISOString(), row.id);
    }
    return row ?? null;
  }

  findSaveBySession(sessionId: string): SaveRecord | null {
    const row = this.store.db
      .prepare('SELECT * FROM saves WHERE session_id = ? ORDER BY created_at DESC LIMIT 1')
      .get(sessionId) as unknown as SaveRecord | undefined;
    return row ?? null;
  }

  createSave(sessionId: string): WorldSnapshot {
    return this.store.transaction(() => {
      const session = this.store.db.prepare('SELECT id FROM sessions WHERE id = ?').get(sessionId);
      if (!session) {
        throw new AppError('UNAUTHENTICATED', '会话不存在或已失效', 401);
      }
      const existing = this.findSaveBySession(sessionId);
      if (existing) {
        throw new AppError('SAVE_EXISTS', '当前会话已经有一份观察档案', 409);
      }

      const saveId = randomUUID();
      const seed = randomBytes(16).toString('hex');
      const now = new Date().toISOString();
      this.store.db
        .prepare(
          `INSERT INTO saves (
            id, session_id, seed, revision, year, season, day, slot, action_points, phase,
            current_site_id, year_start_species_json, year_start_sites_json,
            restoration_unlocked, created_at, updated_at
          ) VALUES (?, ?, ?, 0, 1, 'spring', 1, 1, 30, 'active', 'foothill', '[]', '[]', 0, ?, ?)`
        )
        .run(saveId, sessionId, seed, now, now);

      const save = this.getSaveOrThrow(saveId, sessionId);
      this.initializeYear(save);
      this.updateSave(save);
      return this.buildWorld(this.getSaveOrThrow(saveId, sessionId));
    });
  }

  getWorld(sessionId: string, saveId: string): WorldSnapshot {
    const save = this.loadSave(sessionId, saveId);
    return this.buildWorld(save);
  }

  getJournal(sessionId: string, saveId: string, filters: { year?: number; season?: Season; siteId?: SiteId }): JournalEntry[] {
    this.loadSave(sessionId, saveId);
    const clauses = ['save_id = ?'];
    const params: Array<string | number> = [saveId];
    if (filters.year) {
      clauses.push('year = ?');
      params.push(filters.year);
    }
    if (filters.season) {
      clauses.push('season = ?');
      params.push(filters.season);
    }
    if (filters.siteId) {
      clauses.push('site_id = ?');
      params.push(filters.siteId);
    }
    const where = clauses.join(' AND ');

    const observationRows = this.store.db
      .prepare(`SELECT * FROM observations WHERE ${where} ORDER BY created_at DESC LIMIT 200`)
      .all(...params) as unknown as Array<Record<string, unknown>>;
    const sampleRows = this.store.db
      .prepare(`SELECT * FROM samples WHERE ${where} ORDER BY created_at DESC LIMIT 200`)
      .all(...params) as unknown as Array<Record<string, unknown>>;

    const entries: JournalEntry[] = observationRows.map((row) => {
      const speciesId = stringOrNull(row.species_id);
      const definition = speciesId ? SPECIES_BY_ID.get(speciesId) : undefined;
      const values = parseJson<Record<string, unknown>>(String(row.values_json), {});
      return {
        id: String(row.id),
        kind: row.kind === 'environment' ? 'environment' : 'plant',
        year: Number(row.year),
        season: String(row.season) as Season,
        day: Number(row.day),
        slot: Number(row.slot),
        siteId: String(row.site_id) as SiteId,
        siteName: SITES_BY_ID.get(String(row.site_id) as SiteId)?.name ?? String(row.site_id),
        speciesId,
        speciesName: definition?.name ?? null,
        score: Number(row.score),
        note: String(row.note ?? ''),
        createdAt: String(row.created_at),
        details: values
      };
    });

    for (const row of sampleRows) {
      const speciesId = String(row.species_id);
      entries.push({
        id: String(row.id),
        kind: 'sample',
        year: Number(row.year),
        season: String(row.season) as Season,
        day: Number(row.day),
        slot: Number(row.slot),
        siteId: String(row.site_id) as SiteId,
        siteName: SITES_BY_ID.get(String(row.site_id) as SiteId)?.name ?? String(row.site_id),
        speciesId,
        speciesName: SPECIES_BY_ID.get(speciesId)?.name ?? speciesId,
        score: null,
        note: '',
        createdAt: String(row.created_at),
        details: {
          method: String(row.method),
          methodLabel: SAMPLE_LABELS[String(row.method) as SampleMethod] ?? String(row.method),
          protocolMatch: Boolean(row.protocol_match),
          effects: parseJson<Record<string, unknown>>(String(row.effects_json), {})
        }
      });
    }

    return entries.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  getSpeciesDetail(sessionId: string, saveId: string, speciesId: string) {
    const save = this.loadSave(sessionId, saveId);
    const definition = SPECIES_BY_ID.get(speciesId);
    if (!definition) {
      throw new AppError('SPECIES_NOT_FOUND', '未找到该物种', 404);
    }
    const states = this.getSpeciesStates(saveId, save.year).filter((state) => state.speciesId === speciesId);
    const observations = this.store.db
      .prepare(
        `SELECT * FROM observations
         WHERE save_id = ? AND species_id = ?
         ORDER BY created_at DESC LIMIT 30`
      )
      .all(saveId, speciesId) as unknown as Array<Record<string, unknown>>;
    const reports = this.store.db
      .prepare('SELECT year, report_json FROM annual_reports WHERE save_id = ? ORDER BY year ASC')
      .all(saveId) as unknown as Array<Record<string, unknown>>;

    const history = reports
      .map((row) => {
        const report = parseJson<AnnualReview>(String(row.report_json), {} as AnnualReview);
        const change = report.speciesChanges?.find((item) => item.speciesId === speciesId);
        return change ? { year: Number(row.year), ...change } : null;
      })
      .filter((change): change is NonNullable<typeof change> => change !== null);

    return {
      species: {
        id: definition.id,
        name: definition.name,
        latinName: definition.latinName,
        lifeForm: definition.lifeForm,
        description: definition.description,
        protected: definition.protected,
        preferred: definition.preferred,
        sampleProtocol: definition.sampleProtocol,
        colors: definition.colors
      },
      states: states.map((state) => ({
        ...this.toSpeciesSnapshot(save, state, new Map()),
        siteId: state.siteId,
        siteName: SITES_BY_ID.get(state.siteId)?.name ?? state.siteId
      })),
      observations: observations.map((row) => ({
        id: String(row.id),
        season: String(row.season),
        year: Number(row.year),
        day: Number(row.day),
        score: Number(row.score),
        values: parseJson<Record<string, unknown>>(String(row.values_json), {}),
        feedback: parseJson<Record<string, unknown>>(String(row.feedback_json), {})
      })),
      history
    };
  }

  getAnnualReport(sessionId: string, saveId: string, year: number): AnnualReview {
    this.loadSave(sessionId, saveId);
    const row = this.store.db
      .prepare('SELECT report_json FROM annual_reports WHERE save_id = ? AND year = ?')
      .get(saveId, year) as unknown as { report_json: string } | undefined;
    if (!row) {
      throw new AppError('REPORT_NOT_FOUND', '该年度报告尚未生成', 404);
    }
    return parseJson<AnnualReview>(row.report_json, {} as AnnualReview);
  }

  executeCommand(
    sessionId: string,
    saveId: string,
    request: {
      expectedRevision: number;
      idempotencyKey: string;
      command: GameCommand;
    }
  ) {
    // 旧档补基线的读取修复在独立事务中完成并立即推进 revision，
    // 保证修复不会被本次指令的冲突回滚带走，且持有旧版本的客户端必被下方版本校验拦下。
    this.loadSave(sessionId, saveId);
    return this.store.transaction(() => {
      const save = this.getSaveOrThrow(saveId, sessionId);
      const commandHash = createHash('sha256').update(JSON.stringify(request.command)).digest('hex');
      const receipt = this.store.db
        .prepare('SELECT command_hash, response_json FROM command_receipts WHERE save_id = ? AND idempotency_key = ?')
        .get(saveId, request.idempotencyKey) as unknown as
        | { command_hash: string; response_json: string }
        | undefined;

      if (receipt) {
        if (receipt.command_hash !== commandHash) {
          throw new AppError('IDEMPOTENCY_CONFLICT', '该请求标识已用于不同操作', 409);
        }
        return parseJson<Record<string, unknown>>(receipt.response_json, {});
      }

      if (save.revision !== request.expectedRevision) {
        throw new AppError(
          'REVISION_CONFLICT',
          '存档基线已修复更新，请刷新获取最新版本后重试',
          409,
          {
            expected: request.expectedRevision,
            actual: save.revision,
            hint: '丢弃基于旧版本的操作，拉取最新世界快照后再提交'
          },
          true
        );
      }

      const outcome = this.applyCommand(save, request.command);
      save.revision += 1;
      this.updateSave(save);
      const sequenceRow = this.store.db
        .prepare('SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM game_events WHERE save_id = ?')
        .get(saveId) as unknown as { sequence: number };
      const event: RecentEvent = {
        id: randomUUID(),
        sequence: Number(sequenceRow.sequence),
        type: outcome.event.type,
        message: outcome.event.message,
        effects: outcome.event.effects,
        createdAt: new Date().toISOString()
      };
      this.store.db
        .prepare(
          `INSERT INTO game_events
           (id, save_id, sequence, type, message, effects_json, payload_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          event.id,
          saveId,
          event.sequence,
          event.type,
          event.message,
          JSON.stringify(event.effects),
          JSON.stringify(outcome.event.payload),
          event.createdAt
        );

      const world = this.buildWorld(save);
      const response = { world, event, evaluation: outcome.evaluation ?? null };
      this.store.db
        .prepare(
          `INSERT INTO command_receipts
           (save_id, idempotency_key, command_hash, response_json, created_at)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run(saveId, request.idempotencyKey, commandHash, JSON.stringify(response), new Date().toISOString());
      return response;
    });
  }

  exportSave(sessionId: string, saveId: string): { token: string; expiresAt: string } {
    this.getSaveOrThrow(saveId, sessionId);
    const token = randomBytes(32).toString('base64url');
    const tokenHash = hashToken(token);
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    this.store.db.prepare('DELETE FROM save_exports WHERE save_id = ?').run(saveId);
    this.store.db
      .prepare(
        `INSERT INTO save_exports (id, save_id, token_hash, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(randomUUID(), saveId, tokenHash, expiresAt, new Date().toISOString());
    return { token, expiresAt };
  }

  importSave(sessionId: string, token: string): SaveRecord {
    return this.store.transaction(() => {
      const tokenHash = hashToken(token);
      const exportRow = this.store.db
        .prepare('SELECT id, save_id, expires_at FROM save_exports WHERE token_hash = ?')
        .get(tokenHash) as unknown as { id: string; save_id: string; expires_at: string } | undefined;
      if (!exportRow) {
        throw new AppError('INVALID_EXPORT', '存档恢复码无效', 400);
      }
      if (new Date(exportRow.expires_at).getTime() < Date.now()) {
        throw new AppError('EXPORT_EXPIRED', '存档恢复码已过期', 410);
      }
      const existing = this.findSaveBySession(sessionId);
      if (existing && existing.id !== exportRow.save_id) {
        throw new AppError('SAVE_EXISTS', '当前会话已经有一份观察档案', 409);
      }
      this.store.db.prepare('UPDATE saves SET session_id = ?, updated_at = ? WHERE id = ?').run(
        sessionId,
        new Date().toISOString(),
        exportRow.save_id
      );
      this.store.db.prepare('DELETE FROM save_exports WHERE save_id = ?').run(exportRow.save_id);
      return this.getSaveOrThrow(exportRow.save_id, sessionId);
    });
  }

  deleteSave(sessionId: string, saveId: string): void {
    this.getSaveOrThrow(saveId, sessionId);
    this.store.db.prepare('DELETE FROM saves WHERE id = ?').run(saveId);
  }

  private initializeYear(save: SaveRecord): void {
    const speciesStates: SpeciesState[] = [];
    const siteStates: SiteState[] = [];
    for (const site of SITES) {
      const siteState = generateSiteState(save.id, save.seed, save.year, save.season, save.day, site.id);
      this.upsertSiteState(siteState);
      this.recordEnvironmentHistory(siteState, save.season, save.day);
      siteStates.push(siteState);
      for (const definition of SPECIES_BY_ID.values()) {
        if (!definition.zones[site.id]) {
          continue;
        }
        const state = createSpeciesState(save.id, save.seed, save.year, save.season, site.id, definition.id);
        state.suitability = round(getSuitability(definition, siteState), 3);
        state.status = getStatus(state.population, definition.zones[site.id]!.carryingCapacity, state.health);
        this.upsertSpeciesState(state);
        speciesStates.push(state);
      }
    }
    save.year_start_sites_json = JSON.stringify(siteStates);
    save.year_start_species_json = JSON.stringify(speciesStates);
  }

  private regenerateEnvironments(save: SaveRecord): void {
    const current = this.getSiteStates(save.id, save.year);
    const disturbance = new Map(current.map((state) => [state.siteId, state.disturbance]));
    const environmentBySite = new Map<SiteId, SiteState>();
    for (const site of SITES) {
      const state = generateSiteState(
        save.id,
        save.seed,
        save.year,
        save.season,
        save.day,
        site.id,
        disturbance.get(site.id) ?? 0.08
      );
      this.upsertSiteState(state);
      this.recordEnvironmentHistory(state, save.season, save.day);
      environmentBySite.set(site.id, state);
    }

    for (const state of this.getSpeciesStates(save.id, save.year)) {
      const definition = SPECIES_BY_ID.get(state.speciesId);
      const site = environmentBySite.get(state.siteId);
      const profile = definition?.zones[state.siteId];
      if (!definition || !site || !profile) {
        continue;
      }
      const suitability = round(getSuitability(definition, site), 3);
      this.upsertSpeciesState({
        ...state,
        suitability,
        status: getStatus(state.population, profile.carryingCapacity, state.health)
      });
    }
  }

  private applyCommand(save: SaveRecord, command: GameCommand): CommandOutcome {
    switch (command.type) {
      case 'MOVE_ZONE':
        return this.moveZone(save, command.siteId);
      case 'WAIT':
        return this.wait(save);
      case 'OBSERVE_PLANT':
        return this.observePlant(save, command.speciesId, command.values);
      case 'RECORD_ENVIRONMENT':
        return this.recordEnvironment(save, command.values);
      case 'TAKE_SAMPLE':
        return this.takeSample(save, command.speciesId, command.method);
      case 'RESTORE_HABITAT':
        return this.restoreHabitat(save, command.speciesId, command.action);
      case 'END_SEASON':
        return this.endSeason(save);
      case 'BEGIN_NEXT_SEASON':
        return this.beginNextSeason(save);
      case 'BEGIN_NEXT_YEAR':
        return this.beginNextYear(save);
    }
  }

  private moveZone(save: SaveRecord, siteId: SiteId): CommandOutcome {
    this.requireActive(save);
    if (!SITES_BY_ID.has(siteId)) {
      throw new AppError('INVALID_COMMAND', '目标区域不存在', 400);
    }
    if (save.current_site_id === siteId) {
      throw new AppError('ACTION_NOT_ALLOWED', '你已经在该区域', 409);
    }
    save.current_site_id = siteId;
    this.consumeAction(save, 1);
    return {
      event: {
        type: 'MOVE_ZONE',
        message: `移动到${SITES_BY_ID.get(siteId)?.name}`,
        effects: ['消耗 1 个行动点'],
        payload: { siteId }
      }
    };
  }

  private wait(save: SaveRecord): CommandOutcome {
    this.requireActive(save);
    this.consumeAction(save, 1);
    return {
      event: {
        type: 'WAIT',
        message: '在原地等待，山林环境继续变化',
        effects: ['消耗 1 个行动点'],
        payload: {}
      }
    };
  }

  private observePlant(
    save: SaveRecord,
    speciesId: string,
    values: Extract<GameCommand, { type: 'OBSERVE_PLANT' }>['values']
  ): CommandOutcome {
    this.requireActive(save);
    const definition = SPECIES_BY_ID.get(speciesId);
    const state = this.getSpeciesState(save.id, save.year, save.current_site_id, speciesId);
    const site = this.getSiteState(save.id, save.year, save.current_site_id);
    if (!definition || !state || !site || state.population <= 1) {
      throw new AppError('SPECIES_NOT_VISIBLE', '当前区域没有可观察的目标物种', 409);
    }

    const presentation = getPlantPresentation(definition, state, save.season, save.day);
    const score = scorePlantObservation(presentation, values, site);
    const feedback = {
      total: score,
      stageMatched: presentation.stage === values.phenology,
      leafMatched: presentation.leafTexture === values.leafTexture,
      message: score >= 85 ? '记录细致，物候判断稳定。' : score >= 60 ? '记录已保存，部分环境读数仍可校准。' : '记录已保存，建议继续观察同一目标。'
    };
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    this.store.db
      .prepare(
        `INSERT INTO observations
         (id, save_id, year, season, day, slot, site_id, species_id, kind, values_json,
          score, feedback_json, note, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'plant', ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        save.id,
        save.year,
        save.season,
        save.day,
        save.slot,
        save.current_site_id,
        speciesId,
        JSON.stringify(values),
        score,
        JSON.stringify(feedback),
        values.note,
        createdAt
      );
    this.consumeAction(save, 1);
    return {
      event: {
        type: 'OBSERVE_PLANT',
        message: `完成${definition.name}观察记录`,
        effects: [`观察评分 ${score}`, '消耗 1 个行动点'],
        payload: { observationId: id, speciesId, score }
      },
      evaluation: feedback
    };
  }

  private recordEnvironment(
    save: SaveRecord,
    values: Extract<GameCommand, { type: 'RECORD_ENVIRONMENT' }>['values']
  ): CommandOutcome {
    this.requireActive(save);
    const site = this.getSiteState(save.id, save.year, save.current_site_id);
    if (!site) {
      throw new AppError('ACTION_NOT_ALLOWED', '当前区域环境状态缺失', 500);
    }
    const score = scoreEnvironment(values, site);
    const id = randomUUID();
    const feedback = {
      total: score,
      message: score >= 80 ? '环境读数与环境站数据接近。' : '环境读数已记录，建议结合仪器重新校准。'
    };
    this.store.db
      .prepare(
        `INSERT INTO observations
         (id, save_id, year, season, day, slot, site_id, species_id, kind, values_json,
          score, feedback_json, note, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 'environment', ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        save.id,
        save.year,
        save.season,
        save.day,
        save.slot,
        save.current_site_id,
        JSON.stringify(values),
        score,
        JSON.stringify(feedback),
        values.note,
        new Date().toISOString()
      );
    this.consumeAction(save, 1);
    return {
      event: {
        type: 'RECORD_ENVIRONMENT',
        message: '完成环境数据记录',
        effects: [`环境评分 ${score}`, '消耗 1 个行动点'],
        payload: { observationId: id, score }
      },
      evaluation: feedback
    };
  }

  private takeSample(save: SaveRecord, speciesId: string, method: SampleMethod): CommandOutcome {
    this.requireActive(save);
    const definition = SPECIES_BY_ID.get(speciesId);
    const state = this.getSpeciesState(save.id, save.year, save.current_site_id, speciesId);
    const site = this.getSiteState(save.id, save.year, save.current_site_id);
    if (!definition || !state || !site || state.population <= 1) {
      throw new AppError('SPECIES_NOT_VISIBLE', '当前区域没有可采集的目标物种', 409);
    }
    const used = this.countSamples(save.id, save.year, save.season, speciesId, method);
    const decision = evaluateSample(definition, state, site, save.season, save.day, method, used);
    if (!decision.allowed) {
      throw new AppError('SAMPLE_LIMIT_REACHED', decision.reason ?? '当前不能执行采集', 409);
    }

    const nextState = applySampleEffects(state, decision, save.current_site_id);
    this.upsertSpeciesState(nextState);
    if (nextState.health < state.health || nextState.population < state.population) {
      site.disturbance = round(Math.min(0.42, site.disturbance + 0.0035), 4);
      this.upsertSiteState(site);
    }

    const id = randomUUID();
    this.store.db
      .prepare(
        `INSERT INTO samples
         (id, save_id, observation_id, year, season, day, slot, site_id, species_id, method,
          protocol_match, effects_json, created_at)
         VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        save.id,
        save.year,
        save.season,
        save.day,
        save.slot,
        save.current_site_id,
        speciesId,
        method,
        decision.protocolMatch ? 1 : 0,
        JSON.stringify({ ...decision.effects, messages: decision.messages }),
        new Date().toISOString()
      );
    this.consumeAction(save, 1);
    return {
      event: {
        type: 'TAKE_SAMPLE',
        message: `${SAMPLE_LABELS[method]}：${definition.name}${decision.protocolMatch ? '符合采集协议' : '不符合采集协议'}`,
        effects: [
          ...decision.messages,
          `健康变化 ${formatSigned(decision.effects.health)}`,
          `种群变化 ${formatSigned(decision.effects.populationDelta)}`,
          '消耗 1 个行动点'
        ],
        payload: {
          sampleId: id,
          speciesId,
          method,
          protocolMatch: decision.protocolMatch,
          effects: decision.effects
        }
      },
      evaluation: decision
    };
  }

  private restoreHabitat(
    save: SaveRecord,
    speciesId: string,
    action: Extract<GameCommand, { type: 'RESTORE_HABITAT' }>['action']
  ): CommandOutcome {
    this.requireActive(save);
    if (!save.restoration_unlocked) {
      throw new AppError('ACTION_NOT_ALLOWED', '生态修复需在年度报告揭示衰退后解锁', 409);
    }
    const definition = SPECIES_BY_ID.get(speciesId);
    const state = this.getSpeciesState(save.id, save.year, save.current_site_id, speciesId);
    const site = this.getSiteState(save.id, save.year, save.current_site_id);
    if (!definition || !state || !site || state.population <= 1) {
      throw new AppError('SPECIES_NOT_VISIBLE', '当前区域没有可修复的目标物种', 409);
    }
    if (action === 'restore_wetland' && save.current_site_id !== 'stream_valley') {
      throw new AppError('ACTION_NOT_ALLOWED', '恢复湿生带只能在溪谷湿地执行', 409);
    }
    if (save.action_points < 2) {
      throw new AppError('NO_ACTION_POINTS', '生态修复需要 2 个行动点', 409);
    }

    const profile = definition.zones[save.current_site_id]!;
    if (action === 'reduce_disturbance' || action === 'restore_wetland') {
      site.disturbance = Math.max(0, site.disturbance - (action === 'restore_wetland' ? 0.1 : 0.07));
      state.health = Math.min(100, state.health + 3);
    }
    if (action === 'protect_seed_bank') {
      state.seedBank = Math.min(profile.carryingCapacity * 1.8, state.seedBank + profile.carryingCapacity * 0.1);
    }
    if (action === 'establish_plot') {
      state.health = Math.min(100, state.health + 2);
      state.seedBank = Math.min(profile.carryingCapacity * 1.8, state.seedBank + profile.carryingCapacity * 0.04);
    }
    state.status = getStatus(state.population, profile.carryingCapacity, state.health);
    this.upsertSiteState(site);
    this.upsertSpeciesState(state);
    this.consumeAction(save, 2);
    return {
      event: {
        type: 'RESTORE_HABITAT',
        message: `${RESTORATION_LABELS[action]}：${definition.name}`,
        effects: ['区域干扰下降或繁殖条件改善', '修复效果会在后续季节或年度显现', '消耗 2 个行动点'],
        payload: { speciesId, action, siteId: save.current_site_id }
      }
    };
  }

  private endSeason(save: SaveRecord): CommandOutcome {
    this.requireActive(save);
    if (save.day < 8) {
      throw new AppError('ACTION_NOT_ALLOWED', '至少观察到第 8 日才能结束当前季节', 409);
    }
    if (save.day === 10 && save.action_points > 0) {
      throw new AppError('NO_ACTION_POINTS', '第 10 日必须完成全部行动后才能结算', 409);
    }
    const summary = this.closeSeason(save);
    return {
      event: {
        type: 'END_SEASON',
        message: `${save.year} 年${SEASON_LABELS[save.season]}季结算完成`,
        effects: [`观察 ${summary.observationCount} 次`, `采集 ${summary.sampleCount} 次`, `错误采集 ${summary.incorrectSamples} 次`],
        payload: { summary }
      },
      evaluation: summary
    };
  }

  private beginNextSeason(save: SaveRecord): CommandOutcome {
    if (save.phase !== 'season_review') {
      throw new AppError('ACTION_NOT_ALLOWED', '当前不在季节回顾状态', 409);
    }
    if (save.season === 'winter') {
      throw new AppError('ACTION_NOT_ALLOWED', '冬季结束后请查看年度报告并进入下一年', 409);
    }
    const previous = save.season;
    save.season = nextSeason(save.season);
    save.day = 1;
    save.slot = 1;
    save.action_points = 30;
    save.phase = 'active';
    this.regenerateEnvironments(save);
    return {
      event: {
        type: 'BEGIN_NEXT_SEASON',
        message: `进入${save.year} 年${SEASON_LABELS[save.season]}季`,
        effects: ['季节环境已重新生成', '行动点恢复为 30'],
        payload: { from: previous, to: save.season }
      }
    };
  }

  private beginNextYear(save: SaveRecord): CommandOutcome {
    if (save.phase !== 'year_review' || save.season !== 'winter') {
      throw new AppError('ACTION_NOT_ALLOWED', '当前不在年度回顾状态', 409);
    }
    const report = this.store.db
      .prepare('SELECT report_json FROM annual_reports WHERE save_id = ? AND year = ?')
      .get(save.id, save.year) as unknown as { report_json: string } | undefined;
    if (!report) {
      throw new AppError('REPORT_NOT_FOUND', '年度报告尚未生成', 500);
    }

    const currentSpecies = this.getSpeciesStates(save.id, save.year);
    const currentSites = this.getSiteStates(save.id, save.year);
    const siteMap = new Map(currentSites.map((site) => [site.siteId, site]));
    const nextYear = save.year + 1;
    const nextSpecies: SpeciesState[] = [];
    const nextSites: SiteState[] = [];

    for (const site of SITES) {
      const previous = siteMap.get(site.id);
      const nextSite = generateSiteState(
        save.id,
        save.seed,
        nextYear,
        'spring',
        1,
        site.id,
        Math.max(0.02, (previous?.disturbance ?? 0.08) * 0.92)
      );
      this.upsertSiteState(nextSite);
      this.recordEnvironmentHistory(nextSite, 'spring', 1);
      nextSites.push(nextSite);
    }
    const nextSiteMap = new Map(nextSites.map((site) => [site.siteId, site]));

    for (const state of currentSpecies) {
      const site = siteMap.get(state.siteId);
      const nextSite = nextSiteMap.get(state.siteId);
      const definition = SPECIES_BY_ID.get(state.speciesId);
      if (!site || !nextSite || !definition) {
        continue;
      }
      const overwintered = applyOverwinter(state, site);
      const nextState: SpeciesState = {
        ...overwintered,
        year: nextYear,
        suitability: round(getSuitability(definition, nextSite), 3)
      };
      nextState.status = getStatus(
        nextState.population,
        definition.zones[state.siteId]!.carryingCapacity,
        nextState.health
      );
      nextSpecies.push(nextState);
    }

    const dispersedSpecies = disperseSpecies(nextSpecies, nextSites);
    for (const state of dispersedSpecies) {
      this.upsertSpeciesState(state);
    }

    save.year = nextYear;
    save.season = 'spring';
    save.day = 1;
    save.slot = 1;
    save.action_points = 30;
    save.phase = 'active';
    save.year_start_species_json = JSON.stringify(dispersedSpecies);
    save.year_start_sites_json = JSON.stringify(nextSites);
    return {
      event: {
        type: 'BEGIN_NEXT_YEAR',
        message: `进入第 ${nextYear} 年，春季物候基线已更新`,
        effects: ['越冬与种子繁殖已结算', '物候和分布变化进入新年度'],
        payload: { year: nextYear }
      }
    };
  }

  private closeSeason(save: SaveRecord): SeasonReview {
    const speciesStates = this.getSpeciesStates(save.id, save.year);
    const siteStates = this.getSiteStates(save.id, save.year);
    const siteMap = new Map(siteStates.map((site) => [site.siteId, site]));
    const before = new Map(speciesStates.map((state) => [stateKey(state), state]));
    const finalStates: SpeciesState[] = [];

    const environmentHistory = this.getEnvironmentHistory(save.id, save.year, save.season);
    for (const state of speciesStates) {
      const site = siteMap.get(state.siteId);
      if (!site) {
        continue;
      }
      const history = environmentHistory.filter((entry) => entry.siteId === state.siteId);
      const result = evolveSeason(state, site, history.length > 0 ? history : [site]);
      this.upsertSpeciesState(result.state);
      finalStates.push(result.state);
    }

    const observationStats = this.store.db
      .prepare(
        `SELECT COUNT(*) AS count, COALESCE(AVG(score), 0) AS average
         FROM observations WHERE save_id = ? AND year = ? AND season = ?`
      )
      .get(save.id, save.year, save.season) as unknown as { count: number; average: number };
    const sampleStats = this.store.db
      .prepare(
        `SELECT COUNT(*) AS count,
                COALESCE(SUM(CASE WHEN protocol_match = 0 THEN 1 ELSE 0 END), 0) AS incorrect
         FROM samples WHERE save_id = ? AND year = ? AND season = ?`
      )
      .get(save.id, save.year, save.season) as unknown as { count: number; incorrect: number };

    const changes: string[] = [];
    let growing = 0;
    let declining = 0;
    for (const state of finalStates) {
      const previous = before.get(stateKey(state));
      if (!previous) {
        continue;
      }
      if (state.population > previous.population * 1.02) {
        growing += 1;
      }
      if (state.population < previous.population * 0.985 || state.status === 'vulnerable' || state.status === 'endangered') {
        declining += 1;
      }
    }
    changes.push(`${growing} 个区域种群呈增长趋势，${declining} 个区域种群需要关注。`);
    if (Number(sampleStats.incorrect) > 0) {
      changes.push(`本季有 ${Number(sampleStats.incorrect)} 次采集不符合协议，影响已写入区域状态。`);
    } else {
      changes.push('本季没有错误采集记录。');
    }

    const summary: SeasonReview = {
      year: save.year,
      season: save.season,
      observationCount: Number(observationStats.count),
      averageObservationScore: round(Number(observationStats.average), 1),
      sampleCount: Number(sampleStats.count),
      incorrectSamples: Number(sampleStats.incorrect),
      changes
    };

    this.store.db
      .prepare(
        `INSERT INTO season_summaries (id, save_id, year, season, summary_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(randomUUID(), save.id, save.year, save.season, JSON.stringify(summary), new Date().toISOString());

    if (save.season === 'winter') {
      const report = this.createAnnualReport(save, finalStates);
      const shouldUnlock =
        report.populationChangePercent < -2 ||
        report.incorrectSamples > 0 ||
        report.speciesChanges.some((change) => change.status === 'vulnerable' || change.status === 'endangered');
      report.restorationUnlocked = shouldUnlock;
      this.store.db
        .prepare(
          `INSERT OR REPLACE INTO annual_reports (id, save_id, year, report_json, created_at)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run(randomUUID(), save.id, save.year, JSON.stringify(report), new Date().toISOString());
      save.restoration_unlocked = save.restoration_unlocked || (shouldUnlock ? 1 : 0);
      save.phase = 'year_review';
    } else {
      save.phase = 'season_review';
    }
    return summary;
  }

  private createAnnualReport(save: SaveRecord, finalStates: SpeciesState[]): AnnualReview {
    const initialStates = parseJson<SpeciesState[]>(save.year_start_species_json, []);
    const initialByKey = new Map(initialStates.map((state) => [stateKey(state), state]));
    const finalByKey = new Map(finalStates.map((state) => [stateKey(state), state]));
    const keys = new Set([...initialByKey.keys(), ...finalByKey.keys()]);

    const speciesAggregate = new Map<
      string,
      { startPopulation: number; finalPopulation: number; startHealth: number; finalHealth: number; count: number; status: string }
    >();
    const distributionChanges: string[] = [];

    for (const key of keys) {
      const initial = initialByKey.get(key);
      const final = finalByKey.get(key);
      const state = final ?? initial;
      if (!state) {
        continue;
      }
      const aggregate = speciesAggregate.get(state.speciesId) ?? {
        startPopulation: 0,
        finalPopulation: 0,
        startHealth: 0,
        finalHealth: 0,
        count: 0,
        status: 'stable'
      };
      aggregate.startPopulation += initial?.population ?? 0;
      aggregate.finalPopulation += final?.population ?? 0;
      aggregate.startHealth += initial?.health ?? 0;
      aggregate.finalHealth += final?.health ?? 0;
      aggregate.count += 1;
      aggregate.status = worstStatus(aggregate.status, final?.status ?? initial?.status ?? 'stable');
      speciesAggregate.set(state.speciesId, aggregate);

      if (initial && final && initial.status !== final.status) {
        distributionChanges.push(
          `${SITES_BY_ID.get(state.siteId)?.name ?? state.siteId}：${SPECIES_BY_ID.get(state.speciesId)?.name ?? state.speciesId} 由 ${statusLabel(initial.status)} 变为 ${statusLabel(final.status)}`
        );
      }
    }

    let totalStart = 0;
    let totalFinal = 0;
    const speciesChanges = [...speciesAggregate.entries()].map(([speciesId, aggregate]) => {
      totalStart += aggregate.startPopulation;
      totalFinal += aggregate.finalPopulation;
      return {
        speciesId,
        name: SPECIES_BY_ID.get(speciesId)?.name ?? speciesId,
        populationChangePercent: percentChange(aggregate.startPopulation, aggregate.finalPopulation),
        healthChange: round(
          aggregate.finalHealth / Math.max(1, aggregate.count) - aggregate.startHealth / Math.max(1, aggregate.count),
          1
        ),
        status: aggregate.status
      };
    });
    speciesChanges.sort((left, right) => left.populationChangePercent - right.populationChangePercent);

    const incorrectSamples = Number(
      (
        this.store.db
          .prepare('SELECT COUNT(*) AS count FROM samples WHERE save_id = ? AND year = ? AND protocol_match = 0')
          .get(save.id, save.year) as unknown as { count: number }
      ).count
    );

    const recommendations: string[] = [];
    if (incorrectSamples > 0) {
      recommendations.push('下一年优先使用拍照和条件合适的非破坏性采集，避免在错误物候期重复取样。');
    }
    const declining = speciesChanges.filter((item) => item.populationChangePercent < -2);
    if (declining.length > 0) {
      recommendations.push(`重点关注 ${declining.slice(0, 3).map((item) => item.name).join('、')}，并在衰退区域设置观察样方。`);
    }
    if (distributionChanges.some((item) => item.includes('濒危'))) {
      recommendations.push('对濒危区域停止剪取，优先执行降低干扰和保留种子区。');
    }
    if (recommendations.length < 2) {
      recommendations.push('保持固定样方和连续物候记录，以提高下一年度花期预报置信度。');
    }

    const populationChangePercent = percentChange(totalStart, totalFinal);
    const headline =
      populationChangePercent < -5
        ? '今年的人为干扰和气候压力已改变物种分布'
        : populationChangePercent < 1
          ? '生态系统总体稳定，但局部种群正在调整'
          : '适宜生境中的种群实现增长，分布正在恢复';

    return {
      year: save.year,
      headline,
      populationChangePercent,
      speciesChanges,
      distributionChanges: distributionChanges.length > 0 ? distributionChanges : ['本年度未发生跨等级分布状态变化。'],
      incorrectSamples,
      recommendations,
      restorationUnlocked: false
    };
  }

  private buildWorld(save: SaveRecord): WorldSnapshot {
    const siteStates = this.getSiteStates(save.id, save.year);
    const speciesStates = this.getSpeciesStates(save.id, save.year);
    const siteMap = new Map(siteStates.map((state) => [state.siteId, state]));
    const speciesBySite = new Map<SiteId, SpeciesState[]>();
    for (const state of speciesStates) {
      const list = speciesBySite.get(state.siteId) ?? [];
      list.push(state);
      speciesBySite.set(state.siteId, list);
    }

    const sampleCounts = this.store.db
      .prepare(
        `SELECT species_id, method, COUNT(*) AS used
         FROM samples WHERE save_id = ? AND year = ? AND season = ?
         GROUP BY species_id, method`
      )
      .all(save.id, save.year, save.season) as unknown as Array<{ species_id: string; method: SampleMethod; used: number }>;
    const sampleUsage = new Map<string, number>();
    for (const row of sampleCounts) {
      sampleUsage.set(`${row.species_id}:${row.method}`, Number(row.used));
    }
    const unlockCounts = this.store.db
      .prepare(
        `SELECT species_id, COUNT(*) AS count
         FROM observations WHERE save_id = ? AND species_id IS NOT NULL
         GROUP BY species_id`
      )
      .all(save.id) as unknown as Array<{ species_id: string; count: number }>;
    const unlocked = new Set(unlockCounts.filter((row) => Number(row.count) >= 3).map((row) => row.species_id));

    const sites = SITES.map((site) => {
      const environment = siteMap.get(site.id) ?? generateSiteState(save.id, save.seed, save.year, save.season, save.day, site.id);
      const states = (speciesBySite.get(site.id) ?? [])
        .filter((state) => state.population > 1)
        .map((state) => ({
          ...this.toSpeciesSnapshot(save, state, sampleUsage),
          unlocked: unlocked.has(state.speciesId)
        }))
        .sort((left, right) => right.population - left.population);
      return {
        id: site.id,
        name: site.name,
        habitat: site.habitat,
        description: site.description,
        mapX: site.mapX,
        mapY: site.mapY,
        current: site.id === save.current_site_id,
        environment: {
          weather: environment.weather,
          temperatureC: environment.temperatureC,
          humidity: environment.humidity,
          soilMoisture: environment.soilMoisture,
          lightLux: environment.lightLux,
          windSpeed: environment.windSpeed,
          disturbance: environment.disturbance
        },
        species: states
      };
    });

    const eventRows = this.store.db
      .prepare('SELECT id, sequence, type, message, effects_json, created_at FROM game_events WHERE save_id = ? ORDER BY sequence DESC LIMIT 12')
      .all(save.id) as unknown as EventRow[];
    const recentEvents: RecentEvent[] = eventRows.map((row) => ({
      id: row.id,
      sequence: Number(row.sequence),
      type: row.type,
      message: row.message,
      effects: parseJson<string[]>(row.effects_json, []),
      createdAt: row.created_at
    }));

    const seasonSummaryRow = this.store.db
      .prepare('SELECT summary_json FROM season_summaries WHERE save_id = ? AND year = ? AND season = ?')
      .get(save.id, save.year, save.season) as unknown as { summary_json: string } | undefined;
    const reportRow = this.store.db
      .prepare('SELECT report_json FROM annual_reports WHERE save_id = ? AND year = ?')
      .get(save.id, save.year) as unknown as { report_json: string } | undefined;

    return {
      saveId: save.id,
      revision: save.revision,
      year: save.year,
      season: save.season,
      seasonLabel: SEASON_LABELS[save.season],
      day: save.day,
      slot: save.slot,
      actionPoints: save.action_points,
      phase: save.phase,
      currentSiteId: save.current_site_id,
      restorationUnlocked: Boolean(save.restoration_unlocked),
      sites,
      recentEvents,
      seasonReview: seasonSummaryRow ? parseJson<SeasonReview>(seasonSummaryRow.summary_json, null as unknown as SeasonReview) : null,
      annualReview: reportRow ? parseJson<AnnualReview>(reportRow.report_json, null as unknown as AnnualReview) : null
    };
  }

  private toSpeciesSnapshot(save: SaveRecord, state: SpeciesState, sampleUsage: Map<string, number>): SpeciesSnapshot {
    const definition = SPECIES_BY_ID.get(state.speciesId);
    if (!definition) {
      throw new Error(`Missing species definition ${state.speciesId}`);
    }
    const profile = definition.zones[state.siteId]!;
    const presentation = getPlantPresentation(definition, state, save.season, save.day);
    const effectivePhenology = getPhenologyWindow(definition, state, save.season);
    const site = this.getSiteState(save.id, save.year, state.siteId);
    const sampleLimits = Object.fromEntries(
      (Object.keys(SAMPLE_LIMITS) as SampleMethod[]).map((method) => {
        const used = sampleUsage.get(`${state.speciesId}:${method}`) ?? 0;
        const decision = site
          ? evaluateSample(definition, state, site, save.season, save.day, method, used)
          : { allowed: false, reason: '当前区域环境数据缺失' };
        return [
          method,
          {
            used,
            limit: SAMPLE_LIMITS[method],
            allowed: decision.allowed,
            reason: decision.allowed ? undefined : decision.reason ?? '当前不可采集'
          }
        ];
      })
    ) as SpeciesSnapshot['sampleLimits'];

    const publicSnapshot: SpeciesSnapshot = {
      id: definition.id,
      name: definition.name,
      latinName: definition.latinName,
      lifeForm: definition.lifeForm,
      protected: definition.protected,
      population: round(state.population, 1),
      carryingCapacity: profile.carryingCapacity,
      health: round(state.health, 1),
      seedBank: round(state.seedBank, 1),
      suitability: round(state.suitability, 3),
      status: state.status as SpeciesSnapshot['status'],
      phenology: {
        ...presentation,
        bloomStartDay: effectivePhenology?.start ?? state.phenology.bloomStartDay,
        bloomPeakDay: effectivePhenology?.peak ?? state.phenology.bloomPeakDay,
        bloomEndDay: effectivePhenology?.end ?? state.phenology.bloomEndDay
      },
      sampleLimits,
      unlocked: false
    };
    return publicSnapshot;
  }

  private consumeAction(save: SaveRecord, cost: number): void {
    if (save.action_points < cost) {
      throw new AppError('NO_ACTION_POINTS', `该操作需要 ${cost} 个行动点`, 409);
    }
    const previousDay = save.day;
    save.action_points -= cost;
    const used = 30 - save.action_points;
    if (save.action_points === 0) {
      save.day = 10;
      save.slot = 3;
    } else {
      save.day = Math.min(10, Math.floor(used / 3) + 1);
      save.slot = Math.min(3, (used % 3) + 1);
    }
    if (save.day !== previousDay) {
      this.regenerateEnvironments(save);
    }
  }

  private requireActive(save: SaveRecord): void {
    if (save.phase !== 'active') {
      throw new AppError('ACTION_NOT_ALLOWED', '当前阶段需要先完成回顾', 409);
    }
  }

  /**
   * 读取存档，并对缺少年初基线的旧档执行读取修复。
   * 修复在独立事务中提交且必然推进 revision：冲突客户端下一次提交会收到
   * REVISION_CONFLICT，无法再以旧版本继续写指令污染年度报告。
   */
  private loadSave(sessionId: string, saveId: string): SaveRecord {
    const current = this.getSaveOrThrow(saveId, sessionId);
    if (parseJson<unknown[]>(current.year_start_species_json, []).length > 0) {
      return current;
    }
    this.backfillYearStartBaseline(saveId, sessionId);
    return this.getSaveOrThrow(saveId, sessionId);
  }

  private backfillYearStartBaseline(saveId: string, sessionId: string): void {
    this.store.transaction(() => {
      const row = this.getSaveOrThrow(saveId, sessionId);
      if (parseJson<unknown[]>(row.year_start_species_json, []).length > 0) {
        return;
      }
      const speciesStates = this.getSpeciesStates(row.id, row.year);
      const siteStates = this.getSiteStates(row.id, row.year);
      if (speciesStates.length === 0 || siteStates.length === 0) {
        return;
      }
      row.year_start_species_json = JSON.stringify(speciesStates);
      row.year_start_sites_json = JSON.stringify(siteStates);
      row.revision += 1;
      this.updateSave(row);
    });
  }

  private getSaveOrThrow(saveId: string, sessionId: string): SaveRecord {
    const row = this.store.db
      .prepare('SELECT * FROM saves WHERE id = ? AND session_id = ?')
      .get(saveId, sessionId) as unknown as SaveRecord | undefined;
    if (!row) {
      throw new AppError('SAVE_NOT_FOUND', '未找到该观察档案', 404);
    }
    return row;
  }

  private updateSave(save: SaveRecord): void {
    save.updated_at = new Date().toISOString();
    this.store.db
      .prepare(
        `UPDATE saves SET
          revision = ?, year = ?, season = ?, day = ?, slot = ?, action_points = ?, phase = ?,
          current_site_id = ?, year_start_species_json = ?, year_start_sites_json = ?,
          restoration_unlocked = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(
        save.revision,
        save.year,
        save.season,
        save.day,
        save.slot,
        save.action_points,
        save.phase,
        save.current_site_id,
        save.year_start_species_json,
        save.year_start_sites_json,
        save.restoration_unlocked,
        save.updated_at,
        save.id
      );
  }

  private getSiteStates(saveId: string, year: number): SiteState[] {
    return (
      this.store.db
        .prepare('SELECT * FROM site_states WHERE save_id = ? AND year = ? ORDER BY site_id')
        .all(saveId, year) as unknown as SiteStateRow[]
    ).map(rowToSiteState);
  }

  private getSiteState(saveId: string, year: number, siteId: SiteId): SiteState | null {
    const row = this.store.db
      .prepare('SELECT * FROM site_states WHERE save_id = ? AND year = ? AND site_id = ?')
      .get(saveId, year, siteId) as unknown as SiteStateRow | undefined;
    return row ? rowToSiteState(row) : null;
  }

  private upsertSiteState(state: SiteState): void {
    this.store.db
      .prepare(
        `INSERT INTO site_states
         (save_id, year, site_id, weather, temperature_c, humidity, soil_moisture, light_lux, wind_speed, disturbance)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(save_id, year, site_id) DO UPDATE SET
           weather = excluded.weather,
           temperature_c = excluded.temperature_c,
           humidity = excluded.humidity,
           soil_moisture = excluded.soil_moisture,
           light_lux = excluded.light_lux,
           wind_speed = excluded.wind_speed,
           disturbance = excluded.disturbance`
      )
      .run(
        state.saveId,
        state.year,
        state.siteId,
        state.weather,
        state.temperatureC,
        state.humidity,
        state.soilMoisture,
        state.lightLux,
        state.windSpeed,
        state.disturbance
      );
  }

  private getSpeciesStates(saveId: string, year: number): SpeciesState[] {
    return (
      this.store.db
        .prepare('SELECT * FROM species_states WHERE save_id = ? AND year = ?')
        .all(saveId, year) as unknown as SpeciesStateRow[]
    ).map(rowToSpeciesState);
  }

  private getSpeciesState(saveId: string, year: number, siteId: SiteId, speciesId: string): SpeciesState | null {
    const row = this.store.db
      .prepare(
        'SELECT * FROM species_states WHERE save_id = ? AND year = ? AND site_id = ? AND species_id = ?'
      )
      .get(saveId, year, siteId, speciesId) as unknown as SpeciesStateRow | undefined;
    return row ? rowToSpeciesState(row) : null;
  }

  private upsertSpeciesState(state: SpeciesState): void {
    this.store.db
      .prepare(
        `INSERT INTO species_states
         (save_id, year, site_id, species_id, population, health, seed_bank, suitability, status, phenology_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(save_id, year, site_id, species_id) DO UPDATE SET
           population = excluded.population,
           health = excluded.health,
           seed_bank = excluded.seed_bank,
           suitability = excluded.suitability,
           status = excluded.status,
           phenology_json = excluded.phenology_json`
      )
      .run(
        state.saveId,
        state.year,
        state.siteId,
        state.speciesId,
        state.population,
        state.health,
        state.seedBank,
        state.suitability,
        state.status,
        JSON.stringify(state.phenology)
      );
  }

  private recordEnvironmentHistory(state: SiteState, season: Season, day: number): void {
    this.store.db
      .prepare(
        `INSERT OR REPLACE INTO environment_history
         (save_id, year, season, day, site_id, weather, temperature_c, humidity,
          soil_moisture, light_lux, wind_speed, disturbance)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        state.saveId,
        state.year,
        season,
        day,
        state.siteId,
        state.weather,
        state.temperatureC,
        state.humidity,
        state.soilMoisture,
        state.lightLux,
        state.windSpeed,
        state.disturbance
      );
  }

  private getEnvironmentHistory(saveId: string, year: number, season: Season): SiteState[] {
    return (
      this.store.db
        .prepare(
          `SELECT * FROM environment_history
           WHERE save_id = ? AND year = ? AND season = ?
           ORDER BY day ASC`
        )
        .all(saveId, year, season) as unknown as SiteStateRow[]
    ).map(rowToSiteState);
  }

  private countSamples(saveId: string, year: number, season: Season, speciesId: string, method: SampleMethod): number {
    return Number(
      (
        this.store.db
          .prepare(
            `SELECT COUNT(*) AS count FROM samples
             WHERE save_id = ? AND year = ? AND season = ? AND species_id = ? AND method = ?`
          )
          .get(saveId, year, season, speciesId, method) as unknown as { count: number }
      ).count
    );
  }
}

function rowToSiteState(row: SiteStateRow): SiteState {
  return {
    saveId: String(row.save_id),
    year: Number(row.year),
    siteId: row.site_id,
    weather: String(row.weather),
    temperatureC: Number(row.temperature_c),
    humidity: Number(row.humidity),
    soilMoisture: Number(row.soil_moisture),
    lightLux: Number(row.light_lux),
    windSpeed: Number(row.wind_speed),
    disturbance: Number(row.disturbance)
  };
}

function rowToSpeciesState(row: SpeciesStateRow): SpeciesState {
  return {
    saveId: String(row.save_id),
    year: Number(row.year),
    siteId: row.site_id,
    speciesId: String(row.species_id),
    population: Number(row.population),
    health: Number(row.health),
    seedBank: Number(row.seed_bank),
    suitability: Number(row.suitability),
    status: String(row.status),
    phenology: {
      ...parseJson(row.phenology_json, { bloomStartDay: 5, bloomPeakDay: 7, bloomEndDay: 9 }),
      shift: Number(parseJson<{ shift?: number }>(row.phenology_json, {}).shift ?? 0)
    }
  };
}

function scorePlantObservation(
  presentation: ReturnType<typeof getPlantPresentation>,
  values: Extract<GameCommand, { type: 'OBSERVE_PLANT' }>['values'],
  site: SiteState
): number {
  let score = 0;
  if (values.phenology === presentation.stage) score += 40;
  if (values.leafTexture === presentation.leafTexture) score += 25;
  if (normalizeColor(values.dominantColor) === normalizeColor(presentation.dominantColor)) score += 10;
  if (Math.abs(values.temperatureC - site.temperatureC) <= 1) score += 8;
  if (Math.abs(values.humidity - site.humidity) <= 5) score += 7;
  if (Math.abs(values.soilMoisture - site.soilMoisture) <= 5) score += 5;
  if (Math.abs(values.lightLux - site.lightLux) <= Math.max(2500, site.lightLux * 0.2)) score += 5;
  return round(score, 1);
}

function scoreEnvironment(
  values: Extract<GameCommand, { type: 'RECORD_ENVIRONMENT' }>['values'],
  site: SiteState
): number {
  let score = 0;
  if (Math.abs(values.temperatureC - site.temperatureC) <= 1) score += 30;
  if (Math.abs(values.humidity - site.humidity) <= 5) score += 25;
  if (Math.abs(values.soilMoisture - site.soilMoisture) <= 5) score += 25;
  if (Math.abs(values.lightLux - site.lightLux) <= Math.max(2500, site.lightLux * 0.2)) score += 20;
  return score;
}

function normalizeColor(value: string): string {
  return value.trim().toLowerCase().replaceAll(' ', '');
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function hashToken(token: string): string {
  return createHmac('sha256', config.sessionSecret).update(token).digest('hex');
}

function stateKey(state: SpeciesState): string {
  return `${state.siteId}:${state.speciesId}`;
}

function percentChange(start: number, end: number): number {
  if (start <= 0) {
    return end > 0 ? 100 : 0;
  }
  return round(((end - start) / start) * 100, 1);
}

function formatSigned(value: number): string {
  return `${value >= 0 ? '+' : ''}${round(value, 2)}`;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    growing: '增长',
    stable: '稳定',
    vulnerable: '脆弱',
    endangered: '濒危',
    absent: '局部消失'
  };
  return labels[status] ?? status;
}

function worstStatus(left: string, right: string): string {
  const severity: Record<string, number> = {
    growing: 0,
    stable: 1,
    vulnerable: 2,
    endangered: 3,
    absent: 4
  };
  return (severity[right] ?? 1) > (severity[left] ?? 1) ? right : left;
}

export { CATALOG_VERSION };
