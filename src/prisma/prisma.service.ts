import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

// Единственная точка доступа к БД. Состояние — только в Postgres
// (п.2 CLAUDE.md), поэтому и bot, и worker используют этот сервис,
// а не сессии grammY и не память процесса.
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
