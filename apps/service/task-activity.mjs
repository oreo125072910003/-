const labels = {
  document: ['正在排版和生成文档', '文档已生成，正在整理说明'],
  save_text: ['正在保存文字成果', '文字成果已保存，正在继续处理'],
  draw: ['正在绘制图片', '图片已生成，正在整理说明'],
  attachment: ['正在整理待发送的文件', '文件已列入交付清单，正在整理回复'],
  read_document: ['正在读取和分析资料', '资料已读取，正在分析整理'],
  read_local_file: ['正在读取和分析资料', '资料已读取，正在分析整理'],
  list_local_dir: ['正在查找需要的文件', '文件位置已核对，正在继续处理'],
  write_local_file: ['正在保存文件', '文件已保存，正在继续处理'],
  export_file: ['正在整理交付文件', '交付文件已保存，正在整理说明'],
  run_local_shell: ['正在执行本次任务需要的电脑操作', '本次电脑操作已返回，正在检查结果'],
  screenshot: ['正在截取画面', '画面已保存，正在继续处理'],
  browser: ['正在浏览和处理网页内容', '网页操作已返回，正在整理结果'],
  mail: ['正在处理邮件资料', '邮件操作已返回，正在整理结果'],
  sticker: ['正在选择表情', '表情已列入交付清单'],
};

export function taskActivityLabel(name, phase) {
  const label = labels[String(name).replace(/^xiaozhushou_/, '')];
  return phase === 'failed' ? '上一步遇到问题，正在检查能否继续' : label?.[phase === 'started' ? 0 : 1] ?? '正在处理你的任务';
}

export function wechatProgressText(task, elapsedMs) {
  const minutes = Math.floor(elapsedMs / 60000);
  const elapsed = minutes ? `已经处理了 ${minutes} 分钟。` : '';
  if (!task || task.status === 'queued') return '收到，这条也记下了，正在排队；轮到后我会接着处理。';
  const label = task.status === 'validating' ? '正在检查和保存结果' : task.activity?.label || '还在处理你的任务';
  return `${elapsed}${label}。完成后会把说明和文件一起交给你。`;
}
