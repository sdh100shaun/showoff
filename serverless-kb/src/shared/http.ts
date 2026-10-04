import type { APIGatewayProxyResult } from 'aws-lambda';

const SECURITY_HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Strict-Transport-Security': 'max-age=63072000; includeSubDomains',
};

export function json(statusCode: number, body: unknown, requestId?: string): APIGatewayProxyResult {
  return {
    statusCode,
    headers: { ...SECURITY_HEADERS, ...(requestId ? { 'X-Request-Id': requestId } : {}) },
    body: JSON.stringify(body),
  };
}

export function empty(statusCode: number, requestId?: string): APIGatewayProxyResult {
  return { ...json(statusCode, null, requestId), body: '' };
}

/** Error response that never includes internal details. */
export function error(statusCode: number, message: string, requestId?: string, details?: string[]): APIGatewayProxyResult {
  return json(statusCode, { message, ...(details?.length ? { details } : {}), ...(requestId ? { requestId } : {}) }, requestId);
}
