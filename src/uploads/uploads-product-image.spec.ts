import {
  BadRequestException,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { UploadsService } from './uploads.service';

jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn().mockResolvedValue('https://signed.example.com/put'),
}));

describe('UploadsService product images', () => {
  const base = 'https://media.s3.us-east-1.amazonaws.com';
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
  let values: Record<string, string>;
  let send: jest.SpyInstance;
  let service: UploadsService;

  const objectWith = (bytes: Uint8Array) => ({
    Body: { transformToByteArray: async () => bytes },
  });

  beforeEach(() => {
    jest.clearAllMocks();
    values = { AWS_REGION: 'us-east-1', UPLOADS_BUCKET: 'media' };
    service = new UploadsService({
      get: jest.fn((name: string) => values[name]),
    } as unknown as ConfigService);
    send = jest.spyOn(S3Client.prototype, 'send').mockResolvedValue(objectWith(png) as never);
  });

  afterEach(() => send.mockRestore());

  it('signs a short-lived PUT under the product prefix', async () => {
    const out = await service.presignProductImage('product-1', 'image/png', 1024);

    expect(out.uploadUrl).toBe('https://signed.example.com/put');
    expect(out.key).toMatch(/^products\/product-1\/[0-9a-f-]+\.png$/);
    expect(out.fileUrl).toBe(`${base}/${out.key}`);
    expect((getSignedUrl as jest.Mock).mock.calls[0][2]).toEqual({ expiresIn: 300 });
  });

  it('uses the configured public base URL', async () => {
    values.UPLOADS_PUBLIC_BASE_URL = 'https://cdn.example.com/';

    const out = await service.presignProductImage('product-1', 'image/webp', 1024);

    expect(out.fileUrl).toBe(`https://cdn.example.com/${out.key}`);
  });

  it('refuses other file types and files over 5 MB before signing', async () => {
    await expect(service.presignProductImage('product-1', 'text/plain', 10)).rejects.toBeInstanceOf(
      UnsupportedMediaTypeException,
    );
    await expect(
      service.presignProductImage('product-1', 'image/png', 5 * 1024 * 1024 + 1),
    ).rejects.toBeInstanceOf(PayloadTooLargeException);
    expect(getSignedUrl).not.toHaveBeenCalled();
  });

  it('accepts a real image in the bucket', async () => {
    await expect(service.verifyProductImage(`${base}/products/p/a.png`)).resolves.toEqual({
      key: 'products/p/a.png',
    });
  });

  it('refuses a URL outside the bucket without reading it', async () => {
    await expect(
      service.verifyProductImage('https://evil.example.com/products/a.png'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(send).not.toHaveBeenCalled();
  });

  it('reports a missing object', async () => {
    send.mockRejectedValue(new Error('NoSuchKey'));
    await expect(service.verifyProductImage(`${base}/products/p/a.png`)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('deletes a file that is not an image', async () => {
    send.mockResolvedValueOnce(objectWith(new Uint8Array([1, 2, 3, 4])) as never);

    await expect(service.verifyProductImage(`${base}/products/p/a.png`)).rejects.toBeInstanceOf(
      UnsupportedMediaTypeException,
    );
    expect(send.mock.calls[1][0]).toBeInstanceOf(DeleteObjectCommand);
  });

  it('deletes an empty file', async () => {
    send.mockResolvedValueOnce(objectWith(new Uint8Array()) as never);

    await expect(service.verifyProductImage(`${base}/products/p/a.png`)).rejects.toBeInstanceOf(
      PayloadTooLargeException,
    );
    expect(send.mock.calls[1][0]).toBeInstanceOf(DeleteObjectCommand);
  });
});
