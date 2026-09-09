import { ConfigService } from '@nestjs/config';
import {
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { S3MediaStorageProvider } from './s3-media-storage.provider';

const mockSend = jest.fn();

jest.mock('@aws-sdk/client-s3', () => {
  const actual =
    jest.requireActual<typeof import('@aws-sdk/client-s3')>(
      '@aws-sdk/client-s3',
    );
  return {
    ...actual,
    S3Client: jest.fn().mockImplementation(() => ({ send: mockSend })),
  };
});

jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn(),
}));

describe('S3MediaStorageProvider', () => {
  let provider: S3MediaStorageProvider;
  const mockGetSignedUrl = getSignedUrl as jest.Mock;

  const makeConfigService = (overrides: Record<string, unknown> = {}) => {
    const values: Record<string, unknown> = {
      S3_BUCKET: 'liyanza-media',
      S3_REGION: 'us-east-1',
      S3_ENDPOINT: 'http://localhost:9000',
      S3_ACCESS_KEY_ID: 'key',
      S3_SECRET_ACCESS_KEY: 'secret',
      S3_FORCE_PATH_STYLE: 'true',
      ...overrides,
    };
    return {
      get: jest.fn((key: string) => values[key]),
    } as unknown as ConfigService;
  };

  beforeEach(() => {
    mockSend.mockReset();
    mockGetSignedUrl.mockReset();
    provider = new S3MediaStorageProvider(makeConfigService());
  });

  describe('getPresignedUploadUrl', () => {
    it('should sign a PutObjectCommand for the given key/contentType', async () => {
      mockGetSignedUrl.mockResolvedValue('https://minio.local/put-url');

      const result = await provider.getPresignedUploadUrl(
        'company-1/abc',
        'image/png',
      );

      expect(mockGetSignedUrl).toHaveBeenCalledWith(
        expect.anything(),
        expect.any(PutObjectCommand),
        { expiresIn: 300 },
      );
      const [, command] = mockGetSignedUrl.mock.calls[0] as [
        unknown,
        PutObjectCommand,
      ];
      expect(command.input).toEqual({
        Bucket: 'liyanza-media',
        Key: 'company-1/abc',
        ContentType: 'image/png',
      });
      expect(result.url).toBe('https://minio.local/put-url');
      expect(result.expiresAt.getTime()).toBeGreaterThan(Date.now());
    });
  });

  describe('getPresignedDownloadUrl', () => {
    it('should sign a GetObjectCommand for the given key', async () => {
      mockGetSignedUrl.mockResolvedValue('https://minio.local/get-url');

      const result = await provider.getPresignedDownloadUrl('company-1/abc');

      const [, command] = mockGetSignedUrl.mock.calls[0] as [
        unknown,
        GetObjectCommand,
      ];
      expect(command).toBeInstanceOf(GetObjectCommand);
      expect(command.input).toEqual({
        Bucket: 'liyanza-media',
        Key: 'company-1/abc',
      });
      expect(result.url).toBe('https://minio.local/get-url');
    });
  });

  describe('headObject', () => {
    it('should return content type and size when the object exists', async () => {
      mockSend.mockResolvedValue({
        ContentType: 'image/png',
        ContentLength: 12345,
      });

      const result = await provider.headObject('company-1/abc');

      expect(mockSend).toHaveBeenCalledWith(expect.any(HeadObjectCommand));
      expect(result).toEqual({ contentType: 'image/png', sizeBytes: 12345 });
    });

    it('should return null when the object does not exist (404)', async () => {
      mockSend.mockRejectedValue(
        new S3ServiceException({
          name: 'NotFound',
          $fault: 'client',
          $metadata: { httpStatusCode: 404 },
        }),
      );

      const result = await provider.headObject('company-1/missing');

      expect(result).toBeNull();
    });

    it('should rethrow any other S3 error (not a 404)', async () => {
      mockSend.mockRejectedValue(
        new S3ServiceException({
          name: 'InternalError',
          $fault: 'server',
          $metadata: { httpStatusCode: 500 },
        }),
      );

      await expect(provider.headObject('company-1/abc')).rejects.toThrow();
    });
  });

  describe('deleteObject', () => {
    it('should send a DeleteObjectCommand for the given key', async () => {
      mockSend.mockResolvedValue({});

      await provider.deleteObject('company-1/abc');

      expect(mockSend).toHaveBeenCalledWith(expect.any(DeleteObjectCommand));
    });
  });
});
