import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Request, Response } from 'express';
import { LoggerService } from '../../modules/logger/logger.service';
import { RequestContextService } from '../context/request-context.service';

/**
 * Traduction des codes d'erreur Prisma en réponses HTTP propres.
 * @see https://www.prisma.io/docs/orm/reference/error-reference
 */
const PRISMA_ERROR_MAP: Record<string, { status: number; message: string }> = {
  P2000: {
    status: HttpStatus.BAD_REQUEST,
    message: 'The provided value is too long for one of the fields.',
  },
  P2002: {
    status: HttpStatus.CONFLICT,
    message: 'A record with these values already exists.',
  },
  P2003: {
    status: HttpStatus.BAD_REQUEST,
    message: 'The operation references a record that does not exist.',
  },
  P2011: {
    status: HttpStatus.BAD_REQUEST,
    message: 'A required field is missing.',
  },
  P2025: { status: HttpStatus.NOT_FOUND, message: 'Record not found.' },
};

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(
    private readonly logger: LoggerService,
    private readonly contextService: RequestContextService,
  ) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const requestId = this.contextService.getRequestId() || 'unknown';

    const { status, message } = this.resolve(exception, requestId);

    // Si les en-têtes sont déjà partis (endpoint utilisant `@Res()`, flux,
    // téléchargement interrompu...), écrire à nouveau lèverait
    // `ERR_HTTP_HEADERS_SENT` et masquerait l'erreur d'origine.
    if (response.headersSent) {
      return;
    }

    response.status(status).json({
      statusCode: status,
      message,
      path: request.url,
      timestamp: new Date().toISOString(),
      requestId,
    });
  }

  /**
   * Détermine le couple (status, message) exposé au client.
   *
   * CORRECTIF AUDIT (faille critique — divulgation d'information) : toute
   * `Error` non-`HttpException` voyait auparavant son `message` brut renvoyé
   * au client. Concrètement, la moindre erreur Prisma (violation de contrainte
   * unique, colonne trop courte, clé étrangère invalide, décimal hors borne)
   * exposait publiquement les noms de tables, de colonnes et de contraintes —
   * une cartographie complète du schéma offerte à l'attaquant. Les erreurs
   * internes renvoient désormais un message générique ; le détail n'existe
   * plus que dans les logs serveur, corrélé par `requestId`.
   */
  private resolve(
    exception: unknown,
    requestId: string,
  ): { status: number; message: string | string[] } {
    // 1. Exceptions HTTP applicatives : message métier, sûr par construction.
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();

      let message: string | string[] = exception.message;
      if (typeof body === 'string') {
        message = body;
      } else if (body && typeof body === 'object' && 'message' in body) {
        const raw = (body as { message?: unknown }).message;
        if (typeof raw === 'string' || Array.isArray(raw)) {
          message = raw as string | string[];
        }
      }

      // Les 5xx applicatifs restent des incidents : on les journalise.
      // `getStatus()` renvoie un `number` : on compare à une constante
      // numérique plutôt qu'au membre d'enum `HttpStatus` (comparaison de
      // types hétérogènes rejetée par `no-unsafe-enum-comparison`).
      if (status >= 500) {
        this.logger.error(
          `HTTP ${status} [${requestId}]: ${exception.message}`,
          exception.stack,
          'AllExceptionsFilter',
        );
      }
      return { status, message };
    }

    // 2. Erreurs Prisma connues : traduites, jamais relayées telles quelles.
    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      const mapped = PRISMA_ERROR_MAP[exception.code];
      this.logger.error(
        `Prisma ${exception.code} [${requestId}]: ${exception.message}`,
        exception.stack,
        'AllExceptionsFilter',
      );
      if (mapped) {
        return { status: mapped.status, message: mapped.message };
      }
      return {
        status: HttpStatus.INTERNAL_SERVER_ERROR,
        message: 'Internal server error',
      };
    }

    // 3. Payload Prisma invalide (type/format) : côté client, mais le détail
    //    décrit le schéma — on ne le renvoie pas.
    if (
      exception instanceof Prisma.PrismaClientValidationError ||
      exception instanceof Prisma.PrismaClientUnknownRequestError ||
      exception instanceof Prisma.PrismaClientInitializationError
    ) {
      this.logger.error(
        `Prisma error [${requestId}]: ${exception.message}`,
        exception.stack,
        'AllExceptionsFilter',
      );
      return {
        status: HttpStatus.INTERNAL_SERVER_ERROR,
        message: 'Internal server error',
      };
    }

    // 4. Tout le reste : message générique, détail dans les logs uniquement.
    if (exception instanceof Error) {
      this.logger.error(
        `Unhandled exception [${requestId}]: ${exception.message}`,
        exception.stack,
        'AllExceptionsFilter',
      );
    } else {
      this.logger.error(
        `Unknown exception [${requestId}]: ${String(exception)}`,
        undefined,
        'AllExceptionsFilter',
      );
    }

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      message: 'Internal server error',
    };
  }
}
