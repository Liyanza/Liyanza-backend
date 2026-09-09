import { Module } from '@nestjs/common';
import { SmtpEmailProvider } from './providers/smtp-email.provider';
import { EMAIL_PROVIDER_TOKEN } from './interfaces/email-provider.interface';

@Module({
  providers: [{ provide: EMAIL_PROVIDER_TOKEN, useClass: SmtpEmailProvider }],
  exports: [EMAIL_PROVIDER_TOKEN],
})
export class MailModule {}
