/* 合同填写小助手。无框架、无服务器；只修改 Word 文件中的填写位置。 */
'use strict';
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const $ = id => document.getElementById(id);
const form = $('form');
const partyFields = ['名称','代表','电话','地址','税号','开户行','账号'];
const globalKeys = ['合同名称','项目概况','合同编号','流水号','交货天数','交货地点','质保年限','回复小时','到场小时','技术补充',...['甲方','乙方'].flatMap(p=>partyFields.map(k=>p+k))];
const scalarKeys = [...globalKeys,'合同总额','大写金额','技术指标'];
let goods = [], payments = [], activeTemplate = null, templateName = '', edited = false;
const SAMPLE = __SAMPLE_JSON__;
const DEFAULT_TEMPLATE = '__TEMPLATE_BASE64__';

function show(message, error=false) {
  $('message').textContent=message; $('message').className=error?'error':'';
  $('message').style.display='block'; $('message').scrollIntoView({behavior:'smooth',block:'nearest'});
}
function escapeHtml(s) { return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function fieldValue(key) { return form.elements.namedItem(key).value.trim(); }
function setValues(values) { for(const key of globalKeys) form.elements.namedItem(key).value=String(values[key]??''); }
function readValues() { return Object.fromEntries(globalKeys.map(k=>[k,fieldValue(k)])); }
function blankGood() { return {name:'',model:'',qty:'1',unit:'台',price:'',spec:''}; }
function markEdited() { edited=true; }

// 使用整数计算分，避免 0.1 + 0.2 一类浮点误差。
function decimal(value, digits, label) {
  const s=String(value).trim();
  if(!new RegExp('^\\d+(?:\\.\\d{1,'+digits+'})?$').test(s)) throw Error(label+'须为非负数字，最多 '+digits+' 位小数。');
  const [a,b='']=s.split('.');
  if(a.length>12) throw Error(label+'过大，请检查。');
  return BigInt(a)*10n**BigInt(digits)+BigInt((b+'0'.repeat(digits)).slice(0,digits));
}
function subtotal(g) {
  const q=decimal(g.qty,4,'数量'), p=decimal(g.price,2,'单价');
  if(q===0n) throw Error('货物数量须大于 0。');
  return (q*p+5000n)/10000n;
}
function money(fen) { return (fen/100n).toString()+'.'+(fen%100n).toString().padStart(2,'0'); }
function totalAmount() {
  const total=goods.reduce((n,g)=>n+subtotal(g),0n);
  if(total>99999999999999n) throw Error('合同金额过大，请检查数量和单价。');
  return total;
}
function chineseMoney(fen) {
  const digits='零壹贰叁肆伍陆柒捌玖', units=['','拾','佰','仟'];
  function group(n) {
    let out='',zero=false;
    for(let i=3;i>=0;i--) {
      const d=Math.floor(n/10**i)%10;
      if(d){if(zero&&out)out+='零';out+=digits[d]+units[i];zero=false;}
      else if(out)zero=true;
    }
    return out;
  }
  let yuan=fen/100n, out='',gap=false;
  for(let i=2;i>=0;i--) {
    const g=Number(yuan/(10000n**BigInt(i))%10000n);
    if(g){if(out&&(gap||g<1000))out+='零';out+=group(g)+['','万','亿'][i];gap=false;}
    else if(out)gap=true;
  }
  out=(out||'零')+'元';
  const j=Number(fen/10n%10n), f=Number(fen%10n);
  if(!j&&!f)return out+'整';
  if(j)out+=digits[j]+'角';else if(f&&yuan>0n)out+='零';
  if(f)out+=digits[f]+'分';
  return out;
}
function paymentAmounts(total) {
  let used=0n;
  return payments.map((p,i)=>{
    const ratio=decimal(p.ratio,2,'付款比例');
    const n=i===payments.length-1?total-used:(total*ratio+5000n)/10000n;
    if(n<0n)throw Error('付款金额出现负数，请调整付款比例或期数。');
    used+=n; return n;
  });
}
function updateTotals() {
  goods.forEach((g,i)=>{try{$('sub-'+i).textContent=money(subtotal(g));}catch{$('sub-'+i).textContent='—';}});
  try {
    const total=totalAmount(), shown='¥ '+Number(money(total)).toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2});
    $('goods-total').textContent=$('footer-total').textContent=shown;
    $('uppercase').textContent=chineseMoney(total);
    const amounts=paymentAmounts(total);
    amounts.forEach((n,i)=>{if($('pay-'+i))$('pay-'+i).textContent=money(n);});
  } catch { $('goods-total').textContent=$('footer-total').textContent='请完善金额'; $('uppercase').textContent=''; payments.forEach((_,i)=>{if($('pay-'+i))$('pay-'+i).textContent='—';}); }
  $('footer-count').textContent=goods.length+' 项货物 · 可编辑 Word 格式';
}
function renderGoods() {
  const fields=[['name','产品名称'],['model','品牌型号'],['qty','数量'],['unit','单位'],['price','单价']];
  $('goods').innerHTML=goods.map((g,i)=>`<tr><td>${i+1}</td>${fields.map(([k,label])=>`<td><input aria-label="第${i+1}项${label}" data-i="${i}" data-key="${k}" value="${escapeHtml(g[k])}" ${['qty','price'].includes(k)?'inputmode="decimal"':''}></td>`).join('')}<td id="sub-${i}" class="subtotal"></td><td><button type="button" class="remove" data-remove="${i}" aria-label="删除第${i+1}项货物">删除</button></td></tr><tr class="spec"><td></td><td colspan="7"><label class="spec-label" for="spec-${i}">技术参数（可选）</label><textarea id="spec-${i}" rows="1" data-i="${i}" data-key="spec" placeholder="如材质、尺寸、波长或验收指标">${escapeHtml(g.spec)}</textarea></td></tr>`).join('');
  updateTotals();
}
function renderPayments() {
  $('payments').innerHTML=payments.map((p,i)=>`<tr><td>${i+1}</td><td><input aria-label="第${i+1}期付款条件" data-i="${i}" data-key="condition" value="${escapeHtml(p.condition)}"></td><td><input aria-label="第${i+1}期付款比例" inputmode="decimal" data-i="${i}" data-key="ratio" value="${escapeHtml(p.ratio)}"></td><td id="pay-${i}" class="amount"></td><td><button type="button" class="remove" data-remove="${i}" aria-label="删除第${i+1}期付款">删除</button></td></tr>`).join(''); updateTotals();
}
function preset(kind) {
  if(kind==='single')payments=[{condition:'标的物验收合格后10个工作日内',ratio:'100'}];
  if(kind==='staged')payments=[{condition:'合同签订后10个工作日内',ratio:'30'},{condition:'标的物验收合格后10个工作日内',ratio:'60'},{condition:'质保期后10个工作日内',ratio:'10'}];
  renderPayments();
}
function loadData(data) {
  setValues(data.fields||{}); form.elements.cover.checked=!!data.cover;
  goods=data.goods.map(g=>Object.fromEntries(['name','model','qty','unit','price','spec'].map(k=>[k,String(g[k]??'')])));
  payments=data.payments.map(p=>({condition:String(p.condition??''),ratio:String(p.ratio??'')}));
  $('payment-preset').value=payments.length===1?'single':'custom';
  renderGoods(); renderPayments();
}
function resetForm() {
  loadData({fields:{甲方名称:'上海交通大学',甲方地址:'上海市闵行区东川路800号',交货天数:'30',交货地点:'上海交通大学指定地点',质保年限:'2',回复小时:'4',到场小时:'24'},goods:[blankGood()],payments:[{condition:'标的物验收合格后10个工作日内',ratio:'100'}],cover:false});
  activeTemplate=null; templateName=''; templateLabel(); edited=false;
}
function templateLabel() { $('template-name').textContent=activeTemplate?'当前模板：'+templateName:'内置：交大小额货物采购合同（2025 年 9 月版）'; }

