const BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:5011/api/v1";

const TOKEN_KEY = "securepoll.admin.token";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }

  /** Field-level messages from a failed validation, keyed by field name. */
  get fieldErrors(): Record<string, string[]> {
    const details = this.details as { fieldErrors?: Record<string, string[]> } | undefined;
    return details?.fieldErrors ?? {};
  }
}

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string | null): void {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
  auth?: boolean;
  signal?: AbortSignal;
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = "GET", body, auth = false, signal } = options;

  const headers: Record<string, string> = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (auth) {
    const token = getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
  }

  let response: Response;
  try {
    response = await fetch(`${BASE_URL}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new ApiError(0, "NETWORK_ERROR", "Could not reach the server");
  }

  const payload: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const error = (payload as { error?: { code: string; message: string; details?: unknown } })
      ?.error;
    throw new ApiError(
      response.status,
      error?.code ?? "UNKNOWN",
      error?.message ?? `Request failed with status ${response.status}`,
      error?.details,
    );
  }

  return (payload as { data: T }).data;
}

/**
 * Fetches a response body verbatim, without the `{ data }` envelope.
 *
 * Used for the election manifest: the digest recorded against each anonymity group is computed
 * over exactly these bytes, so re-serializing them through JSON.parse/stringify would produce a
 * file that no longer matches its own digest.
 */
export async function requestText(
  path: string,
  options: { auth?: boolean; signal?: AbortSignal } = {},
): Promise<{ body: string; filename: string | null }> {
  const headers: Record<string, string> = {};
  if (options.auth) {
    const token = getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
  }

  let response: Response;
  try {
    response = await fetch(`${BASE_URL}${path}`, { headers, signal: options.signal });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new ApiError(0, "NETWORK_ERROR", "Could not reach the server");
  }

  const body = await response.text();

  if (!response.ok) {
    let code = "UNKNOWN";
    let message = `Request failed with status ${response.status}`;
    try {
      const parsed = JSON.parse(body) as { error?: { code: string; message: string } };
      if (parsed.error) {
        code = parsed.error.code;
        message = parsed.error.message;
      }
    } catch {
      /* not a JSON error envelope; keep the status-based message */
    }
    throw new ApiError(response.status, code, message);
  }

  const disposition = response.headers.get("Content-Disposition");
  const match = disposition?.match(/filename="([^"]+)"/);
  return { body, filename: match?.[1] ?? null };
}
