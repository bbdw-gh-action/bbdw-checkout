import * as Sentry from "@sentry/node";
import { Injectable, type OnApplicationShutdown } from "@nestjs/common";

// Captura explícita no filtro HTTP: sem uma segunda captura automática do Nest.
export function initTelemetry() {
  Sentry.init({
    dsn: process.env.SENTRY_DSN || undefined,
    enabled: Boolean(process.env.SENTRY_DSN),
    environment: process.env.SENTRY_ENVIRONMENT || "local",
    release: process.env.SENTRY_RELEASE || undefined,
    defaultIntegrations: false,
    sampleRate: 1,
    beforeSend(event) {
      // O evento público só leva metadados técnicos e stack; nunca o pedido.
      delete event.request;
      delete event.user;
      delete event.breadcrumbs;
      delete event.extra;
      event.server_name = "bbdw-checkout";
      for (const exception of event.exception?.values ?? []) {
        for (const frame of exception.stacktrace?.frames ?? []) {
          const filename = frame.filename?.replaceAll("\\", "/");
          const marker = "/dist/src/";
          if (filename?.includes(marker)) {
            frame.filename = `app:///src/${filename.split(marker).at(-1)}`;
            frame.abs_path = frame.filename;
            frame.in_app = true;
          }
        }
      }
      return event;
    },
  });
}

export function captureServerError(
  error: unknown,
  requestId: string,
  tags: Record<string, string> = {},
) {
  if (!Sentry.isEnabled()) return;
  Sentry.withScope((scope) => {
    scope.setTag("service", "bbdw-checkout");
    scope.setTag("scenario", process.env.DEMO_SCENARIO || "none");
    scope.setTag("request_id", requestId);
    scope.setTag("demo_run", process.env.DEMO_RUN_ID || "local");
    scope.setTags(tags);
    Sentry.captureException(error);
  });
}

@Injectable()
export class TelemetryShutdown implements OnApplicationShutdown {
  async onApplicationShutdown() {
    await Sentry.flush(2000);
  }
}
