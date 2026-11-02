## Summary / 概述

<!-- What changed and why. Link the issue: Closes #123 -->
<!-- 改了什么、为什么改。关联 issue：Closes #123 -->

## Type of change / 变更类型

- [ ] Bug fix / 缺陷修复
- [ ] New feature / 新功能
- [ ] Breaking change / 破坏性变更
- [ ] Refactor or performance / 重构或性能
- [ ] Documentation or examples / 文档或示例
- [ ] CI, build, or dependencies / CI、构建或依赖

## How it was verified / 验证方式

<!-- Exact commands, test names, or steps a reviewer can repeat. -->
<!-- 评审者可复现的确切命令、测试名称或步骤。 -->

```bash
# pnpm check                 # typecheck both halves, build, then the test suite
# pnpm test                  # the test suite alone
```

## Checklist / 检查项

- [ ] `pnpm check` passes locally / 本地 `pnpm check` 通过
- [ ] Tests cover the behavior change / 行为变更有测试覆盖
- [ ] Both READMEs updated when user-facing text changed / 用户可见文案变更时两个 README 都已更新
- [ ] No secrets, tokens, internal hostnames, or personal data / 不含密钥、令牌、内网主机名或个人数据
