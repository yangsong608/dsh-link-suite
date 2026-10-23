# MOSS 主体渲染

把 dsh-pet-liang 的 3D 模型渲染成 App 用的静态图。

## 为什么是预渲染

`assets3d/three.module.min.js` 656KB + `moss.fbx` 1MB，合计约 1.7MB。
App 首包预算是 400KB（`docs/05 §8`），为两个 28-160px 的角标加载一个
3D 引擎不划算。预渲染全套 WebP **40KB**，视觉上反而更锐利
（运行时渲染在 28px 下也会糊）。

## 拆出主体

模型由四块网格组成：

| 网格 | 内容 | 本工程 |
|---|---|---|
| `Moss_Main` | 机身主体 | ✅ 保留 |
| `Moss_Annexes` | 机身附件 | ✅ 保留 |
| `Moss_Glass` | 镜头玻璃（半透明） | ✅ 保留 |
| `Moss_arm` | 机械臂（含三段关节） | ❌ 隐藏 |

去掉机械臂后更像一枚"设备指示灯"，而不是一只宠物——这是本工程的定位
（设备状态，不是桌宠）。

## 红眼灯

原项目的眼灯是运行时用 `CircleGeometry` + 径向渐变 Sprite + `PointLight`
补出来的（模型自带的发光贴图只有 3 个 LED 点，主镜头没做发光）。
这里沿用同一套做法，但把"是否工作"从**构造参数**改成**每次渲染可调**：

- idle：核心不透明度 0.4，光晕 ×6，点光 0.6
- work：核心 0.82，光晕 ×9，点光 4.5

踩过的坑：`AdditiveBlending` 下把不透明度顶到 1 会先烧成白色
（实测整片 240,240,240），红光反而看不见。所以光晕渐变的绿蓝通道
压到很低，只留一点橙做暖感。

## 用法

```bash
cd app/tools/moss-render
node render.mjs        # → src/static/moss/*.webp
node render-icon.mjs   # → resources/icons/app-icon-1024.png
```

`assets3d` 是指向 `../../../dsh-pet-liang/assets3d` 的符号链接，
需要那个仓库在旁边。换机器时重建链接：

```bash
ln -sfn /path/to/dsh-pet-liang/assets3d assets3d
```

## 输出

| 文件 | 尺寸 | 体积 | 用途 |
|---|---|---|---|
| `boot.webp` | 640×640 | 7KB | 启动页主视觉 |
| `badge-idle.webp` | 160×160 | 5KB | 角标 · 待机 |
| `badge-work.webp` | 160×160 | 8KB | 角标 · 工作中 |
| `hero.webp` | 320×320 | 14KB | 我的页 / 关于 |
| `app-icon-1024.png` | 1024×1024 | 1.2MB | App 图标（不进 H5 包） |

## 像素自检

渲染后不要只看"有没有出图"，要检查**眼灯是否真的亮**：

```bash
# idle 与 work 的红色像素数应有明显差异，且 work 不过曝
# （过曝 = 高饱和红被冲成白点，看起来像没发光）
```

工作态红色像素应约为待机态的 2 倍，纯白过曝像素应 < 20 个。
