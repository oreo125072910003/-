# 多账号邮件插件

提供标准 IMAP 收信和 SMTP 手动发信。插件不依赖 AI 才能收信；需要总结、分类或拟回复时，由应用把用户选中的邮件正文交给小助手 DSH。

当前已经实现账号配置导入、多个邮箱、受保护凭据、只读收信、纯文本正文、附件隔离、不可变草稿和持久发送回执。没有真实登录用户邮箱或对外发信；验收使用本机 IMAP/SMTP 协议替身。

## 账号导入

`importAccounts` 接受下面的对象或它的 JSON 字符串。可一次导入 1 至 20 个账号，最多保留 30 个账号。同一个邮箱地址再次导入会更新原账号；已有消息与草稿保留。不同邮箱可配置不同服务器和认证方式。

```json
{
  "accounts": [
    {
      "name": "工作邮箱",
      "address": "your-name@example.com",
      "imap": {
        "host": "imap.example.com",
        "port": 993,
        "secure": true,
        "username": "your-name@example.com",
        "mailbox": "INBOX"
      },
      "smtp": {
        "host": "smtp.example.com",
        "port": 465,
        "secure": true,
        "username": "your-name@example.com"
      },
      "auth": {
        "type": "password",
        "password": "填写邮箱服务商提供的授权码"
      }
    }
  ]
}
```

`secure: true` 使用连接建立时的 TLS；`false` 必须升级到 STARTTLS，不允许以明文继续认证。IMAP 默认端口为 993/143，SMTP 默认 465/587。证书始终校验。`username` 默认为邮箱地址，收件文件夹默认为 `INBOX`。省略 `smtp` 可作为只读账号。

支持导入 `auth: {type: "oauth2", accessToken: "…", expiresAt: "2026-12-31T00:00:00Z"}`。收发凭据不同时可提供同格式的 `smtpAuth`。本版尚无服务商网页登录授权和自动刷新令牌；令牌过期后须重新授权导入。需要服务商允许 IMAP/SMTP；未开放标准协议的邮箱或特殊企业网关不能承诺即插即用。

密码、授权码和令牌只交给宿主 `secretStore`。SQLite 与界面状态只保存凭据引用，不返回密码。宿主须使用系统凭据保护，禁止用明文文件代替。

## 接口

```js
import { createMailController } from './index.mjs';
const mail = createMailController({store, dataDir, secretStore, onChange});
```

| 方法 | 输入和返回 |
| --- | --- |
| `getState()` | `{accounts,messages,drafts,status,automaticSending:false}` |
| `importAccounts({accounts})` | 返回 `{imported,accounts}`；导入不会登录或发信 |
| `sync({accountId,limit:50})` | 返回 `{accountId,received,pagination:'latest-only',limit,readOnly:true,messages}` |
| `getMessage({messageId})` | 返回本地保存的完整正文和附件元数据 |
| `createDraft({accountId,to,cc,bcc,subject,text,inReplyTo})` | `to/cc/bcc` 为地址数组；返回 `status:'draft'` 的草稿 |
| `sendDraft({draftId})` | 仅手动调用；返回草稿和持久回执 |
| `resolveAttachment({messageId,attachmentId})` | 核对邮件归属、路径、大小和 SHA256 后，返回隔离路径和原文件名 |
| `close()` | 停止活动连接并等待操作结束 |

草稿的 `inReplyTo` 传本地邮件记录 ID，只允许从原收信账号回复。插件从原邮件提取合法的 `Message-ID`，不接受任意外部头字段。

`sync` 打开只读邮箱（IMAP `EXAMINE`），正文使用 `UID BODY.PEEK`，不设已读、不移动、不删除。每次读取最新 1 至 100 封；这不是完整邮箱历史归档，也没有后台轮询。`UIDVALIDITY` 变化时建立新消息身份，避免覆盖旧邮件。单封原文超过 8 MiB 或本次原文预算超过 32 MiB 时仅保存元数据，并返回 `bodyStatus:'omitted-size-limit'`。

只返回纯文本正文，不把邮件 HTML 放入页面，不加载远程图片。正文最多 64,000 字符；每封最多隔离 20 个附件，每个附件最多 5 MiB。超限附件返回不可用元数据；多余附件数记在 `omittedAttachmentCount`。

## 发送语义

草稿内容一旦创建就不再修改。修改正文应创建新草稿，保留原草稿和回执。`draftId` 是持久幂等标识。

调用 `sendDraft` 之前先保存 `sending`。收到 SMTP `250` 和至少一个明确接收地址后才保存 `smtp-accepted`，回执记录 `accepted/rejected`。这代表服务器接收，不能证明已进入对方收件箱。部分地址被拒绝时会明确保留名单，不自动重新发送。

断线、超时或回执不明确记录 `unconfirmed`，不把未知结果当成功。同一草稿再次调用只返回现有状态，禁止重放。应用启动时必须先调用 `store.recover()`，把上次停留在 `sending` 的记录改成 `unconfirmed`。发送不由收信、导入、AI、定时器或应用启动触发。

附件保存为 `dataDir/mail/quarantine/<邮件ID>/<附件ID>.bin`。原文件名只用于显示，不参与磁盘路径。插件不执行、预览或自动打开附件，也不支持把隔离附件直接发送给外部收件人。宿主导出附件时须沿用文件选择和用户操作流程。

## 存储与宿主契约

使用 `packages/storage` 的 `listMailAccounts/getMailAccount/saveMailAccount/saveMailAccounts`、`commitMailSync/listMailMessages/getMailMessage` 和 `saveMailDraft/getMailDraft/listMailDrafts/updateMailDraft`。`saveMailAccounts` 必须原子保存整批；`updateMailDraft(id,{status,error,receipt})` 须合并并持久化 `receipt`，不能只保存状态。

`secretStore` 实现异步 `get(name)`、`set(name,string)`、`delete(name)`。本插件是该凭据引用的唯一所有者；不要把 `credentialRef` 返回给界面。

`imapFactory/smtpFactory` 仅用于协议替身测试。生产默认使用已锁定版本的 `imapflow/mailparser/nodemailer`，不启动另外的邮箱程序。

## 验证

运行 `node --test tests/mail-plugin.test.mjs`。覆盖多个账号、密钥隔离、批量导入失败回滚、只读 IMAP、TLS 参数、过期 OAuth、UIDVALIDITY、附件绑定与篡改、大小限制、SMTP 发送前落盘、重复点击和重启幂等、DATA 后断线未确认，以及真实 ImapFlow/Nodemailer 对本机协议替身的交互。

服务商实号登录、OAuth 网页授权、真实收信、真实 SMTP 投递、完整历史分页、POP3、日历、通讯录与自动分类规则仍需另行实现或验证。
