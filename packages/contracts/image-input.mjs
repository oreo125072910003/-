import { createHash } from 'node:crypto';

const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 768 * 1024;
const MAX_BASE64_LENGTH = 4 * Math.ceil(MAX_IMAGE_BYTES / 3);
const FIELDS = new Set(['id', 'name', 'mime', 'b64', 'sha256', 'bytes']);
const HEX = /^[a-f0-9]{64}$/i;
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const QUALITY_DIMENSIONS = ['width', 'height', 'sourceWidth', 'sourceHeight'];
const MAX_IMAGE_PIXELS = 40_000_000;

/** Optional reader metadata is bounded independently at each trust boundary.
 * Return only known fields, never a reader-controlled label or instruction. */
export function normalizeImageQuality(value) {
  if (!value || !QUALITY_DIMENSIONS.every(key => Number.isSafeInteger(value[key]) && value[key] > 0 && value[key] <= MAX_IMAGE_PIXELS) ||
      value.width * value.height > MAX_IMAGE_PIXELS || value.sourceWidth * value.sourceHeight > MAX_IMAGE_PIXELS ||
      !['full', 'thumbnail'].includes(value.sourceVariant)) return undefined;
  return Object.fromEntries([...QUALITY_DIMENSIONS.map(key => [key, value[key]]), ['sourceVariant', value.sourceVariant]]);
}

/** Copy a complete rectangle only when it lies within the validated source. */
export function normalizeImageRegion(value, quality) {
  if (!normalizeImageQuality(quality) || !Array.isArray(value) || value.length !== 4) return undefined;
  const region = Array.from(value);
  if (region.some(coordinate => !Number.isSafeInteger(coordinate) || coordinate < 0) || region[0] >= region[2] || region[1] >= region[3] ||
      region[2] > quality.sourceWidth || region[3] > quality.sourceHeight) return undefined;
  return region;
}

function matchesMagic(bytes, mime) {
  if (mime === 'image/png') return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (mime === 'image/jpeg') return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  return mime === 'image/webp' && bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
}

/** Validate task image bytes, never a path or URL. Shared by client and host. */
export function validateTaskImages(images) {
  if (images === undefined) return [];
  if (!Array.isArray(images)) fail('IMAGE_LIST_INVALID', '任务图片需要使用图片列表。');
  if (images.length > MAX_IMAGES) fail('IMAGE_COUNT_EXCEEDED', '每轮最多提供 4 张图片。');
  return Array.from(images, image => {
    if (!image || typeof image !== 'object' || Array.isArray(image) || Object.keys(image).some(key => !FIELDS.has(key))) fail('IMAGE_FIELDS_INVALID', '图片只接受受支持的内容与校验字段。');
    if (typeof image.id !== 'string' || !HEX.test(image.id)) fail('IMAGE_ID_INVALID', '图片编号必须是 64 位十六进制标识。');
    if (typeof image.sha256 !== 'string' || !HEX.test(image.sha256)) fail('IMAGE_SHA256_INVALID', '图片校验摘要无效。');
    let name;
    if (image.name !== undefined) {
      if (typeof image.name !== 'string' || !image.name.trim() || image.name.length > 160 ||
          /[\\/:\u0000-\u001f\u007f-\u009f\u200b\u200e\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u.test(image.name) || ['.', '..'].includes(image.name.trim())) fail('IMAGE_NAME_INVALID', '图片名称最多 160 个字符，不能含路径或控制字符。');
      name = image.name.trim();
    }
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(image.mime)) fail('IMAGE_MIME_INVALID', '图片只支持 PNG、JPEG 或 WEBP。');
    if (!Number.isSafeInteger(image.bytes) || image.bytes < 1) fail('IMAGE_BYTES_INVALID', '图片字节数无效。');
    if (image.bytes > MAX_IMAGE_BYTES) fail('IMAGE_SIZE_EXCEEDED', '每张图片最多 768 KiB。');
    if (typeof image.b64 !== 'string' || !image.b64.length || image.b64.length % 4 !== 0) fail('IMAGE_BASE64_INVALID', '图片内容必须是完整的标准 Base64。');
    if (image.b64.length > MAX_BASE64_LENGTH) fail('IMAGE_SIZE_EXCEEDED', '每张图片最多 768 KiB。');
    const bytes = Buffer.from(image.b64, 'base64');
    if (!bytes.length || bytes.toString('base64') !== image.b64) fail('IMAGE_BASE64_INVALID', '图片内容必须是完整的标准 Base64。');
    if (bytes.length !== image.bytes) fail('IMAGE_SIZE_MISMATCH', '图片实际大小与字节数不一致。');
    if (createHash('sha256').update(bytes).digest('hex') !== image.sha256.toLowerCase()) fail('IMAGE_SHA256_MISMATCH', '图片内容未通过 SHA256 校验。');
    if (!matchesMagic(bytes, image.mime)) fail('IMAGE_MAGIC_MISMATCH', '图片实际格式与声明类型不一致。');
    return { id: image.id.toLowerCase(), ...(name === undefined ? {} : { name }), mime: image.mime, b64: image.b64, sha256: image.sha256.toLowerCase(), bytes: bytes.length };
  });
}
