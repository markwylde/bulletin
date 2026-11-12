import { CSRF_STORAGE_KEY } from "@bulletin/domain/auth/browser";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly body: unknown;

  constructor(status: number, code: string | null, body: unknown = null) {
    super(`Request failed with status ${status}`);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

function csrfToken(): string | null {
  return sessionStorage.getItem(CSRF_STORAGE_KEY);
}

async function responseError(response: Response): Promise<ApiError> {
  const body: unknown = await response.json().catch(() => null);
  const code =
    typeof body === "object" && body !== null && "code" in body
      ? String((body as Record<string, unknown>).code)
      : null;

  return new ApiError(response.status, code, body);
}

export async function apiGet<T>(path: string): Promise<T> {
  const response = await fetch(path, {
    credentials: "include",
    headers: { accept: "application/json" },
  });

  if (!response.ok) {
    throw await responseError(response);
  }

  return (await response.json()) as T;
}

export async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const headers = new Headers({
    accept: "application/json",
    "content-type": "application/json",
  });
  const token = csrfToken();

  if (token !== null) {
    headers.set("x-bulletin-csrf", token);
  }

  const response = await fetch(path, {
    method: "POST",
    credentials: "include",
    headers,
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw await responseError(response);
  }

  return (await response.json()) as T;
}

export async function apiDelete<T>(path: string, body?: unknown): Promise<T> {
  const headers = new Headers({ accept: "application/json" });
  const token = csrfToken();

  if (token !== null) {
    headers.set("x-bulletin-csrf", token);
  }

  if (body !== undefined) {
    headers.set("content-type", "application/json");
  }

  const response = await fetch(path, {
    method: "DELETE",
    credentials: "include",
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  if (!response.ok) {
    throw await responseError(response);
  }

  return (await response.json()) as T;
}
