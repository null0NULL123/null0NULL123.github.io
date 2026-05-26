# TECH.BLOG 性能优化方案

## 概述

本项目为静态首页（GitHub Pages），设计理念 **至简 · 轻速 · 规整**。以下为已实施的全部性能优化。

---

## 1. 字体加载优化

### 问题

原方案使用 Google Fonts CDN 加载 Inter 和 JetBrains Mono 两个字体：

```html
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;600&family=JetBrains+Mono:wght@400;700&display=swap" rel="stylesheet" />
```

每次首屏加载需要：

- 2 次 DNS 查询（`fonts.googleapis.com` + `fonts.gstatic.com`）
- 2 次 TLS 握手
- 1 次 CSS 文件下载（解析后发现字体 URL）
- 多次字体文件下载

总计约 **200-400ms** 额外延迟，且在弱网环境下更为明显。

### 方案

**自托管字体 + preload 预加载**

1. 从 Google Fonts API 获取 woff2 文件 URL
2. 下载 latin 子集到 `public/fonts/`（中文由系统字体 fallback，无需 CJK 子集）
3. 发现 Inter 300/400/600 共用同一个 woff2 文件，JetBrains Mono 400/700 同理，合并为 2 个文件
4. 在 `BaseLayout.astro` 中内联声明 `@font-face`（`font-display: optional` 避免 CLS）
5. 在 `<head>` 中添加 `<link rel="preload">`

### 改动

**新增文件：**

```
public/fonts/inter-latin.woff2       (47.1 KB)
public/fonts/jetbrains-latin.woff2   (30.7 KB)
```

**`src/layouts/BaseLayout.astro` — 内联 @font-face 并替换 link 标签：**

> 注：`global.css` 已在后续提交中移除，所有样式内联至 `BaseLayout.astro` 的 `<style is:inline is:global>` 块中。

```css
@font-face {
  font-family: 'Inter';
  font-style: normal;
  font-weight: 300 600;
  font-display: optional;
  src: url('/fonts/inter-latin.woff2') format('woff2');
  unicode-range: U+0000-00FF, U+0131, U+0152-0153, ...;
}

@font-face {
  font-family: 'JetBrains Mono';
  font-style: normal;
  font-weight: 400 700;
  font-display: optional;
  src: url('/fonts/jetbrains-latin.woff2') format('woff2');
  unicode-range: U+0000-00FF, U+0131, U+0152-0153, ...;
}
```

```diff
- <link rel="preconnect" href="https://fonts.googleapis.com" />
- <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
- <link href="https://fonts.googleapis.com/css2?family=..." rel="stylesheet" />
+ <link rel="preload" href="/fonts/inter-latin.woff2" as="font" type="font/woff2" crossorigin />
+ <link rel="preload" href="/fonts/jetbrains-latin.woff2" as="font" type="font/woff2" crossorigin />
```

### 效果

| 指标 | Before | After |
|---|---|---|
| 外部请求 | 5-6 次 | 0 次 |
| DNS 查询 | 2 次 | 0 次 |
| TLS 握手 | 2 次 | 0 次 |
| 字体加载 | 串行（CSS 解析后才发现 URL） | 并行（preload 提前加载） |

---

## 2. Canvas 粒子动画性能优化

### 问题

`ParticleBackground.astro` 使用 Canvas 2D 绘制 500 个粒子及连线，存在以下性能瓶颈：

- 500 粒子在移动端性能开销过大
- 连线绘制为 O(n^2) 复杂度（80 x 500 次距离计算）
- 每条连线单独调用 `beginPath/stroke`，GPU 批处理效率低
- 每个粒子单独调用 `beginPath/arc/fill`
- 屏幕坐标每帧重复计算（连线和粒子各算一次）
- `HALF_W()` / `HALF_H()` 每帧每粒子调用函数
- 切换标签页后动画仍在运行

### 方案

六项针对性优化，逐一消除瓶颈。

### 改动

**`src/components/ParticleBackground.astro` 完整重写：**

#### 2.1 移动端自适应粒子数

```js
const isMobile = matchMedia('(max-width: 768px)').matches;
const PARTICLE_COUNT = isMobile ? 150 : 500;
const CONNECTION_PARTICLES = isMobile ? 30 : 80;
```

移动端粒子数减少 70%，连线粒子减少 62.5%。

#### 2.2 预计算屏幕坐标

