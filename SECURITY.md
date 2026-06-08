# 安全策略

## 报告漏洞

如果您发现了安全漏洞，请**不要**在公开 Issues 中报告。

### 报告流程

1. **通过电子邮件报告**
   - 发送邮件至安全联系人邮箱

   邮件应包含：
   - 漏洞的详细描述
   - 复现步骤
   - 潜在影响评估
   - 建议的修复方案（如果有）

2. **预期响应时间**
   - **24小时内**：确认收到报告
   - **3个工作日内**：初步评估结果
   - **7个工作日内**：详细分析和修复计划
   - **30天内**：发布安全更新（根据漏洞严重程度）

## 安全最佳实践

### 使用 SSH 密钥而非密码
```bash
# 推荐：使用 SSH 密钥
--key=/path/to/private/key

# 不推荐：使用密码（可能出现在进程列表中）
--password=yourpassword
```

### 保护私钥文件
```bash
# 设置正确的文件权限
chmod 600 ~/.ssh/id_rsa
```

### 使用环境变量
```bash
# 避免在命令行中暴露敏感信息
export SSH_PASSWORD="yourpassword"
# 然后在启动时使用环境变量
```

### 网络隔离
- 仅在可信网络中使用
- 考虑使用 VPN 或 SSH 隧道
- 避免通过公共网络传输敏感数据

## 已知安全考虑

### 1. 进程信息泄露
命令行参数可能出现在进程列表中，暴露主机、用户名等信息。

**缓解措施**：
- 使用配置文件而非命令行参数
- 定期轮换 SSH 密钥
- 使用最小权限原则

### 2. 缓冲区管理
项目管理终端输出缓冲区，可能成为资源耗尽攻击的目标。

**缓解措施**：
- 默认限制缓冲区大小（200,000 字符）
- 可配置的最大限制
- 定期清理空闲会话

### 3. 会话劫持
如果攻击者获得 MCP 客户端访问权限，可能劫持现有 SSH 会话。

**缓解措施**：
- 使用强身份验证
- 启用会话超时
- 监控异常活动

### 4. 输入验证
所有用户输入都经过验证，但仍需注意：
- 命令注入防护
- 路径遍历防护
- 缓冲区溢出防护

## 安全配置建议

### 生产环境配置
```bash
# 使用配置文件而非命令行参数
node build/index.js --config /path/to/secure-config.json

# 设置合理的超时时间
--timeout=900000  # 15分钟空闲超时

# 限制缓冲区大小
--maxBufferChars=100000
```

### 监控和日志
- 启用详细日志记录异常活动
- 监控会话创建和关闭
- 定期审计访问日志

## 依赖安全

### 定期更新依赖
```bash
# 检查安全漏洞
npm audit

# 更新依赖
npm update

# 修复安全漏洞
npm audit fix
```

### 关键依赖
- `ssh2`: SSH 客户端库，定期更新以获取安全修复
- `@modelcontextprotocol/sdk`: MCP SDK，关注安全公告
- `zod`: 输入验证库，确保所有输入都经过验证

## 供应链安全

### 容器镜像扫描

- CI 会对仓库文件系统运行 Trivy 扫描
- CI / Release 会对构建出的容器镜像运行 Trivy 高危与严重漏洞扫描

### SBOM

- Release 会为发布到 GHCR 的镜像 digest 生成 CycloneDX JSON 格式的 SBOM
- SBOM 会作为 GitHub Release 附件发布

### 镜像签名

- Release 会对发布到 GHCR 的镜像 digest 执行 Cosign keyless 签名
- 该签名依赖 GitHub Actions OIDC，不需要在仓库中保存签名私钥
- GHCR digest 是官方验签主路径；Docker Hub 不作为主要验签入口

验证示例：

```bash
cosign verify ghcr.io/<owner>/ssh-session-mcp@sha256:<digest> \
  --certificate-identity-regexp "https://github.com/.+" \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

## 漏洞披露政策

### 负责任披露
我们遵循负责任披露原则：
1. 报告者私下向维护者报告漏洞
2. 维护者确认并评估漏洞
3. 开发修复方案
4. 测试修复
5. 发布安全更新
6. 公开披露漏洞细节（通常在修复后）

### 致谢
我们感谢安全研究人员的负责任披露，并会在安全公告中致谢（如果报告者同意）。
