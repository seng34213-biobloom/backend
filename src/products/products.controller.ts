import { Controller, Get, Param, Query } from '@nestjs/common';
import { ListProductsQueryDto } from './dto/list-products-query.dto';
import { ProductsService } from './products.service';

@Controller('products')
export class ProductsController {
  constructor(private readonly products: ProductsService) {}

  // SDS §5.2 — GET /api/products?category=&search=&page= — paginated catalog.
  @Get()
  list(@Query() query: ListProductsQueryDto) {
    return this.products.list(query);
  }

  // SDS §6.2 — PDP: full variant detail + FIFO stock indicator data.
  @Get(':slug')
  detail(@Param('slug') slug: string) {
    return this.products.getBySlug(slug);
  }
}
