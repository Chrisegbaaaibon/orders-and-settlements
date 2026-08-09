import type { ApiErrorBody } from "./errors";
import type { OrderDetailJson, OrderSummaryJson } from "./serialize";
import type { OrderStatus } from "./status";

/**
 * Thin browser-side wrapper around the REST API.
 *
 * Its one job beyond `fetch` is turning the API's error envelope back into a
 * throwable that carries `hint` and `meta`, so the UI can show the resolution
 * step ("Record $600.00 or less") instead of a generic failure toast.
 */

export class ApiClientError extends Error {
  readonly code: string;
  readonly status: number;
  readonly hint?: string;
  readonly details?: { path: string; message: string }[];
  readonly meta?: Record<string, unknown>;

  constructor(status: number, body: ApiErrorBody["error"]) {
    super(body.message);
    this.status = status;
    this.code = body.code;
    this.hint = body.hint;
    this.details = body.details;
    this.meta = body.meta;
  }

  /** Message plus resolution hint, ready to render in one line. */
  get fullMessage(): string {
    return this.hint ? `${this.message} ${this.hint}` : this.message;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as ApiErrorBody | null;
    throw new ApiClientError(
      response.status,
      body?.error ?? { code: "internal_error", message: "Request failed." },
    );
  }

  return response.json() as Promise<T>;
}

export interface LineItemInput {
  description: string;
  quantity: string;
  unitPrice: string;
}

export const api = {
  signup: (email: string, password: string) =>
    request<{ user: { id: string; email: string } }>("/api/auth/signup", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),

  login: (email: string, password: string) =>
    request<{ user: { id: string; email: string } }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),

  logout: () => request<{ ok: true }>("/api/auth/logout", { method: "POST" }),

  me: () => request<{ user: { id: string; email: string } | null }>("/api/auth/me"),

  listOrders: (params: { status?: OrderStatus | "all"; search?: string } = {}) => {
    const query = new URLSearchParams();
    if (params.status && params.status !== "all") query.set("status", params.status);
    if (params.search) query.set("search", params.search);
    query.set("pageSize", "100");
    return request<{
      orders: OrderSummaryJson[];
      pagination: { page: number; pageSize: number; total: number; totalPages: number };
    }>(`/api/orders?${query}`);
  },

  getOrder: (id: string) => request<{ order: OrderDetailJson }>(`/api/orders/${id}`),

  createOrder: (input: { customer: string; dueDate: string; lineItems: LineItemInput[] }) =>
    request<{ order: OrderDetailJson }>("/api/orders", {
      method: "POST",
      body: JSON.stringify(input),
    }),

  updateOrder: (
    id: string,
    input: Partial<{ customer: string; dueDate: string; lineItems: LineItemInput[] }>,
  ) =>
    request<{ order: OrderDetailJson }>(`/api/orders/${id}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),

  deleteOrder: (id: string) =>
    request<{ ok: true; id: string }>(`/api/orders/${id}`, { method: "DELETE" }),

  recordPayment: (orderId: string, input: { amount: string; date?: string; note?: string }) =>
    request<{ order: OrderDetailJson }>(`/api/orders/${orderId}/payments`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
};
