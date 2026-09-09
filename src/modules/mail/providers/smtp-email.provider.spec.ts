import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import { SmtpEmailProvider } from './smtp-email.provider';

jest.mock('nodemailer');

describe('SmtpEmailProvider', () => {
  const mockSendMail = jest.fn();
  const mockCreateTransport = nodemailer.createTransport as jest.Mock;

  const makeConfigService = (overrides: Record<string, unknown> = {}) => {
    const values: Record<string, unknown> = {
      SMTP_HOST: 'smtp.example.com',
      SMTP_PORT: 587,
      SMTP_USER: 'user',
      SMTP_PASSWORD: 'pass',
      SMTP_FROM: 'notifications@liyanza.local',
      ...overrides,
    };
    return {
      get: jest.fn((key: string) => values[key]),
    } as unknown as ConfigService;
  };

  beforeEach(() => {
    mockCreateTransport.mockReset();
    mockSendMail.mockReset();
    mockCreateTransport.mockReturnValue({ sendMail: mockSendMail });
  });

  it('should configure the transport from SMTP env vars (STARTTLS for non-465 ports)', () => {
    new SmtpEmailProvider(makeConfigService());

    expect(mockCreateTransport).toHaveBeenCalledWith({
      host: 'smtp.example.com',
      port: 587,
      secure: false,
      auth: { user: 'user', pass: 'pass' },
    });
  });

  it('should use implicit TLS (secure=true) for port 465', () => {
    new SmtpEmailProvider(makeConfigService({ SMTP_PORT: 465 }));

    expect(mockCreateTransport).toHaveBeenCalledWith(
      expect.objectContaining({ secure: true }),
    );
  });

  it('should send the message via the transporter, using the configured "from" address', async () => {
    const provider = new SmtpEmailProvider(makeConfigService());

    await provider.send({
      to: 'dest@test.com',
      subject: 'Sujet',
      text: 'Corps du message',
    });

    expect(mockSendMail).toHaveBeenCalledWith({
      from: 'notifications@liyanza.local',
      to: 'dest@test.com',
      subject: 'Sujet',
      text: 'Corps du message',
    });
  });
});
