import { Injectable, ConsoleLogger } from '@nestjs/common';
import { RequestContextService } from '../../common/context/request-context.service';

@Injectable()
export class LoggerService extends ConsoleLogger {
  constructor(private readonly contextService: RequestContextService) {
    super();
  }

  private getRequestId(): string | undefined {
    return this.contextService.getRequestId();
  }

  private formatLog(
    level: string,
    message: any,
    context?: string,
    stack?: string,
  ): string {
    const logEntry: Record<string, any> = {
      level,
      timestamp: new Date().toISOString(),
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      message,
      context,
      requestId: this.getRequestId(),
    };
    if (stack) {
      logEntry.stack = stack;
    }
    return JSON.stringify(logEntry);
  }

  log(message: any, context?: string): void {
    super.log(this.formatLog('log', message, context));
  }

  error(message: any, stack?: string, context?: string): void {
    super.error(this.formatLog('error', message, context, stack), stack);
  }

  warn(message: any, context?: string): void {
    super.warn(this.formatLog('warn', message, context));
  }

  debug(message: any, context?: string): void {
    super.debug(this.formatLog('debug', message, context));
  }

  verbose(message: any, context?: string): void {
    super.verbose(this.formatLog('verbose', message, context));
  }
}
