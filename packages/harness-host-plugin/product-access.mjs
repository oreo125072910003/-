import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { PRODUCT_TOOLS } from '../contracts/product-tools.mjs';
import { validateTaskImages } from '../contracts/image-input.mjs';

export function validateProductConnection(value) {
  if (value === undefined) return undefined;
  if (!value || Object.keys(value).sort().join(',') !== 'endpoint,token' ||
      typeof value.endpoint !== 'string' || !/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}\/tools$/.test(value.endpoint) ||
      Number(new URL(value.endpoint).port) > 65535 || !/^[A-Za-z0-9_-]{43}$/.test(value.token)) throw Object.assign(Error('PRODUCT_CONNECTION_INVALID'), { code: 'PRODUCT_CONNECTION_INVALID' });
  return value;
}

export function registerProductTools(agentCtx, { names, connection, policy, signal, prepareImages }) {
  const selected = PRODUCT_TOOLS.filter(tool => names.includes(tool.name));
  if (!selected.length) return () => {};
  validateProductConnection(connection);
  if (!connection || typeof agentCtx.tools?.register !== 'function') throw Object.assign(Error('PRODUCT_CONNECTION_REQUIRED'), { code: 'PRODUCT_CONNECTION_REQUIRED' });
  const disposers = [];
  try {
    for (const tool of selected) disposers.push(agentCtx.tools.register({
      name: tool.name, description: tool.description, parameters: tool.parameters,
      output: { schema: { type: 'object', properties: { content: { type: 'string' }, isError: { type: 'boolean' }, imageBlocks:{type:'array',items:{type:'object',properties:{type:{type:'string',enum:['image']},attachment:{type:'object',properties:{attachmentId:{type:'string'},mediaType:{type:'string'},bytes:{type:'integer'},width:{type:'integer'},height:{type:'integer'}},required:['attachmentId','mediaType','bytes','width','height'],additionalProperties:false}},required:['type','attachment'],additionalProperties:false}} }, required: ['content', 'isError'], additionalProperties: false }, render: (_args, result) => [{ type: 'text', text: result.content },...(result.imageBlocks??[])] },
      async execute(args, exec) {
        if (!policy.allows(tool.name)) throw Error('PRODUCT_TOOL_NOT_GRANTED');
        const bounded = AbortSignal.any([signal, AbortSignal.timeout(90000), ...(exec?.signal ? [exec.signal] : [])]);
        const payload = JSON.stringify({ id: randomUUID(), name: tool.name, args });
        const result = await new Promise((resolve, reject) => {
          const request = http.request(connection.endpoint, { method: 'POST', signal: bounded, headers: { authorization: 'Bearer ' + connection.token, 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } }, response => {
            const chunks = []; let size = 0;
            response.on('data', chunk => { size += chunk.length; if (size > 2 * 1024 * 1024) request.destroy(Error('PRODUCT_RESULT_LIMIT')); else chunks.push(chunk); });
            response.on('error', reject);
            response.on('end', () => { try { const value = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (typeof value.content !== 'string' || typeof value.isError !== 'boolean') throw Error('PRODUCT_RESULT_INVALID'); resolve(value); } catch (error) { reject(error); } });
          }); request.on('error', reject); request.end(payload);
        });
        bounded.throwIfAborted();
        if (!policy.allows(tool.name)) throw Error('PRODUCT_TOOL_NOT_GRANTED');
        const images=validateTaskImages(result.images);const {images:ignored,...visible}=result;
        if(images.length){
          if(!prepareImages)throw Error('当前宿主尚未接通截图视觉回传，请更新连接组件。');
          visible.imageBlocks=(await prepareImages(images)).map(({attachment})=>({type:'image',attachment:Object.fromEntries(['attachmentId','mediaType','bytes','width','height'].map(key=>[key,attachment[key]]))}));bounded.throwIfAborted();
          if(!policy.allows(tool.name))throw Error('PRODUCT_TOOL_NOT_GRANTED');
        }
        return visible;
      },
    }));
  } catch (error) { for (const dispose of disposers.reverse()) dispose?.(); throw error; }
  return () => { for (const dispose of disposers.reverse()) dispose?.(); };
}
