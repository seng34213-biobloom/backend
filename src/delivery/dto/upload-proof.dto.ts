import { IsUrl, MaxLength } from 'class-validator';

export class UploadDeliveryProofDto {
  @IsUrl({ protocols: ['http', 'https'], require_protocol: true })
  @MaxLength(2048)
  proofPhotoUrl!: string;
}
