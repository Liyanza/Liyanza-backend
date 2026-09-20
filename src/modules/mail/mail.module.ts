import { Module } from '@nestjs/common';
import { HttpModule, HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { SmtpEmailProvider } from './providers/smtp-email.provider';
import { BrevoApiEmailProvider } from './providers/brevo-api-email.provider';
import { EMAIL_PROVIDER_TOKEN } from './interfaces/email-provider.interface';

@Module({
  imports: [HttpModule.register({ timeout: 10_000 })],
  providers: [
    {
      provide: EMAIL_PROVIDER_TOKEN,
      useFactory: (configService: ConfigService, http: HttpService) =>
        configService.get<string>('EMAIL_PROVIDER') === 'brevo_api'
          ? new BrevoApiEmailProvider(http, configService)
          : new SmtpEmailProvider(configService),
      inject: [ConfigService, HttpService],
    },
  ],
  exports: [EMAIL_PROVIDER_TOKEN],
})
export class MailModule {}
