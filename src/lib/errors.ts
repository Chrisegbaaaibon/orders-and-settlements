import { NextResponse } from "next/server";
import { ZodError } from "zod";

/**
 * One error shape for the whole API:
 *
 *   { "error": { "code", "message", "hint"?, "details"?, "meta"? } }
 *
 * `code` is stable and machine-readable, `message` is safe to show a user,
 * `hint` tells them how to resolve it, and `meta` carries the numbers a client
 * needs to recover (e.g. the maximum payment it is allowed to retry with).
 */

export type ApiErrorCode =
  | "validation_error"
  | "unauthenticated"
  | "forbidden"
  | "not_found"
  | "over_payment"
  | "order_locked"
  | "conflict"
  | "internal_error";

const STATUS_BY_CODE: Record<ApiErrorCode, number> = {
  validation_error: 400,
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  order_locked: 409,
  over_payment: 422,
  internal_error: 500,
};

export interface ApiErrorBody {
  error: {
    code: ApiErrorCode;
    message: string;
    hint?: string;
    details?: { path: string; message: string }[];
    meta?: Record<string, unknown>;
  };
}

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly hint?: string;
  readonly details?: { path: string; message: string }[];
  readonly meta?: Record<string, unknown>;

  constructor(
    code: ApiErrorCode,
    message: string,
    options: {
      hint?: string;
      details?: { path: string; message: string }[];
      meta?: Record<string, unknown>;
    } = {},
  ) {
    super(message);
    this.code = code;
    this.hint = options.hint;
    this.details = options.details;
    this.meta = options.meta;
  }

  get status(): number {
    return STATUS_BY_CODE[this.code];
  }

  toResponse(): NextResponse<ApiErrorBody> {
    return NextResponse.json(
      {
        error: {
          code: this.code,
          message: this.message,
          ...(this.hint ? { hint: this.hint } : {}),
          ...(this.details ? { details: this.details } : {}),
          ...(this.meta ? { meta: this.meta } : {}),
        },
      },
      { status: this.status },
    );
  }
}

export function validationErrorFromZod(error: ZodError): ApiError {
  return new ApiError("validation_error", "The request body failed validation.", {
    hint: "Correct the fields listed in details and retry.",
    details: error.issues.map((issue) => ({
      path: issue.path.join(".") || "(root)",
      message: issue.message,
    })),
  });
}

/**
 * Wraps a route handler so thrown ApiErrors become well-formed responses and
 * anything unexpected becomes a 500 without leaking internals to the client.
 */
export function withErrorHandling<Args extends unknown[], R extends Response>(
  handler: (...args: Args) => Promise<R>,
) {
  return async (...args: Args): Promise<R | NextResponse<ApiErrorBody>> => {
    try {
      return await handler(...args);
    } catch (error) {
      if (error instanceof ApiError) return error.toResponse();
      if (error instanceof ZodError) return validationErrorFromZod(error).toResponse();

      console.error("Unhandled API error:", error);
      return new ApiError("internal_error", "Something went wrong on our end.", {
        hint: "Retry in a moment. If it persists, contact support.",
      }).toResponse();
    }
  };
}
