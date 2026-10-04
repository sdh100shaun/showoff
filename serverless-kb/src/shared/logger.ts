import { Logger } from '@aws-lambda-powertools/logger';

/** Structured JSON logger. Service name comes from POWERTOOLS_SERVICE_NAME. */
export const logger = new Logger();
