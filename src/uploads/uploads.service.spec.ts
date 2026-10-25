import {
  BadRequestException,
  PayloadTooLargeException,
  ServiceUnavailableException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import { UploadsService } from './uploads.service';

jest.mock('@aws-sdk/s3-presigned-post', () => ({
  createPresignedPost: jest.fn(),
}));

describe('UploadsService', () => {
  let service: UploadsService;
  let send: jest.SpyInstance;
  const configValues: Record<string, string> = {
    AWS_REGION: 'us-east-1',
    UPLOADS_BUCKET: 'private-proof-images',
  };
  const config = {
    get: jest.fn((name: string) => configValues[name]),
  } as unknown as ConfigService;

  const rider: AuthenticatedUser = {
    id: 'rider-1',
    email: 'rider@example.com',
    role: 'DELIVERY',
    actorType: 'delivery',
    jti: 'jti-1',
    expiresAt: 0,
  };

  const png = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00,
  ]);

  beforeEach(() => {
    jest.clearAllMocks();
    Object.assign(configValues, {
      AWS_REGION: 'us-east-1',
      UPLOADS_BUCKET: 'private-proof-images',
    });
    service = new UploadsService(config);
    send = jest.spyOn(S3Client.prototype, 'send').mockResolvedValue({} as never);
    (createPresignedPost as jest.Mock).mockResolvedValue({
      url: 'https://private-proof-images.s3.amazonaws.com',
      fields: { key: 'delivery/rider-1/quarantine/upload-id', Policy: 'signed-policy' },
    });
  });

  afterEach(() => {
    send.mockRestore();
  });

  it('creates a short-lived, size-limited presigned form under the user quarantine prefix', async () => {
    await expect(
      service.createUpload(rider, { contentType: 'image/png', size: png.length }),
    ).resolves.toMatchObject({
      uploadId: expect.any(String),
      url: 'https://private-proof-images.s3.amazonaws.com',
      fields: { Policy: 'signed-policy' },
      maxBytes: 5 * 1024 * 1024,
    });

    expect(createPresignedPost).toHaveBeenCalledWith(
      expect.any(S3Client),
      expect.objectContaining({
        Bucket: 'private-proof-images',
        Key: expect.stringMatching(/^delivery\/rider-1\/quarantine\//),
        Expires: 300,
        Conditions: [
          ['content-length-range', 1, 5 * 1024 * 1024],
          ['eq', '$Content-Type', 'image/png'],
        ],
      }),
    );
  });

  it('rejects unsupported content types and oversized files before signing a URL', async () => {
    await expect(
      service.createUpload(rider, { contentType: 'text/plain', size: 100 }),
    ).rejects.toBeInstanceOf(UnsupportedMediaTypeException);
    await expect(
      service.createUpload(rider, { contentType: 'image/png', size: 5 * 1024 * 1024 + 1 }),
    ).rejects.toBeInstanceOf(PayloadTooLargeException);
    expect(createPresignedPost).not.toHaveBeenCalled();
  });

  it('requires an upload bucket and AWS region', async () => {
    delete configValues.UPLOADS_BUCKET;
    await expect(
      service.createUpload(rider, { contentType: 'image/png', size: png.length }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);

    Object.assign(configValues, { UPLOADS_BUCKET: 'private-proof-images' });
    delete configValues.AWS_REGION;
    await expect(
      service.createUpload(rider, { contentType: 'image/png', size: png.length }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('rejects an invalid upload ID without accessing storage', async () => {
    await expect(service.verifyUpload(rider, 'not-a-uuid')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(send).not.toHaveBeenCalled();
  });

  it('verifies magic bytes, promotes the object and removes the quarantine object', async () => {
    send
      .mockResolvedValueOnce({ ContentLength: png.length, ContentType: 'image/png' })
      .mockResolvedValueOnce({ Body: { transformToByteArray: async () => png } })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});

    const result = await service.verifyUpload(rider, 'c1dd3b98-8921-4f8e-ae3c-fc5477ec8264');

    expect(result).toMatchObject({
      objectKey: expect.stringMatching(/^delivery\/rider-1\/proofs\/.*\.png$/),
      contentType: 'image/png',
      size: png.length,
    });
    expect(send.mock.calls[0][0]).toBeInstanceOf(HeadObjectCommand);
    expect(send.mock.calls[1][0]).toBeInstanceOf(GetObjectCommand);
    expect(send.mock.calls[2][0]).toBeInstanceOf(PutObjectCommand);
    expect(send.mock.calls[2][0].input).toMatchObject({
      Bucket: 'private-proof-images',
      ContentType: 'image/png',
      Body: png,
      ContentLength: png.length,
    });
    expect(send.mock.calls[2][0].input.Key).toMatch(/^delivery\/rider-1\/proofs\//);
    expect(send.mock.calls[3][0]).toBeInstanceOf(DeleteObjectCommand);
    expect(send.mock.calls[3][0].input.Key).toBe(
      'delivery/rider-1/quarantine/c1dd3b98-8921-4f8e-ae3c-fc5477ec8264',
    );
  });

  it('deletes an object larger than 5 MB and returns 413', async () => {
    send
      .mockResolvedValueOnce({ ContentLength: 5 * 1024 * 1024 + 1, ContentType: 'image/png' })
      .mockResolvedValueOnce({});

    await expect(
      service.verifyUpload(rider, 'c1dd3b98-8921-4f8e-ae3c-fc5477ec8264'),
    ).rejects.toBeInstanceOf(PayloadTooLargeException);
    expect(send.mock.calls[1][0]).toBeInstanceOf(DeleteObjectCommand);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('checks the downloaded byte count even when storage metadata reports a smaller size', async () => {
    const oversizedBytes = new Uint8Array(5 * 1024 * 1024 + 1);
    send
      .mockResolvedValueOnce({ ContentLength: png.length, ContentType: 'image/png' })
      .mockResolvedValueOnce({
        Body: { transformToByteArray: async () => oversizedBytes },
      })
      .mockResolvedValueOnce({});

    await expect(
      service.verifyUpload(rider, 'c1dd3b98-8921-4f8e-ae3c-fc5477ec8264'),
    ).rejects.toBeInstanceOf(PayloadTooLargeException);
    expect(send.mock.calls[2][0]).toBeInstanceOf(DeleteObjectCommand);
    expect(send).toHaveBeenCalledTimes(3);
  });

  it('deletes a non-image payload and returns 415', async () => {
    send
      .mockResolvedValueOnce({ ContentLength: 4, ContentType: 'image/png' })
      .mockResolvedValueOnce({
        Body: { transformToByteArray: async () => new Uint8Array([0x4d, 0x5a, 0x00, 0x00]) },
      })
      .mockResolvedValueOnce({});

    await expect(
      service.verifyUpload(rider, 'c1dd3b98-8921-4f8e-ae3c-fc5477ec8264'),
    ).rejects.toBeInstanceOf(UnsupportedMediaTypeException);
    expect(send.mock.calls[2][0]).toBeInstanceOf(DeleteObjectCommand);
  });

  it('rejects image content whose declared content type does not match its signature', async () => {
    send
      .mockResolvedValueOnce({ ContentLength: png.length, ContentType: 'image/jpeg' })
      .mockResolvedValueOnce({ Body: { transformToByteArray: async () => png } })
      .mockResolvedValueOnce({});

    await expect(
      service.verifyUpload(rider, 'c1dd3b98-8921-4f8e-ae3c-fc5477ec8264'),
    ).rejects.toBeInstanceOf(UnsupportedMediaTypeException);
    expect(send.mock.calls[2][0]).toBeInstanceOf(DeleteObjectCommand);
  });

  it('rejects missing objects without hiding unrelated storage errors', async () => {
    const notFound = Object.assign(new Error('not found'), {
      $metadata: { httpStatusCode: 404 },
    });
    send.mockRejectedValueOnce(notFound);

    await expect(
      service.verifyUpload(rider, 'c1dd3b98-8921-4f8e-ae3c-fc5477ec8264'),
    ).rejects.toBeInstanceOf(BadRequestException);

    const storageFailure = new Error('storage unavailable');
    send.mockRejectedValueOnce(storageFailure);
    await expect(service.verifyUpload(rider, 'c1dd3b98-8921-4f8e-ae3c-fc5477ec8264')).rejects.toBe(
      storageFailure,
    );
  });
});
