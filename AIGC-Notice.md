# AIGC 声明 / AI-Generated Content Notice

**简体中文** · [English](#english)

---

## 简体中文

**本仓库完全由 AI 生成并维护。**

- 代码、文档、测试、示例、提交信息以及 issue/PR 回复，均由 **AI 编码 agent**（DeepSeek Harness
  中的 agent，模型 `deepseek-flash`）产出；人类只负责提出需求、审批与最终决定是否发布。
- 因此本仓库**不提供人类维护者的响应时间承诺**，也不保证问题会被人类查看；issue/PR 可能同样由
  AI 处理、答复或直接关闭。
- **免责**：软件按 LICENSE（MIT）的"原样"条款提供，不附带任何担保。AI 生成的代码可能包含缺陷、
  过时信息或不适用于你环境的建议。
- **使用前请自行验证**：`node test/run.mjs`（116 项检查）、`dshlink doctor`、
  `node scripts/verify-vendor.mjs`（frp 二进制校验），并阅读 [`SECURITY.md`](SECURITY.md) 的信任模型。
- **安全提醒**：涉及凭据分发/轮换、公网暴露、批量删除或覆盖数据的操作，请人工复核后再执行；
  AI 生成的运维与安全文档可能与你的实际环境不符。
- **许可**：本仓库以 [MIT](LICENSE) 发布，内容的 AI 生成属性不改变该许可的效力。

> 生成环境：DeepSeek Harness（DSH）编码 agent；本声明随仓库首次发布一同加入（2026-09-19）。

## English

**This repository is entirely generated and maintained by AI.**

- The code, documentation, tests, examples, commit messages and issue/PR replies are produced by an
  **AI coding agent** (an agent running inside DeepSeek Harness). Humans only set the requirements,
  approve the results and decide what gets published.
- Consequently there is **no human maintainer on the hook for response times**, and issues or pull
  requests may be handled — or closed — by the same AI.
- **No warranty**: the software is provided "as is" under the MIT license (see [`LICENSE`](LICENSE)).
  AI-generated code can contain defects, stale information, or advice that does not fit your
  environment.
- **Verify before you trust it**: run `node test/run.mjs` (116 checks), `dshlink doctor`, and
  `node scripts/verify-vendor.mjs` (frp binaries), and read the trust model in
  [`SECURITY.md`](SECURITY.md).
- **Security note**: anything that distributes or rotates credentials, exposes a machine to the
  public internet, or deletes/overwrites data deserves a human review. AI-written operational and
  security documentation may not match your setup.
- **License**: released under [MIT](LICENSE); the fact that the content was AI-generated does not
  change that license.

> Generated inside DeepSeek Harness (DSH); this notice was added together with the repository's
> first publication (2026-09-19).
