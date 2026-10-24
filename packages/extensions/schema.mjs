import { fail, object } from './common.mjs';

// Deliberately bounded JSON Schema subset. Unsupported validation keywords block
// the tool instead of silently treating its arguments as validated.
const KEYS = new Set(['$schema', '$id', 'title', 'description', 'default', 'examples', 'deprecated', 'readOnly', 'writeOnly', 'type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'minLength', 'maxLength', 'minimum', 'maximum', 'minItems', 'maxItems']);
export function validateSchema(schema, value, { schemaOnly = false, depth = 0, at = '$' } = {}) {
  if (depth > 16) fail('SCHEMA_UNSUPPORTED', '工具参数结构过深。');
  if (schema === true) return;
  if (schema === false) fail('INVALID_ARGUMENTS', `参数 ${at} 被工具禁止。`);
  object(schema, '工具参数结构');
  for (const key of Object.keys(schema)) if (!KEYS.has(key)) fail('SCHEMA_UNSUPPORTED', `工具使用暂不支持的校验规则：${key}。`);
  const supported = ['object', 'array', 'string', 'integer', 'number', 'boolean', 'null'];
  const types = schema.type === undefined ? [] : Array.isArray(schema.type) ? schema.type : [schema.type];
  if (types.some(type => !supported.includes(type))) fail('SCHEMA_UNSUPPORTED', '工具参数类型不受支持。');
  for (const key of ['minLength', 'maxLength', 'minItems', 'maxItems']) if (schema[key] !== undefined && (!Number.isSafeInteger(schema[key]) || schema[key] < 0)) fail('SCHEMA_UNSUPPORTED', '工具大小限制声明无效。');
  for (const key of ['minimum', 'maximum']) if (schema[key] !== undefined && (typeof schema[key] !== 'number' || !Number.isFinite(schema[key]))) fail('SCHEMA_UNSUPPORTED', '工具数值范围声明无效。');
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || !schema.enum.length || schema.enum.length > 256)) fail('SCHEMA_UNSUPPORTED', '工具枚举声明无效。');
  if (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.some(key => typeof key !== 'string'))) fail('SCHEMA_UNSUPPORTED', '工具必填字段声明无效。');
  if (schema.properties !== undefined) { object(schema.properties, '工具字段'); for (const item of Object.values(schema.properties)) validateSchema(item, undefined, { schemaOnly: true, depth: depth + 1 }); }
  if (schema.items !== undefined) validateSchema(schema.items, undefined, { schemaOnly: true, depth: depth + 1 });
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== 'boolean') validateSchema(schema.additionalProperties, undefined, { schemaOnly: true, depth: depth + 1 });
  if (schemaOnly) return;
  const isType = type => type === 'null' ? value === null : type === 'array' ? Array.isArray(value) : type === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value) : type === 'integer' ? Number.isSafeInteger(value) : type === 'number' ? typeof value === 'number' && Number.isFinite(value) : typeof value === type;
  if (types.length && !types.some(isType)) fail('INVALID_ARGUMENTS', `参数 ${at} 类型不正确。`);
  if (schema.enum && (!Array.isArray(schema.enum) || !schema.enum.some(item => JSON.stringify(item) === JSON.stringify(value)))) fail('INVALID_ARGUMENTS', `参数 ${at} 不在允许值中。`);
  if ('const' in schema && JSON.stringify(schema.const) !== JSON.stringify(value)) fail('INVALID_ARGUMENTS', `参数 ${at} 不符合固定值。`);
  if (typeof value === 'string') { if (schema.minLength !== undefined && [...value].length < schema.minLength || schema.maxLength !== undefined && [...value].length > schema.maxLength) fail('INVALID_ARGUMENTS', `参数 ${at} 长度不正确。`); }
  if (typeof value === 'number') { if (schema.minimum !== undefined && value < schema.minimum || schema.maximum !== undefined && value > schema.maximum) fail('INVALID_ARGUMENTS', `参数 ${at} 超出范围。`); }
  if (Array.isArray(value)) { if (schema.minItems !== undefined && value.length < schema.minItems || schema.maxItems !== undefined && value.length > schema.maxItems) fail('INVALID_ARGUMENTS', `参数 ${at} 数量不正确。`); if (schema.items !== undefined) value.forEach((item, i) => validateSchema(schema.items, item, { depth: depth + 1, at: `${at}[${i}]` })); }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) fail('INVALID_ARGUMENTS', `缺少工具参数：${key}。`);
    for (const [key, item] of Object.entries(value)) { if (Object.hasOwn(schema.properties ?? {}, key)) validateSchema(schema.properties[key], item, { depth: depth + 1, at: `${at}.${key}` }); else if (schema.additionalProperties === false) fail('INVALID_ARGUMENTS', `工具不接受参数：${key}。`); else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') validateSchema(schema.additionalProperties, item, { depth: depth + 1, at: `${at}.${key}` }); }
  }
}
