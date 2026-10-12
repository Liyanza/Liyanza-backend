import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  type RawBodyRequest,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Throttle, SkipThrottle } from '@nestjs/throttler';
import {
  ApiBearerAuth,
  ApiExcludeEndpoint,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Role } from '@prisma/client';
import type { Request } from 'express';
import { Roles } from '../auth/decorators/roles.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { resolveClientIp } from '../../common/http/client-ip.util';
import { BillingService } from './billing.service';
import { ChariowWebhookService } from './chariow-webhook.service';
import {
  CHARIOW_SIGNATURE_HEADER,
  PULSE_DELIVERY_ID_HEADER,
} from './chariow-signature.util';
import { CreateCheckoutDto } from './dto/create-checkout.dto';

interface AuthenticatedRequest extends Request {
  user: AuthenticatedUser;
}

@ApiTags('billing')
@ApiBearerAuth()
@Controller('billing')
export class BillingController {
  constructor(
    private readonly billingService: BillingService,
    private readonly configService: ConfigService,
  ) {}

  @Post('checkout')
  @Roles(Role.ADMIN)
  // Chaque appel crée une session de paiement chez Chariow.
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Start a Chariow checkout for a paid plan' })
  @ApiResponse({ status: 200, description: '{ checkoutUrl } (or step)' })
  @ApiResponse({ status: 502, description: 'Chariow error' })
  @ApiResponse({ status: 503, description: 'Billing not configured' })
  async checkout(
    @Body() dto: CreateCheckoutDto,
    @Req() req: AuthenticatedRequest,
  ) {
    // IP réelle du visiteur (relayée par le site), comme pour le limiteur :
    // Chariow s'en sert pour sa détection de fraude.
    const ip = resolveClientIp(
      req,
      this.configService.get<string>('WEB_PROXY_SECRET'),
    );
    return this.billingService.createCheckout(
      dto,
      req.user,
      ip === 'unknown' ? undefined : ip,
    );
  }

  @Get('subscription')
  @ApiOperation({
    summary: "Get the company's effective plan, limits, usage and history",
  })
  @ApiResponse({ status: 200, description: 'Current subscription' })
  async subscription(@Req() req: AuthenticatedRequest) {
    return this.billingService.getSubscription(req.user);
  }
}

/**
 * Réception des Pulses Chariow. Publique (pas de JWT : l'authenticité est
 * prouvée par la signature HMAC) et hors limiteur — Chariow peut livrer
 * plusieurs événements d'affilée depuis les mêmes IP.
 */
@ApiTags('billing')
@Public()
@SkipThrottle()
@Controller('webhooks')
export class ChariowWebhookController {
  constructor(private readonly webhookService: ChariowWebhookService) {}

  @Post('chariow')
  @HttpCode(HttpStatus.OK)
  @ApiExcludeEndpoint()
  async receive(
    @Req() req: RawBodyRequest<Request>,
    @Headers(CHARIOW_SIGNATURE_HEADER) signature: string | undefined,
    @Headers(PULSE_DELIVERY_ID_HEADER) deliveryId: string | undefined,
  ) {
    return this.webhookService.handle(req.rawBody, signature, deliveryId);
  }
}
