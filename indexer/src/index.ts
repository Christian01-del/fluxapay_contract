import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { config } from './config';
import { logger } from './utils/logger';
import { errorHandler } from './middleware/errorHandler';
import { sep10Auth } from './auth/sep10-jwt';
import routes from './routes';

const app = express();

app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(morgan('combined', { stream: { write: (msg: string) => logger.info(msg.trim()) } }));

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.use('/api', sep10Auth, routes);

app.use(errorHandler);

const port = config.port;

app.listen(port, () => {
  logger.info(`FluxaPay indexer listening on port ${port}`);
});

export default app;
