import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  INestApplication,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { captureServerError } from "./telemetry";

export class ApiError extends HttpException {
  constructor(status: number, code: string, message: string) {
    super({ code, message }, status);
  }
}

@Catch()
class ApiExceptionFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<Response>();
    const status = error instanceof HttpException ? error.getStatus() : 500;
    const detail = error instanceof HttpException ? error.getResponse() : null;
    const body =
      typeof detail === "object" && detail !== null
        ? (detail as Record<string, unknown>)
        : {};
    response.status(status).json({
      error: {
        code:
          typeof body.code === "string"
            ? body.code
            : status === 500
              ? "INTERNAL_ERROR"
              : `HTTP_${status}`,
        message:
          status >= 500
            ? "Não foi possível concluir a operação."
            : (body.message ?? "Requisição inválida."),
      },
      requestId: response.getHeader("X-Request-ID"),
    });
    if (status >= 500) {
      captureServerError(error, String(response.getHeader("X-Request-ID")));
      console.error(error);
    }
  }
}

export function configureHttp(app: INestApplication) {
  app.use((request: Request, response: Response, next: NextFunction) => {
    const supplied = request.header("X-Request-ID");
    const id =
      supplied && /^[a-zA-Z0-9._-]{1,128}$/.test(supplied)
        ? supplied
        : randomUUID();
    response.setHeader("X-Request-ID", id);
    next();
  });
  app.enableCors({
    origin: process.env.CORS_ORIGIN ?? "http://localhost:3000",
    allowedHeaders: [
      "Content-Type",
      "X-Request-ID",
      "Idempotency-Key",
      "X-Client-Release",
    ],
    exposedHeaders: ["X-Request-ID"],
  });
  app.useGlobalFilters(new ApiExceptionFilter());
  app.enableShutdownHooks();
}
