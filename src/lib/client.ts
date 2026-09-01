'use client';

/** Thin fetch wrappers. Every call hits our own API — the browser never sees BigQuery. */

export class ApiError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'ApiError';
  }
}

async function handle<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => ({ error: 'Unreadable response from the server.' }));
  if (!response.ok) {
    throw new ApiError(payload.error ?? `Request failed (${response.status})`, payload.code ?? 'Error');
  }
  return payload as T;
}

export async function apiGet<T>(path: string, params: Record<string, string> = {}): Promise<T> {
  const query = new URLSearchParams(params).toString();
  const response = await fetch(`${path}${query ? `?${query}` : ''}`, { cache: 'no-store' });
  return handle<T>(response);
}

export async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    cache: 'no-store',
  });
  return handle<T>(response);
}
