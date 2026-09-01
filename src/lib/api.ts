/**
 * Shared API-route plumbing: JSON responses and error mapping.
 *
 * Error messages are deliberately specific about *what the user did wrong* and
 * silent about infrastructure details — a BigQuery stack trace never reaches the
 * browser.
 */

import { NextResponse } from 'next/server';

interface StatusError extends Error {
  status?: number;
}

const SAFE_ERRORS = new Set([
  'InvalidIdentifierError',
  'UnsafeQueryError',
  'QueryTooExpensiveError',
  'CompareSpecError',
  'DateFilterRequiredError',
]);

export function ok<T>(data: T, init?: ResponseInit): NextResponse {
  return NextResponse.json(data, {
    ...init,
    headers: { 'Cache-Control': 'no-store', ...(init?.headers ?? {}) },
  });
}

export function fail(error: unknown): NextResponse {
  const err = error as StatusError;
  const status = typeof err?.status === 'number' ? err.status : 500;
  const isSafe = SAFE_ERRORS.has(err?.name ?? '') || status < 500;

  if (!isSafe) {
    // Full detail stays in Cloud Logging; the client gets a generic message.
    console.error('[bq-explorer] unhandled error', err);
  }

  return NextResponse.json(
    {
      error: isSafe ? err.message : 'The request could not be completed. Check the server logs for details.',
      code: err?.name ?? 'Error',
    },
    { status, headers: { 'Cache-Control': 'no-store' } },
  );
}

/** Reads and parses a JSON body, rejecting anything that is not an object. */
export async function readJson(request: Request): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    const error = new Error('Request body must be valid JSON.') as StatusError;
    error.name = 'InvalidIdentifierError';
    error.status = 400;
    throw error;
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    const error = new Error('Request body must be a JSON object.') as StatusError;
    error.name = 'InvalidIdentifierError';
    error.status = 400;
    throw error;
  }
  return body as Record<string, unknown>;
}

export function stringArray(value: unknown, field: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    const error = new Error(`"${field}" must be an array of strings.`) as StatusError;
    error.name = 'InvalidIdentifierError';
    error.status = 400;
    throw error;
  }
  return value as string[];
}
