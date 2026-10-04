// Public entry point of the catalog module. Other code imports only from
// "@/modules/catalog", never from files inside this folder.
export {
  CatalogError,
  createBrand,
  createCategory,
  createUnit,
  getCatalogLists,
  renameListItem,
  setListItemArchived,
  type CatalogErrorCode,
  type CatalogListsDto,
} from "./service";
export {
  addBarcode,
  addVariant,
  findByBarcode,
  removeBarcode,
  changeVariantPrice,
  createProduct,
  createProductInput,
  getProduct,
  ImportError,
  importProductsCsv,
  listProducts,
  ProductError,
  setProductArchived,
  setVariantArchived,
  updateProduct,
  updateVariant,
  type ProductDto,
  type ProductErrorCode,
  type VariantDto,
} from "./products.service";
export { describeVariants, findVariantsByCode, type VariantSummaryDto } from "./lookup.service";
export { catalogForTill, TILL_CATALOG_LIMIT, variantsForSale, type VariantForSale } from "./for-sale";
export { variantLabel } from "./templates";