// Word 是 ZIP 包。保留样式、页眉、水印和关系，只替换 XML 中的文本与数据行。
const nodes=(e,tag)=>Array.from(e.getElementsByTagNameNS(W,tag));
const children=(e,tag)=>Array.from(e.children).filter(n=>n.namespaceURI===W&&n.localName===tag);
const text=e=>nodes(e,'t').map(t=>t.textContent).join('');
const parseXml=s=>{const x=new DOMParser().parseFromString(s,'application/xml');if(x.getElementsByTagName('parsererror').length)throw Error('模板内部 XML 格式有误。');return x;};
const serialize=x=>new XMLSerializer().serializeToString(x);
const element=(doc,tag)=>doc.createElementNS(W,'w:'+tag);
function putText(t,value) {
  const lines=String(value).split(/\r?\n/); t.textContent=lines[0]; t.setAttributeNS('http://www.w3.org/XML/1998/namespace','xml:space','preserve');
  let anchor=t;
  for(const line of lines.slice(1)){
    const br=element(t.ownerDocument,'br'),next=element(t.ownerDocument,'t');next.textContent=line;next.setAttributeNS('http://www.w3.org/XML/1998/namespace','xml:space','preserve');
    anchor.after(br,next);anchor=next;
  }
}
// 按字符偏移替换，即使一个填写标记被 Word 拆成多个 run 也能识别。
function replaceSpan(p,start,end,value) {
  let offset=0,items=nodes(p,'t').map(t=>{const a=offset;offset+=t.textContent.length;return {t,a,b:offset};});
  const first=items.find(n=>n.b>start), last=[...items].reverse().find(n=>n.a<end);
  if(!first||!last)throw Error('模板填写位置无法识别。');
  const before=first.t.textContent.slice(0,start-first.a),after=last.t.textContent.slice(end-last.a);
  if(first===last)putText(first.t,before+value+after);
  else {
    const a=items.indexOf(first),b=items.indexOf(last);
    for(let i=a+1;i<b;i++)items[i].t.textContent='';
    last.t.textContent=after;putText(first.t,before+value);
  }
}
function setParagraph(p,value) {
  const ts=nodes(p,'t');
  if(ts.length)replaceSpan(p,0,text(p).length,value);
  else{const r=element(p.ownerDocument,'r'),t=element(p.ownerDocument,'t');r.append(t);p.append(r);putText(t,value);}
}
function appendRun(p,value) {
  const r=element(p.ownerDocument,'r'),last=nodes(p,'r').at(-1),pr=last&&children(last,'rPr')[0];
  if(pr)r.append(pr.cloneNode(true));
  const t=element(p.ownerDocument,'t');r.append(t);p.append(r);putText(t,value);
}
function suffix(p,label,value) {
  const s=text(p),at=s.indexOf(label); if(at<0)throw Error('原始模板缺少字段：'+label);
  const start=at+label.length;
  if(start===s.length)appendRun(p,value);
  else replaceSpan(p,start,s.length,value);
}
function normalizeOriginal(xml) {
  const body=nodes(xml,'body')[0],ps=children(body,'p');
  if(!ps.some(p=>text(p).includes('采购合同名称：***采购')))return false;
  const find=s=>ps.find(p=>text(p).startsWith(s));
  const required=['甲方（需方）：','乙方（供方）：','采购项目概况：','（小写人民币）：','（大写人民币）：','交货期/服务期/工期：','交货地点/服务地点/工程地点：'];
  if(required.some(s=>!find(s)))throw Error('该原始模板与已适配版本不同，请先加入填写标记。');
  for(const [label,key] of [['甲方（需方）：','甲方名称'],['乙方（供方）：','乙方名称'],['采购合同名称：','合同名称'],['采购项目概况：','项目概况'],['（小写人民币）：','合同总额'],['（大写人民币）：','大写金额'],['交货地点/服务地点/工程地点：','交货地点']]) suffix(find(label),label,'{{'+key+'}}');
  const due=find('交货期/服务期/工期：'); suffix(due,'交货期/服务期/工期：','自合同签订之日起{{交货天数}}个日历天（含安装调试）');
  const service=find('本项目质保期');
  if(!service)throw Error('找不到模板质保条款。');
  const svc=text(service);
  const replacements=[[/质保期\s*2\s*年/,'质保期 {{质保年限}} 年'],[/4\s*小时/,'{{回复小时}}小时'],[/24\s*小时/,'{{到场小时}}小时']];
  let result=svc;for(const [pattern,value] of replacements){if(!pattern.test(result))throw Error('质保条款版本不匹配。');result=result.replace(pattern,value);}setParagraph(service,result);
  const tech=find('……');if(!tech)throw Error('找不到技术指标填写位置。');setParagraph(tech,'{{技术指标}}');
  // 签章区使用结构位置定位，避免把正文内其他“电话/地址”误替换。
  for(const party of ['甲方','乙方']) {
    const start=ps.indexOf(find(party+'（盖章）'));
    if(start<0||ps.length<start+5)throw Error('签章区不完整。');
    suffix(ps[start+1],'（必填）','{{'+party+'名称}}');
    for(const [delta,key] of [[2,'代表'],[3,'电话'],[4,'地址']])suffix(ps[start+delta],'：','{{'+party+key+'}}');
  }
  for(const table of children(body,'tbl')) {
    const rows=children(table,'tr'),header=text(rows[1]||table);
    let keys;
    if(header.includes('产品名称')&&header.includes('单价'))keys=['货物序号','货物名称','品牌型号','数量','单位','单价'];
    else if(header.includes('付款期数')&&header.includes('付款条件'))keys=['付款期数','付款条件','付款比例','付款金额'];
    else continue;
    if(!rows[2]||children(rows[2],'tc').length!==keys.length)throw Error('模板表格结构不匹配。');
    children(rows[2],'tc').forEach((c,i)=>{const p=nodes(c,'p')[0];setParagraph(p,'{{'+keys[i]+'}}');nodes(c,'p').slice(1).forEach(n=>n.remove());});
    rows.slice(3).forEach(r=>r.remove());
  }
  return true;
}
function tokensIn(xml) { return nodes(xml,'p').flatMap(p=>[...text(p).matchAll(/\{\{([^{}]+)\}\}/g)].map(m=>m[1])); }
const goodKeys=['货物序号','货物名称','品牌型号','数量','单位','单价','小计','货物技术指标'];
const payKeys=['付款期数','付款条件','付款比例','付款金额'];
async function templateZip() { return JSZip.loadAsync(activeTemplate||DEFAULT_TEMPLATE,{base64:!activeTemplate}); }
async function validateTemplate(zip) {
  if(!zip.file('word/document.xml'))throw Error('请选择标准 .docx Word 文件。旧版 .doc 和 PDF 不能作为可编辑模板。');
  let total=0,hasOriginal=false;
  for(const name of Object.keys(zip.files).filter(n=>/^word\/(document|header\d+|footer\d+)\.xml$/.test(n))){
    const xml=parseXml(await zip.file(name).async('string'));
    if(name==='word/document.xml')hasOriginal=normalizeOriginal(xml);
    const keys=tokensIn(xml),unknown=keys.filter(k=>![...scalarKeys,...goodKeys,...payKeys].includes(k));
    if(unknown.length)throw Error('模板中有未支持的标记：'+[...new Set(unknown)].join('、'));
    total+=keys.length;
    for(const p of nodes(xml,'p'))if(/\{\{|\}\}/.test(text(p).replace(/\{\{[^{}]+\}\}/g,'')))throw Error('模板中有不完整的 {{填写标记}}，请修正。');
    for(const p of nodes(xml,'p')){
      if(!goodKeys.concat(payKeys).some(k=>text(p).includes('{{'+k+'}}')))continue;
      let parent=p;while(parent&&parent.localName!=='tr')parent=parent.parentElement;
      if(!parent)throw Error('货物和付款的逐行标记必须放在表格行内。');
      const rowKeys=tokensIn(parent);
      if(rowKeys.some(k=>goodKeys.includes(k))&&rowKeys.some(k=>payKeys.includes(k)))throw Error('货物和付款标记不能放在同一行。');
    }
  }
  if(!total)throw Error('未识别到填写标记。请使用提供的原始模板，或在其他 Word 模板中加入 {{甲方名称}} 等标记。');
  return hasOriginal;
}
function replaceTokens(xml,values) {
  for(const p of nodes(xml,'p')){
    const matches=[...text(p).matchAll(/\{\{([^{}]+)\}\}/g)];
    for(const m of matches.reverse()){
      if(!(m[1] in values))throw Error('未填写的模板标记：'+m[1]);
      replaceSpan(p,m.index,m.index+m[0].length,values[m[1]]);
    }
  }
}
function cloneRows(xml,keys,rows,values) {
  const marked=nodes(xml,'tr').filter(r=>keys.some(k=>text(r).includes('{{'+k+'}}')));
  for(const row of marked){
    for(const data of rows){const copy=row.cloneNode(true);nodes(copy,'bookmarkStart').concat(nodes(copy,'bookmarkEnd'),nodes(copy,'permStart'),nodes(copy,'permEnd')).forEach(n=>n.remove());replaceTokens(copy,{...values,...data});row.before(copy);}
    row.remove();
  }
}
function property(parent,container,tag) {
  let pr=children(parent,container)[0];
  if(!pr){pr=element(parent.ownerDocument,container);parent.insertBefore(pr,parent.firstChild);}
  if(!children(pr,tag).length)pr.append(element(parent.ownerDocument,tag));
}
function tidyOriginalLayout(xml) {
  // 表头整行显示，长清单跨页重复表头；每方的签章资料不拆页。
  const body=nodes(xml,'body')[0];
  for(const table of children(body,'tbl')){
    const rows=children(table,'tr');
    for(const row of rows)property(row,'trPr','cantSplit');
    for(const row of rows.slice(0,2)){
      property(row,'trPr','tblHeader');
      for(const p of nodes(row,'p'))property(p,'pPr','keepNext');
    }
  }
  const ps=children(body,'p');
  const headings=['采购合同名称及项目概况','合同金额','付款方式','采购内容','响应服务','安全责任','廉洁责任','违约责任','其他事宜','1.采购清单','2.技术指标或服务方案（必填）','3.交货/服务/工程期限、地点','4.项目验收'];
  for(const p of ps){
    property(p,'pPr','widowControl');
    if(headings.includes(text(p)))property(p,'pPr','keepNext');
  }
  for(const party of ['甲方','乙方']){
    const start=ps.findIndex(p=>text(p).startsWith(party+'（盖章）'));
    if(start>=0)ps.slice(start,start+4).forEach(p=>property(p,'pPr','keepNext'));
  }
}
function expandTechnical(xml,value) {
  for(const p of nodes(xml,'p').filter(p=>text(p)==='{{技术指标}}')){
    for(const block of value.split(/\n\s*\n/).filter(Boolean)){
      const copy=p.cloneNode(true);setParagraph(copy,block);property(copy,'pPr','keepLines');
      const spacing=children(children(copy,'pPr')[0],'spacing')[0];
      if(spacing)spacing.setAttributeNS(W,'w:after','160');
      p.before(copy);
    }
    p.remove();
  }
}
function addCover(xml,values) {
  const body=nodes(xml,'body')[0],anchor=body.firstElementChild;
  function line(s,size=28,bold=false,center=false,after=180){
    const p=element(xml,'p'),pr=element(xml,'pPr'),spacing=element(xml,'spacing');spacing.setAttributeNS(W,'w:after',String(after));spacing.setAttributeNS(W,'w:line','360');spacing.setAttributeNS(W,'w:lineRule','auto');pr.append(spacing);
    if(center){const jc=element(xml,'jc');jc.setAttributeNS(W,'w:val','center');pr.append(jc);}p.append(pr);
    const r=element(xml,'r'),rp=element(xml,'rPr'),fonts=element(xml,'rFonts');for(const k of ['ascii','hAnsi','eastAsia'])fonts.setAttributeNS(W,'w:'+k,'宋体');rp.append(fonts);
    const sz=element(xml,'sz');sz.setAttributeNS(W,'w:val',String(size));rp.append(sz);if(bold)rp.append(element(xml,'b'));r.append(rp);const t=element(xml,'t');r.append(t);putText(t,s);p.append(r);body.insertBefore(p,anchor);return p;
  }
  if(values.合同编号||values.流水号)line([values.合同编号?'合同编号：'+values.合同编号:'',values.流水号?'流水号：'+values.流水号:''].filter(Boolean).join('    '),22,false,false,500);
  line('采购合同',44,true,true,420);line('合同名称：'+values.合同名称,28,true,false,320);
  for(const party of ['甲方','乙方']){
    line((party==='甲方'?'需方：':'供方：')+values[party+'名称'],28,true,false,160);
    for(const [label,key] of [['税号','税号'],['开户银行','开户行'],['银行账号','账号']])line(label+'：'+(values[party+key]||'________________'),24,false,false,180);
    line('',24,false,false,150);
  }
  // 封面单独成节，不改动原合同的页面尺寸与页眉；首页页眉不继承模板水印。
  const p=line('',22,false,false,0),pr=children(p,'pPr')[0],sect=children(body,'sectPr')[0].cloneNode(true);
  children(sect,'headerReference').concat(children(sect,'footerReference')).forEach(n=>n.remove());
  let type=children(sect,'type')[0];if(!type){type=element(xml,'type');sect.insertBefore(type,sect.firstChild);}type.setAttributeNS(W,'w:val','nextPage');pr.append(sect);
}
function validateForm() {
  if(!form.reportValidity())throw Error('请先填完带 * 的信息，并检查交付和质保数值。');
  if(!goods.length)throw Error('请至少添加一项货物。');
  for(let i=0;i<goods.length;i++){
    for(const k of ['name','model','unit'])if(!goods[i][k].trim())throw Error('请填写第 '+(i+1)+' 项货物的名称、品牌型号和单位。');
    subtotal(goods[i]);
  }
  if(!payments.length||payments.some(p=>!p.condition.trim()))throw Error('请填写付款条件。');
  if(payments.reduce((n,p)=>n+decimal(p.ratio,2,'付款比例'),0n)!==10000n)throw Error('付款比例合计必须为 100%。');
  if(!fieldValue('技术补充')&&!goods.some(g=>g.spec.trim()))throw Error('请填写货物技术参数，或统一填写“技术指标或服务方案”。');
  const vals=readValues();
  for(const [k,v] of Object.entries(vals))if(v.includes('{{')||v.includes('}}'))throw Error(k+'中不能包含模板标记 {{ 或 }}。');
  for(const g of goods)for(const v of Object.values(g))if(v.includes('{{')||v.includes('}}'))throw Error('货物内容中不能包含模板标记 {{ 或 }}。');
  return totalAmount();
}
async function buildDocx(asTemplate=false) {
  const total=asTemplate?0n:validateForm(),zip=await templateZip();await validateTemplate(zip);
  const values=readValues(); values.合同总额='￥'+money(total);values.大写金额=chineseMoney(total);
  values.技术指标=[...goods.filter(g=>g.spec.trim()).map((g,i)=>(i+1)+'. '+g.name+'（'+g.model+'）\n'+g.spec.trim()),values.技术补充].filter(Boolean).join('\n\n');
  const amounts=asTemplate?[]:paymentAmounts(total);
  const dataRows=asTemplate?[]:goods.map((g,i)=>({'货物序号':String(i+1),'货物名称':g.name,'品牌型号':g.model,'数量':g.qty,'单位':g.unit,'单价':g.price,'小计':money(subtotal(g)),'货物技术指标':g.spec}));
  const payRows=payments.map((p,i)=>({'付款期数':String(i+1),'付款条件':p.condition,'付款比例':p.ratio,'付款金额':asTemplate?'':money(amounts[i])}));
  for(const name of Object.keys(zip.files).filter(n=>/^word\/(document|header\d+|footer\d+)\.xml$/.test(n))) {
    const xml=parseXml(await zip.file(name).async('string'));
    const normalized=name==='word/document.xml'&&normalizeOriginal(xml);
    if(!normalized&&!tokensIn(xml).length&&!(name==='word/document.xml'&&!asTemplate&&form.elements.cover.checked))continue;
    if(!asTemplate){cloneRows(xml,goodKeys,dataRows,values);cloneRows(xml,payKeys,payRows,values);expandTechnical(xml,values.技术指标);replaceTokens(xml,values);
      if(tokensIn(xml).length)throw Error('模板仍有未替换的填写标记。');
      if(name==='word/document.xml'&&form.elements.cover.checked)addCover(xml,values);
    }
    if(normalized)tidyOriginalLayout(xml);
    nodes(xml,'permStart').concat(nodes(xml,'permEnd')).forEach(n=>n.remove());
    zip.file(name,serialize(xml),{createFolders:false});
  }
  // 模板是填写限制模式。移除该限制，让生成的合同能够继续在 Word 中编辑。
  if(zip.file('word/settings.xml')){
    const settings=parseXml(await zip.file('word/settings.xml').async('string'));
    nodes(settings,'documentProtection').forEach(n=>n.remove());
    zip.file('word/settings.xml',serialize(settings),{createFolders:false});
  }
  return zip.generateAsync({type:'blob',compression:'DEFLATE',mimeType:'application/vnd.openxmlformats-officedocument.wordprocessingml.document'});
}
function download(blob,name) { const a=document.createElement('a'),url=URL.createObjectURL(blob);a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),30000); }
async function base64(bytes) { return new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result.split(',')[1]);r.onerror=reject;r.readAsDataURL(new Blob([bytes]));}); }
function decode64(s){return Uint8Array.from(atob(s),c=>c.charCodeAt(0));}

