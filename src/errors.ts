import type { Json, OperationError } from "./types.js";

export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
    public readonly details?: Json,
  ) {
    super(message);
    this.name = "AppError";
  }
  toJSON(): OperationError {
    return {
      code: this.code,
      message: this.message,
      ...(this.details === undefined ? {} : { details: this.details }),
    };
  }
}
export function asError(error: unknown): OperationError {
  return error instanceof AppError
    ? error.toJSON()
    : {
        code: "execution_failed",
        message:
          error instanceof Error ? error.message : "Unknown execution failure",
      };
}
