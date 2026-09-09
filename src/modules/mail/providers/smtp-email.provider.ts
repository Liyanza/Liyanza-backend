import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import {
  EmailMessage,
  EmailProvider,
} from '../interfaces/email-provider.interface';

@Injectable()
export class SmtpEmailProvider implements EmailProvider {
  private readonly transporter: Transporter;
  private readonly fromAddress: string;

  constructor(configService: ConfigService) {
    const port = configService.get<number>('SMTP_PORT')!;
    this.fromAddress = configService.get<string>('SMTP_FROM')!;

    this.transporter = nodemailer.createTransport({
      host: configService.get<string>('SMTP_HOST'),
      port,
      // Convention standard : le port 465 utilise TLS implicite (SMTPS),
      // tous les autres ports (587, 25, 1025 pour Mailhog en local...)
      // utilisent STARTTLS négocié après connexion ou pas de chiffrement.
      secure: port === 465,
      auth: {
        user: configService.get<string>('SMTP_USER'),
        pass: configService.get<string>('SMTP_PASSWORD'),
      },
    });
  }

  async send(message: EmailMessage): Promise<void> {
    await this.transporter.sendMail({
      from: this.fromAddress,
      to: message.to,
      subject: message.subject,
      text: message.text,
    });
  }
}
