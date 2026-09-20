import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { AxiosError, AxiosHeaders } from 'axios';
import { of, throwError } from 'rxjs';
import { BrevoApiEmailProvider } from './brevo-api-email.provider';

describe('BrevoApiEmailProvider', () => {
  const post = jest.fn();
  const http = { post } as unknown as HttpService;

  const values: Record<string, unknown> = {
    BREVO_API_KEY: 'xkeysib-test-key',
    SMTP_FROM: 'notifications@kiyanza.com',
  };
  const configService = {
    getOrThrow: jest.fn((key: string) => {
      const value = values[key];
      if (value === undefined) throw new Error(`Missing ${key}`);
      return value;
    }),
  } as unknown as ConfigService;

  beforeEach(() => {
    post.mockReset();
  });

  it('should POST to the Brevo transactional API with the configured sender and the api-key header', async () => {
    post.mockReturnValue(of({ data: { messageId: 'abc' } }));
    const provider = new BrevoApiEmailProvider(http, configService);

    await provider.send({
      to: 'dest@test.com',
      subject: 'Sujet',
      text: 'Corps du message',
    });

    expect(post).toHaveBeenCalledWith(
      'https://api.brevo.com/v3/smtp/email',
      {
        sender: { email: 'notifications@kiyanza.com' },
        to: [{ email: 'dest@test.com' }],
        subject: 'Sujet',
        textContent: 'Corps du message',
      },
      {
        headers: expect.objectContaining({
          'api-key': 'xkeysib-test-key',
        }) as Record<string, string>,
      },
    );
  });

  it('should surface the Brevo error message on failure', async () => {
    const axiosError = new AxiosError(
      'Request failed with status code 401',
      '401',
      { headers: new AxiosHeaders() },
      {},
      {
        status: 401,
        statusText: 'Unauthorized',
        headers: {},
        config: { headers: new AxiosHeaders() },
        data: { message: 'Key not found', code: 'unauthorized' },
      },
    );
    post.mockReturnValue(throwError(() => axiosError));
    const provider = new BrevoApiEmailProvider(http, configService);

    await expect(
      provider.send({ to: 'dest@test.com', subject: 'Sujet', text: 'Corps' }),
    ).rejects.toThrow('Brevo API error: Key not found');
  });
});
