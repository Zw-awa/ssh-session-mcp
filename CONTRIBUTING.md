# 贡献指南

感谢您考虑为 SSH Session MCP 项目做出贡献！

## 如何贡献

### 报告问题

如果您发现了 bug 或有功能建议，请先检查 Issues 是否已有相关讨论。

创建新 issue 时，请包含：
- 清晰的问题描述
- 复现步骤
- 期望行为与实际行为
- 环境信息（Node.js 版本、操作系统等）
- 相关日志或截图

### 提交代码

1. **Fork 仓库**
   - 点击 GitHub 页面右上角的 "Fork" 按钮

2. **克隆您的 fork**
   ```bash
    git clone https://github.com/Zw-awa/ssh-session-mcp.git
   cd ssh-session-mcp
   ```

3. **创建分支**
   ```bash
   git checkout -b feature/your-feature-name
   # 或
   git checkout -b fix/issue-description
   ```

4. **安装依赖**
   ```bash
   npm install
   ```

5. **进行更改**
   - 确保代码符合项目风格
   - 添加必要的测试
   - 更新相关文档

6. **运行测试**
   ```bash
   npm test
   npm run build
   ```

7. **提交更改**
   ```bash
   git add .
   git commit -m "feat: 添加新功能描述"
   # 或
   git commit -m "fix: 修复问题描述"
   ```

   使用 Conventional Commits 格式：
   - `feat:` 新功能
   - `fix:` bug 修复
   - `docs:` 文档更新
   - `style:` 代码格式调整（不影响功能）
   - `refactor:` 代码重构
   - `test:` 测试相关
   - `chore:` 构建过程或辅助工具变动

8. **推送分支**
   ```bash
   git push origin feature/your-feature-name
   ```

9. **创建 Pull Request**
   - 前往原始仓库的 GitHub 页面
   - 点击 "New Pull Request"
   - 选择您的分支
   - 填写 PR 描述，说明更改内容和原因

## 开发环境

### 要求
- Node.js >= 18
- npm

### 设置开发环境
```bash
# 克隆项目
git clone https://github.com/Zw-awa/ssh-session-mcp.git
cd ssh-session-mcp

# 安装依赖
npm install

# 构建项目
npm run build

# 运行测试
npm test
```

### 常用命令
```bash
# 构建项目
npm run build

# 运行所有测试
npm test

# 开发模式运行测试（监听文件变化）
npm run test:watch

# 生成代码覆盖率报告
npm run coverage

# 使用 MCP 检查器调试
npm run inspect
```

## 代码风格

### TypeScript
- 使用 TypeScript 严格模式
- 为所有公共 API 添加类型定义
- 避免使用 `any` 类型
- 使用接口定义对象结构

### 命名约定
- 变量和函数：`camelCase`
- 类和类型：`PascalCase`
- 常量：`UPPER_SNAKE_CASE`
- 文件名：`kebab-case.ts`

### 代码结构
- 保持函数简洁
- 每个文件一个主要类或功能模块
- 使用明确的错误处理
- 添加必要的代码注释

## 测试

### 测试要求
- 为新功能添加单元测试
- 确保测试覆盖率不降低
- 测试应独立运行，不依赖外部服务
- 使用模拟对象替代真实 SSH 连接

### 运行测试
```bash
# 运行所有测试
npm test

# 运行特定测试文件
npm test -- test/session-helpers.test.ts

# 查看覆盖率报告
npm run coverage
```

## 文档

### 更新文档
- 如果更改了 API，请更新 README.md
- 如果添加了新功能，请更新相关文档
- 确保示例代码能够正常运行

### 文档格式
- 使用 Markdown 格式
- 代码示例使用正确的语言标记
- 保持链接有效

## 安全注意事项

### SSH 安全
- 不要在代码中硬编码密码或密钥
- 使用环境变量或配置文件存储敏感信息
- 确保私钥文件权限正确

### 代码安全
- 验证所有用户输入
- 防止命令注入攻击
- 正确处理错误，避免信息泄露