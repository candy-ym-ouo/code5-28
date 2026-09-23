import path from 'node:path';
import { randomBytes } from 'node:crypto';
import cookieParser from 'cookie-parser';
import express, { type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import pino from 'pino';
import pinoHttp from 'pino-http';
import { z, ZodError } from 'zod';
import {
  CommandRequestSchema,
  ImportSaveSchema,
  SITE_IDS,
  SEASONS
} from '@shanhai/contracts';
import { CATALOG_VERSION, SPECIES, SITES } from '@shanhai/game-core';
import { config } from './config.ts';
import { Store } from './db/store.ts';
import { AppError } from './errors.ts';
import { GameService, hashToken } from './services/game-service.ts';

const SESSION_COOKIE = 'shanhai_session';

export interface CreateAppOptions {
  databasePath?: string;
  loggerEnabled?: boolean;
}

export function createApp(options: CreateAppOptions = {}) {
  const store = new Store(options.databasePath ?? config.databaseUrl);
  const service = new GameService(store);
  const logger = pino({ level: options.loggerEnabled === false ? 'silent' : config.logLevel });
  const app = express();

  app.disable('x-powered-by');
  app.use('/api', (_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(express.json({ limit: '32kb' }));
  app.use(cookieParser());
  if (options.loggerEnabled !== false) {
    app.use(
      pinoHttp({
        logger,
        redact: {
          paths: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]'],
          censor: '[REDACTED]'
        }
      })
    );
  }

  app.use((req, _res, next) => {
    if (req.path.startsWith('/api') && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const origin = req.headers.origin;
      if (origin && !config.allowedOrigins.includes(origin)) {
        next(new AppError('FORBIDDEN_ORIGIN', '请求来源校验失败', 403));
        return;
      }
    }
    next();
  });

  app.use((req, res, next) => {
    const rawToken = req.cookies?.[SESSION_COOKIE];
    if (typeof rawToken === 'string' && rawToken.length > 20) {
      const session = service.findSessionByTokenHash(hashToken(rawToken));
      if (session) {
        res.locals.sessionId = session.id;
      }
    }
    next();
  });

  app.get('/api/health', (_req, res) => {
    const row = store.db.prepare('SELECT 1 AS ok').get() as unknown as { ok: number };
    res.json({
      status: row.ok === 1 ? 'ok' : 'degraded',
      catalogVersion: CATALOG_VERSION,
      time: new Date().toISOString()
    });
  });

  app.get('/api/meta/catalog', (_req, res) => {
    res.json({
      version: CATALOG_VERSION,
      sites: SITES.map((site) => ({
        id: site.id,
        name: site.name,
        habitat: site.habitat,
        description: site.description,
        mapX: site.mapX,
        mapY: site.mapY
      })),
      species: SPECIES.map((species) => ({
        id: species.id,
        name: species.name,
        latinName: species.latinName,
        lifeForm: species.lifeForm,
        description: species.description,
        protected: species.protected
      }))
    });
  });

  app.get('/api/save/current', (req, res) => {
    const sessionId = res.locals.sessionId as string | undefined;
    if (!sessionId) {
      res.json({ save: null, world: null });
      return;
    }
    const save = service.findSaveBySession(sessionId);
    if (!save) {
      res.json({ save: null, world: null });
      return;
    }
    const world = service.getWorld(sessionId, save.id);
    res.json({
      save: {
        id: save.id,
        year: world.year,
        season: world.season,
        // 以读取修复后 world 内的 revision 为准，避免客户端继续持有修复前的旧版本
        revision: world.revision
      },
      world
    });
  });

  app.post('/api/save', (_req, res) => {
    const sessionId = ensureSession(res, service);
    res.status(201).json(service.createSave(sessionId));
  });

  app.get('/api/save/:saveId/world', requireSession, (req, res) => {
    res.json(service.getWorld(res.locals.sessionId as string, parameter(req, 'saveId')));
  });

  app.get('/api/save/:saveId/journal', requireSession, (req, res) => {
    const query = z
      .object({
        year: z.coerce.number().int().positive().optional(),
        season: z.enum(SEASONS).optional(),
        siteId: z.enum(SITE_IDS).optional()
      })
      .parse(req.query);
    res.json({
      entries: service.getJournal(res.locals.sessionId as string, parameter(req, 'saveId'), query)
    });
  });

  app.get('/api/save/:saveId/species/:speciesId', requireSession, (req, res) => {
    res.json(service.getSpeciesDetail(res.locals.sessionId as string, parameter(req, 'saveId'), parameter(req, 'speciesId')));
  });

  app.get('/api/save/:saveId/report/:year', requireSession, (req, res) => {
    const year = z.coerce.number().int().positive().parse(parameter(req, 'year'));
    res.json(service.getAnnualReport(res.locals.sessionId as string, parameter(req, 'saveId'), year));
  });

  app.get('/api/save/:saveId/events', requireSession, (req, res) => {
    const world = service.getWorld(res.locals.sessionId as string, parameter(req, 'saveId'));
    res.json({ events: world.recentEvents });
  });

  app.post('/api/save/:saveId/commands', requireSession, (req, res) => {
    const request = CommandRequestSchema.parse(req.body);
    const result = service.executeCommand(res.locals.sessionId as string, parameter(req, 'saveId'), request);
    res.json(result);
  });

  app.post('/api/save/:saveId/export', requireSession, (req, res) => {
    res.json(service.exportSave(res.locals.sessionId as string, parameter(req, 'saveId')));
  });

  app.post('/api/save/import', (req, res) => {
    const input = ImportSaveSchema.parse(req.body);
    const sessionId = ensureSession(res, service);
    service.importSave(sessionId, input.token);
    const save = service.findSaveBySession(sessionId);
    if (!save) {
      throw new AppError('SAVE_NOT_FOUND', '恢复后未找到存档', 500);
    }
    res.json(service.getWorld(sessionId, save.id));
  });

  app.delete('/api/save/:saveId', requireSession, (req, res) => {
    service.deleteSave(res.locals.sessionId as string, parameter(req, 'saveId'));
    res.clearCookie(SESSION_COOKIE, {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.nodeEnv === 'production',
      path: '/'
    });
    res.status(204).end();
  });

  const webDist = path.join(config.projectRoot, 'apps/web/dist');
  app.use(express.static(webDist));
  app.use((req, res, next) => {
    if (req.method === 'GET' && !req.path.startsWith('/api') && !path.extname(req.path) && req.accepts('html')) {
      res.sendFile(path.join(webDist, 'index.html'), (error) => {
        if (error) {
          next();
        }
      });
      return;
    }
    next();
  });

  app.use((_req, _res, next) => {
    next(new AppError('NOT_FOUND', '请求的资源不存在', 404));
  });

  app.use((error: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) {
      _next(error);
      return;
    }
    const traceId = String((req as Request & { id?: string }).id ?? randomBytes(6).toString('hex'));
    if (error instanceof ZodError) {
      res.status(400).json({
        code: 'INVALID_COMMAND',
        message: '请求参数校验失败',
        details: error.flatten(),
        traceId,
        retryable: false
      });
      return;
    }
    const httpError = error as { status?: number; type?: string };
    if (httpError.status === 400 && httpError.type === 'entity.parse.failed') {
      res.status(400).json({
        code: 'INVALID_JSON',
        message: '请求体不是有效 JSON',
        traceId,
        retryable: false
      });
      return;
    }
    if (httpError.status === 413) {
      res.status(413).json({
        code: 'PAYLOAD_TOO_LARGE',
        message: '请求体超过大小限制',
        traceId,
        retryable: false
      });
      return;
    }
    if (error instanceof AppError) {
      res.status(error.status).json({
        code: error.code,
        message: error.message,
        details: error.details,
        traceId,
        retryable: error.retryable
      });
      return;
    }
    logger.error({ error, traceId }, 'Unhandled API error');
    res.status(500).json({
      code: 'INTERNAL_ERROR',
      message: '服务器处理请求时发生错误',
      traceId,
      retryable: true
    });
  });

  return { app, store, service };
}

function ensureSession(res: Response, service: GameService): string {
  const existing = res.locals.sessionId as string | undefined;
  if (existing) {
    return existing;
  }
  const rawToken = randomBytes(32).toString('base64url');
  const sessionId = service.createSession(hashToken(rawToken));
  res.locals.sessionId = sessionId;
  res.cookie(SESSION_COOKIE, rawToken, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.nodeEnv === 'production',
    maxAge: 365 * 24 * 60 * 60 * 1000,
    path: '/'
  });
  return sessionId;
}

function parameter(req: Request, name: string): string {
  const value = req.params[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new AppError('INVALID_COMMAND', `缺少参数 ${name}`, 400);
  }
  return value;
}

function requireSession(_req: Request, res: Response, next: NextFunction): void {
  if (!res.locals.sessionId) {
    next(new AppError('UNAUTHENTICATED', '请先创建或导入观察档案', 401));
    return;
  }
  next();
}

export { SESSION_COOKIE };
