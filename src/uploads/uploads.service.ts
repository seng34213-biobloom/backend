import {
  BadRequestException,
  Injectable,
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
import { randomUUID } from 'node:crypto';
import type { AuthenticatedUser } from '../auth/types/auth.types';

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

interface ImageSignature {
  contentType: string;
  extension: string;
  matches(bytes: Uint8Array): boolean;
}

const IMAGE_SIGNATURES: ImageSignature[] = [
  {
    contentType: 'image/jpeg',
    extension: 'jpg',
    matches: (bytes) => bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff,
  },
  {
    contentType: 'image/png',
    extension: 'png',
    matches: (bytes) =>
      bytes[0] === 0x89 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x4e &&
      bytes[3] === 0x47 &&
      bytes[4] === 0x0d &&
      bytes[5] === 0x0a &&
      bytes[6] === 0x1a &&
      bytes[7] === 0x0a,
  },
  {
    contentType: 'image/webp',
    extension: 'webp',
    matches: (bytes) =>
      bytes[0] === 0x52 &&
      bytes[1] === 0x49 &&
      bytes[2] === 0x46 &&
      bytes[3] === 0x46 &&
      bytes[8] === 0x57 &&
      bytes[9] === 0x45 &&
      bytes[10] === 0x42 &&
      bytes[11] === 0x50,
  },
];

@Injectable()
export class UploadsService {
  private client?: S3Client;

  constructor(private readonly config: ConfigService) {}

  async createUpload(user: AuthenticatedUser, input: { contentType: string; size: number }) {
    if (!ALLOWED_TYPES.has(input.contentType)) {
      throw new UnsupportedMediaTypeException('Only JPEG, PNG, and WebP images are accepted');
    }
    if (input.size > MAX_UPLOAD_BYTES) {
      throw new PayloadTooLargeException('Proof images must be 5 MB or smaller');
    }

    const bucket = this.bucket();
    const uploadId = randomUUID();
    const key = this.quarantineKey(user, uploadId);
    const post = await createPresignedPost(this.getClient(), {
      Bucket: bucket,
      Key: key,
      Expires: 300,
      Fields: { 'Content-Type': input.contentType },
      Conditions: [
        ['content-length-range', 1, MAX_UPLOAD_BYTES],
        ['eq', '$Content-Type', input.contentType],
      ],
    });
    return { uploadId, url: post.url, fields: post.fields, maxBytes: MAX_UPLOAD_BYTES };
  }

  async verifyUpload(user: AuthenticatedUser, uploadId: string) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(uploadId)) {
      throw new BadRequestException('Invalid upload ID');
    }

    const bucket = this.bucket();
    const client = this.getClient();
    const quarantineKey = this.quarantineKey(user, uploadId);
    let metadata;
    try {
      metadata = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: quarantineKey }));
    } catch (error) {
      if (
        error instanceof Error &&
        '$metadata' in error &&
        (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404
      ) {
        throw new BadRequestException('Uploaded object was not found');
      }
      throw error;
    }

    if (!metadata.ContentLength || metadata.ContentLength < 1) {
      await this.deleteObject(bucket, quarantineKey);
      throw new BadRequestException('Uploaded image is empty');
    }
    if (metadata.ContentLength > MAX_UPLOAD_BYTES) {
      await this.deleteObject(bucket, quarantineKey);
      throw new PayloadTooLargeException('Proof images must be 5 MB or smaller');
    }

    const object = await client.send(new GetObjectCommand({ Bucket: bucket, Key: quarantineKey }));
    if (!object.Body) {
      await this.deleteObject(bucket, quarantineKey);
      throw new BadRequestException('Uploaded image could not be read');
    }
    const bytes = await object.Body.transformToByteArray();
    if (bytes.byteLength > MAX_UPLOAD_BYTES) {
      await this.deleteObject(bucket, quarantineKey);
      throw new PayloadTooLargeException('Proof images must be 5 MB or smaller');
    }
    const signature = IMAGE_SIGNATURES.find((candidate) => candidate.matches(bytes));
    if (!signature || signature.contentType !== metadata.ContentType) {
      await this.deleteObject(bucket, quarantineKey);
      throw new UnsupportedMediaTypeException('Uploaded file content is not a supported image');
    }

    const verifiedKey = `${user.role.toLowerCase()}/${user.id}/proofs/${randomUUID()}.${signature.extension}`;
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: verifiedKey,
        Body: bytes,
        ContentLength: bytes.byteLength,
        ContentType: signature.contentType,
      }),
    );
    await this.deleteObject(bucket, quarantineKey);
    return {
      objectKey: verifiedKey,
      contentType: signature.contentType,
      size: metadata.ContentLength,
    };
  }

  private quarantineKey(user: AuthenticatedUser, uploadId: string): string {
    return `${user.role.toLowerCase()}/${user.id}/quarantine/${uploadId}`;
  }

  private async deleteObject(bucket: string, key: string): Promise<void> {
    await this.getClient().send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  }

  private bucket(): string {
    const bucket = this.config.get<string>('UPLOADS_BUCKET');
    if (!bucket) throw new ServiceUnavailableException('UPLOADS_BUCKET is not configured');
    return bucket;
  }

  private getClient(): S3Client {
    if (!this.client) {
      const region = this.config.get<string>('AWS_REGION');
      if (!region) throw new ServiceUnavailableException('AWS_REGION is not configured');
      this.client = new S3Client({ region });
    }
    return this.client;
  }
}