```js
// Before: 连线和粒子各算一次，共 2 次
const xi = pos[i] * cos - pos[i + 1] * sin + cameraX + HALF_W();
// ...

// After: 预计算一次，存入 Float32Array
const screenX = new Float32Array(PARTICLE_COUNT);
const screenY = new Float32Array(PARTICLE_COUNT);

for (let i = 0; i < PARTICLE_COUNT; i++) {
  const pi = i * 2;
  screenX[i] = pos[pi] * cos - pos[pi + 1] * sin + cameraX + halfW;
  screenY[i] = pos[pi] * sin + pos[pi + 1] * cos + cameraY + halfH;
}
```

#### 2.3 批量绘制连线

```js
// Before: 每条线单独 stroke
ctx.strokeStyle = `rgba(255,255,255,${alpha})`;
ctx.beginPath();
ctx.moveTo(xi, yi);
ctx.lineTo(xj, yj);
ctx.stroke();

// After: 单次 beginPath + 一次 stroke
ctx.beginPath();
for (...) {
  ctx.moveTo(xi, yi);
  ctx.lineTo(screenX[j], screenY[j]);
}
ctx.strokeStyle = 'rgba(255,255,255,0.06)';
ctx.stroke();
```

#### 2.4 批量绘制粒子

```js
// Before: 每个粒子单独 fill
ctx.fillStyle = 'rgba(255,255,255,0.8)';
ctx.beginPath();
ctx.arc(x, y, 2.5, 0, Math.PI * 2);
ctx.fill();

// After: 单次 beginPath + 一次 fill
ctx.beginPath();
for (let i = 0; i < PARTICLE_COUNT; i++) {
  ctx.moveTo(screenX[i] + 2.5, screenY[i]);
  ctx.arc(screenX[i], screenY[i], 2.5, 0, Math.PI * 2);
}
ctx.fill();
```

#### 2.5 平方距离替代 sqrt

```js
// Before
const dist = dx * dx + dy * dy;
if (dist < MAX_DIST * MAX_DIST) {
  const alpha = (1 - Math.sqrt(dist) / MAX_DIST) * 0.2;
}

// After: 预计算 MAX_DIST_SQ，省掉 sqrt
const MAX_DIST_SQ = MAX_DIST * MAX_DIST;
const distSq = dx * dx + dy * dy;
if (distSq < MAX_DIST_SQ) { ... }
```

#### 2.6 Tab 不可见暂停

```js
let rafId = 0;

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    cancelAnimationFrame(rafId);
  } else {
    animate();
  }
});
```

#### 2.7 缓存 halfW / halfH

```js
// Before: 每帧每粒子调用函数
const HALF_W = () => canvas.width / 2;
const HALF_H = () => canvas.height / 2;

// After: resize 时缓存
let halfW: number;
let halfH: number;
function resize() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  halfW = canvas.width / 2;
  halfH = canvas.height / 2;
}
```

### 效果

| 指标 | Before | After |
|---|---|---|
| 桌面端粒子 | 500 | 500 |
| 移动端粒子 | 500 | 150 |
| 屏幕坐标计算/帧 | ~1160 次 | ~580 次（桌面）/ ~180 次（移动） |
| Canvas API 调用/帧 | ~80 stroke + ~500 fill | 1 stroke + 1 fill |
| 距离计算 | sqrt + 比较 | 仅平方比较 |
| Tab 切换 | 持续运行 | 暂停 |

---

## 3. CSS 清理

### 问题

`global.css` 中的 `--bg-secondary` 变量在移除 About 卡片和文章卡片后已无任何引用。

### 改动

```diff
  :root {
    --bg-primary: #0a0a0a;
-   --bg-secondary: #141414;
    --text-primary: #e4e4e7;
```

---

## 4. 构建配置修正

### 问题

`astro.config.mjs` 的 `site` 字段为占位符 `'https://yourusername.github.io'`，影响 sitemap、canonical URL 等生成功能。

### 改动

```diff
- site: 'https://yourusername.github.io',
+ site: 'https://null0NULL123.github.io',
```

---

## 优化前后对比总览

| 优化项 | 状态 |
|---|---|
| 字体自托管 + preload | Done |
| Canvas 移动端自适应 | Done |
| Canvas 批量绘制 | Done |
| Canvas 预计算坐标 | Done |
| Canvas 平方距离 | Done |
| Canvas Tab 暂停 | Done |
| Canvas halfW/H 缓存 | Done |
| CSS 无用变量清理 | Done |
| 构建配置 site URL | Done |
