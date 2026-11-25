# Antigravity Gemini Widget（Gemini 星语猫姬挂件）

仿照 GitHub 开源项目 `dsh-whale-widget` 为 **Google Antigravity** 打造的底部常驻「Gemini 星语猫姬」桌宠与用量账单插件。

## 核心特性

1. **贴边探头桌宠体验**
   - 保持 `dsh-pet` 标志性的右下角无边距贴边探头构图与呆萌/半眯眼表情，融合 **Gemini 星语猫姬** 蓝紫渐层长发、猫耳、四角星发饰、粉金异色瞳与星空蝴蝶结水手领设计。
   - **无上限高帧率阻尼弹簧物理**：音量守恒 Q 弹形变，快速连点顺滑不卡顿；单击播放清脆「冰」音效。
   - **窗内严格限位拖拽与四边磁吸**：拖拽与停靠均限制在 Antigravity 面板内部，默认紧贴右下角（最小化时自动隐藏），拖至左侧时自动水平镜像翻转（气泡与账单文字保持正读）。
2. **Gemini 哈基米账单与双模型池实时额度**
   - 单击猫姬即可展开「✦ Gemini哈基米账单」浮层卡片，**点击账单外空白处或按 `Esc` 即可关闭**。
   - **今日已用 Token & 等效费用**：数字滚动动画、输入 / 缓存读取 / 输出拆分、缓存命中率与节省金额，按 `¥` / `$` 估算等效费用并按天归档。
   - **每 5 小时 & 周剩余额度**：同时展示 **Gemini 模型** 与 **ChatGPT / Claude 模型** 的 5 小时和周剩余额度进度条及重置倒计时（优先读取本地 Antigravity Language Server `RetrieveUserQuotaSummary` + `GetUserStatus`，离线时自动平滑回退至本地滚动窗口估算）。
3. **每轮自动冒泡播报 & 洗牌袋台词**
   - 通过 Antigravity `hooks.json`（`SessionStart` / `PostToolUse` / `Stop`）驱动猫姬状态，每轮对话结束自动弹出消耗播报气泡（5 秒后自动收起，点击可展开完整账单）。
   - 内置加权不重复洗牌袋台词库，点击台词可切换下一句。
4. **Antigravity 右侧辅助面板（Sidecar Aux Pane）**
   - 同步提供零第三方 Node 依赖的原生侧边面板，可查看今日账单、14 天历史柱状图与明细，以及调整缩放、停靠模式、币种、音效与自动播报设置。

## 环境要求

- **操作系统**：Windows 10 / 11
- **Node.js**：>= 20（零外部 npm 依赖）
- **Python**：>= 3.10（需包含标准库 `tkinter`，并安装 `Pillow`）

```powershell
pip install pillow
```

## 安装与启用

### 1. 克隆仓库并运行一键安装脚本

```powershell
git clone https://github.com/MFavorever/antigravity-gemini-widget.git
cd antigravity-gemini-widget
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

可选参数：
- `-LaunchPet`：安装后立即以独立模式启动底部星语猫姬体验（无需等待重启）。

### 2. 在 Antigravity 中启用

1. 打开 Antigravity 左侧 **Customizations / Plugins** 页面，找到 **Gemini 星语猫姬 (`antigravity-gemini-widget`)** 并开启（如尚未刷新列表，重启一次 Antigravity）。
2. 插件启用后会自动运行 Sidecar 并唤出底部星语猫姬；也可以在右侧辅助面板 `+` 菜单打开 **Gemini 星语猫姬**。

## 独立预览与测试

在仓库根目录执行：

```powershell
# 1. 运行 Node.js 单元测试
node --test .\tests\test_widget.mjs

# 2. 启动独立后端（不依赖 Antigravity 宿主）
node .\sidecars\gemini_widget\main.mjs --standalone --port 18923

# 3. 单独启动底部猫姬（或在浏览器打开 http://127.0.0.1:18923/ ）
pythonw .\pet\desktop_pet.py --port 18923
```

## 目录结构

```text
antigravity-gemini-widget/
├── plugin.json               # Antigravity 插件清单
├── hooks.json                # 生命周期钩子配置
├── install.ps1               # Windows 一键同步安装脚本
├── uninstall.ps1             # 一键清理卸载脚本
├── start-pet.ps1 / .vbs      # 独立启动桌宠脚本
├── assets/
│   ├── gemini-pet.png        # 贴边探头立绘
│   ├── logo.png              # 插件图标
│   └── sounds/               # 音效资源 (bing / pop / squish / turn_done / error)
├── hooks/
│   └── notify.mjs            # Hook 事件上报桥接
├── pet/
│   └── desktop_pet.py        # Tkinter 桌面悬浮宠物与账单浮层
├── scripts/
│   ├── process_assets.py     # 绿幕抠图与基础音效生成工具
│   └── extract_bing.py       # 视频 AAC 音轨提取脚本 (Windows Media Foundation)
├── sidecars/gemini_widget/   # Sidecar 后端服务与辅助面板前端
└── tests/
    └── test_widget.mjs       # Node.js 单元测试
```

## 卸载

```powershell
powershell -ExecutionPolicy Bypass -File .\uninstall.ps1
```

## 致谢与免责声明

- 交互形态与插件思路致敬开源项目 [dsh-whale-widget](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget)。
- 项目内角色形象参考与音频切片仅用于个人学习、技术交流与桌面美化演示，请勿用于任何商业用途；如有侵权请联系删除。
