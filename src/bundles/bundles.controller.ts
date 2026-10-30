import { Controller, Get, Param, Query } from '@nestjs/common';
import { Public } from '../auth/decorators/public.decorator';
import { BundlesService } from './bundles.service';
import { ListBundlesQueryDto } from './dto/bundle.dto';

/** Public gift-box catalogue (SDS §6.1 "Gift Boxes"). */
@Controller('bundles')
export class BundlesController {
  constructor(private readonly bundles: BundlesService) {}

  @Public()
  @Get()
  list(@Query() query: ListBundlesQueryDto) {
    return this.bundles.listPublic(query);
  }

  @Public()
  @Get(':slug')
  detail(@Param('slug') slug: string) {
    return this.bundles.getPublic(slug);
  }
}
