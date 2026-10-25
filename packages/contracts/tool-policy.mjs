// Capability classification is shared by catalog, saved-grant validation and
// the final native execution guard. Names are identities, never prompt claims.
import { productTool } from './product-tools.mjs';
const NAME = /^[\w.:-]{1,160}$/;
const LOCAL_CONTROL = new Set(['run_local_agent','local_agent_status','run_local_shell','list_local_dir','read_local_file','write_local_file','export_file','send_image']);
const PC_BUSINESS = new Set(['fetch_paper','fetch_player_stats','fetch_scores','pc_status','read_web_page']);
const CONTRACT_BUSINESS = new Set(['get_capabilities','get_material_import_defaults','get_material_import_plan','get_contract_schema','get_common_info','get_api_status','preview_contract','generate_contract','read_contract_progress','recognize_goods_image','draft_contract_description','export_contract_template','recognize_contract_images','lookup_model_specs','list_model_specs','library_search','library_read','search_materials','preview_ai_material_import','inspect_material_sheet','preview_material_sheet_import','get_preferences','query_inventory','material_price_history','recommend_materials','validate_material_selection','inventory_history','analyze_contract_template','adapt_contract_template']);
const CORE_BUSINESS = new Set(['meme-search__search','bili_search','bili_subtitle','bili_comments','bili_status','bili_whoami','working_directory','list_mcp_resources','list_mcp_resource_templates','read_mcp_resource']);
const CONTROL = /(?:^|[_.:-])(?:bash|shell|pwsh|powershell|terminal|exec_command|apply_patch|read_file|write_file|edit_file|run_code|subagent|agent|plugin_manager|automation|schedule|eval|execute|invoke|dispatch)(?:$|[_.:-])/;

export function describeTool(name) {
  if(typeof name!=='string'||!NAME.test(name))return {category:'invalid',grantable:false,reason:'工具名称无效。'};
  const lower=name.toLowerCase();
  const product=productTool(name);
  if(product)return {server:'xiaozhushou',basename:name,category:product.computer?'computer-control':'business-tool',grantable:!product.computer,computerGrantable:product.computer,reason:product.computer?'使用本轮已核验的私聊电脑权限。':'小助手本轮成果与通信功能。'};
  const mcp=lower.match(/^mcp__([a-z0-9_-]+)__(.+)$/);
  const alternate=lower.match(/^([a-z0-9_-]+)[.:]([a-z0-9_]+)$/);
  const server=mcp?.[1]??alternate?.[1]??'',basename=mcp?.[2]??alternate?.[2]??lower;
  const identity={server,basename};
  if(LOCAL_CONTROL.has(basename)||CONTROL.test(basename))return {...identity,category:'computer-control',grantable:false,computerGrantable:server==='pcbridge'&&LOCAL_CONTROL.has(basename),reason:'本机文件、命令与代理控制需要独立的受控授权，普通任务及文字协作不开放。'};
  if(server==='pcbridge'&&PC_BUSINESS.has(basename)||!server&&PC_BUSINESS.has(basename)||server==='contract_helper'&&CONTRACT_BUSINESS.has(basename)||!server&&CORE_BUSINESS.has(lower))return {...identity,category:'business-tool',grantable:true,reason:''};
  return {...identity,category:'unclassified',grantable:false,reason:'尚未核验该工具的能力类别；保留原选择，当前不执行。'};
}
export const grantableTool=name=>describeTool(name).grantable;
export const computerGrantableTool=name=>describeTool(name).computerGrantable===true;
