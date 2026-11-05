import express from 'express';
import { errorMiddleware } from './errors';
import { router } from './routes';

export const app = express();
app.use(express.json());
app.get('/health', (_req, res) => res.json({ ok: true }));
app.use(router);
app.use(errorMiddleware);