for(const party of ['甲方','乙方']){
  const labels={名称:'名称 *',代表:party==='甲方'?'委托代表 *':'委托代表（可选）',电话:'联系电话 *',地址:'地址 *',税号:'税号（封面，可选）',开户行:'开户银行（封面，可选）',账号:'银行账号（封面，可选）'};
  $('parties').insertAdjacentHTML('beforeend',`<div class="party"><h3>${party} · ${party==='甲方'?'需方':'供方'}</h3><div class="grid">${partyFields.map(k=>`<label class="field ${['名称','地址','开户行','账号'].includes(k)?'full':''}">${labels[k]}<input name="${party+k}" ${['名称','电话','地址'].includes(k)||(party==='甲方'&&k==='代表')?'required':''}></label>`).join('')}</div></div>`);
}
$('token-help').innerHTML=scalarKeys.filter(k=>k!=='技术补充').map(k=>'<code>{{'+k+'}}</code>').join('　');
for(const id of ['example','fresh','save','load'])$(id).type='button';
form.addEventListener('input',markEdited);form.addEventListener('submit',e=>e.preventDefault());
$('goods').addEventListener('input',e=>{if(e.target.dataset.key){goods[+e.target.dataset.i][e.target.dataset.key]=e.target.value;updateTotals();}});
$('goods').addEventListener('click',e=>{const i=e.target.dataset.remove;if(i!==undefined){goods.splice(+i,1);renderGoods();markEdited();}});
$('payments').addEventListener('input',e=>{if(e.target.dataset.key){payments[+e.target.dataset.i][e.target.dataset.key]=e.target.value;$('payment-preset').value='custom';updateTotals();}});
$('payments').addEventListener('click',e=>{const i=e.target.dataset.remove;if(i!==undefined){payments.splice(+i,1);renderPayments();markEdited();}});
$('add-good').onclick=()=>{goods.push(blankGood());renderGoods();markEdited();};
$('add-payment').onclick=()=>{payments.push({condition:'',ratio:'0'});$('payment-preset').value='custom';renderPayments();markEdited();};
$('payment-preset').onchange=e=>{preset(e.target.value);markEdited();};
$('example').onclick=()=>{if(edited&&!confirm('载入示例会替换当前填写内容，是否继续？'))return;activeTemplate=null;templateName='';templateLabel();loadData(SAMPLE);edited=true;show('已载入你提供的成品合同数据：9 项货物，合计 197,955.00 元。可直接生成，也可修改后生成。');};
$('fresh').onclick=()=>{if(edited&&!confirm('新建会清空当前填写内容，是否继续？'))return;resetForm();$('message').style.display='none';};
$('default-template').onclick=()=>{activeTemplate=null;templateName='';templateLabel();markEdited();show('已切换回内置模板，填写内容保留。');};
$('pick-template').onclick=()=>$('template-file').click();
$('template-file').onchange=async e=>{const f=e.target.files[0];if(!f)return;try{if(f.size>20*1024*1024)throw Error('模板请小于 20 MB。');const bytes=await f.arrayBuffer();const z=await JSZip.loadAsync(bytes);await validateTemplate(z);activeTemplate=bytes;templateName=f.name;templateLabel();markEdited();show('模板已载入，填写后可生成合同。');}catch(err){show('模板未载入：'+err.message,true);}finally{e.target.value='';}};
$('download-template').onclick=async()=>{try{download(await buildDocx(true),'合同填写标记模板.docx');show('已下载带填写标记的模板，可在 Word 中调整正文和版式后重新导入。');}catch(err){show(err.message,true);}};
$('generate').onclick=async()=>{const b=$('generate');b.disabled=true;b.textContent='正在生成…';try{const blob=await buildDocx();const name=fieldValue('合同名称').replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').slice(0,100)||'采购合同';download(blob,name+'.docx');show('Word 合同已生成。请打开下载的文件检查内容和分页。');}catch(err){show(err.message||'生成失败，请检查模板与填写内容。',true);}finally{b.disabled=false;b.textContent='生成 Word 合同 ↓';}};
$('save').onclick=async()=>{try{const data={version:1,fields:readValues(),cover:form.elements.cover.checked,goods,payments,template:activeTemplate?{name:templateName,base64:await base64(activeTemplate)}:null};download(new Blob([JSON.stringify(data,null,2)],{type:'application/json;charset=utf-8'}),'合同填写进度.json');edited=false;show('填写进度已保存为本地文件，下次用“打开填写进度”继续。');}catch(err){show(err.message,true);}};
$('load').onclick=()=>$('data-file').click();
$('data-file').onchange=async e=>{const f=e.target.files[0];if(!f)return;try{
  if(edited&&!confirm('打开进度会替换当前填写内容，是否继续？'))return;
  if(f.size>30*1024*1024)throw Error('进度文件过大。');const data=JSON.parse(await f.text());
  if(data.version!==1||!data.fields||!Array.isArray(data.goods)||!Array.isArray(data.payments)||!data.goods.length||!data.payments.length||data.goods.length>500||data.payments.length>100||data.goods.some(g=>!g||typeof g!=='object')||data.payments.some(p=>!p||typeof p!=='object'))throw Error('这不是有效的合同填写进度文件。');
  let bytes=null;if(data.template){if(typeof data.template.base64!=='string')throw Error('进度中的模板无效。');bytes=decode64(data.template.base64);await validateTemplate(await JSZip.loadAsync(bytes));}
  loadData(data);activeTemplate=bytes;templateName=String(data.template?.name||'导入模板');templateLabel();edited=false;show('已恢复填写进度。');
}catch(err){show('打开失败：'+err.message,true);}finally{e.target.value='';}};
window.addEventListener('beforeunload',e=>{if(edited){e.preventDefault();e.returnValue='';}});
resetForm();
