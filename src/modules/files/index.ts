// Public entry point of the files module (logo and product photos). Other
// code imports only from "@/modules/files".
export { ImageError, MAX_UPLOAD_BYTES, type ImageErrorCode } from "./images";
export {
  FileError,
  listImages,
  MAX_IMAGES_PER_PRODUCT,
  readImage,
  removeImage,
  uploadLogo,
  uploadProductImage,
  type FileErrorCode,
} from "./service";
