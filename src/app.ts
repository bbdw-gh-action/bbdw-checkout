import "reflect-metadata";
import {
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Module,
  Post,
  Res,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { Response } from "express";
import { configureHttp } from "./http";
import { Dependencies, OrdersService } from "./orders";
import { TelemetryShutdown } from "./telemetry";

@Controller()
class OrdersController {
  constructor(@Inject(OrdersService) private readonly orders: OrdersService) {}
  @Get("health")
  health() {
    return { status: "ok" };
  }
  @Post("orders")
  create(
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
    @Headers("idempotency-key") key?: string,
    @Headers("x-client-release") clientRelease?: string,
  ) {
    return this.orders.create(
      body,
      String(response.getHeader("X-Request-ID")),
      key,
      clientRelease,
    );
  }
}

@Module({
  controllers: [OrdersController],
  providers: [Dependencies, OrdersService, TelemetryShutdown],
})
class AppModule {}

export async function createApp() {
  const app = await NestFactory.create(AppModule, { logger: false });
  configureHttp(app);
  return app;
}
