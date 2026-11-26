# NOVA · 迈阿密城市漫游

摄影测量（photogrammetry）真实材质 + 城市流式渲染代码。

## 材质来源

全部为 **ambientCG** 的 CC0 摄影测量扫描材质（2048²，可商用、无需署名），
原始页面 `https://ambientcg.com/`，资产清单：

| 用途 | 资产 ID | 通道 |
|---|---|---|
| 玻璃幕墙塔 A | Facade001 | Color / NormalGL / Roughness |
| 玻璃幕墙塔 B | Facade005 | Color / NormalGL / Roughness |
| 玻璃幕墙塔 C | Facade006 | Color / NormalGL / Roughness |
| 砖石框窗公寓 | Facade018A | Color / NormalGL / Roughness / AO |
| 砖柱白窗公寓 | Facade020A | Color / NormalGL / Roughness / AO |
| Art Deco 白灰泥 | PaintedPlaster006 | Color / NormalGL / Roughness / AO |
| 道路沥青 | Asphalt025C | Color / NormalGL / Roughness |
| 人行道方砖 | PavingStones070 | Color / NormalGL / Roughness |

## 目录

- `src/` — 渲染与城市流式加载全部 JS 源码
- `textures/real/` — 摄影级材质（webp 压缩版，游戏运行时加载）

## 关键文件

- `src/miami_layer.js` — 六档材质分桶，按楼高选真实立面；UV 按真实物理尺度（12–26m/周期）
- `src/nova_urban.js` — 街面着色器，采样实拍沥青/方砖 + 建筑轮廓距离场
- `src/main.js` — 主程序、时段预设、相机与出生点
