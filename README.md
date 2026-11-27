# NOVA · 迈阿密城市漫游

迈阿密真实风格立面贴图 + 城市流式渲染代码。

## 材质来源

建筑立面 Color 图为**照片级迈阿密建筑立面**（正立面、正交视角、无缝平铺）：
南海滩 Art Deco、Brickell 玻璃幕墙、高层住宅、砖石商业楼等迈阿密真实建筑风格。
法线 / 粗糙度 / 位移通道沿用 ambientCG CC0 摄影测量扫描数据，保证窗洞凹凸立体感。

| 用途 | 资产 ID | Color 来源 | 通道 |
|---|---|---|---|
| Brickell 玻璃幕墙塔 | Facade001 | 迈阿密玻璃幕墙实景 | Color / NormalGL / Roughness / Displacement |
| 现代办公塔深色玻璃 | Facade005 | 迈阿密深色玻璃塔实景 | Color / NormalGL / Roughness / Displacement |
| 南海滩 Art Deco 彩色 | Facade006 | 南海滩 Deco 实景 | Color / NormalGL / Roughness / Displacement |
| 砖石商业楼 | Facade018A | 迈阿密红砖石材实景 | Color / NormalGL / Roughness / AO |
| 高层住宅阳台 | Facade020A | 迈阿密住宅塔实景 | Color / NormalGL / Roughness / AO |
| Art Deco 白灰泥 | PaintedPlaster006 | 南海滩白灰泥 Deco 实景 | Color / NormalGL / Roughness / AO |
| 道路沥青 | Asphalt025C | ambientCG CC0 | Color / NormalGL / Roughness |
| 人行道方砖 | PavingStones070 | ambientCG CC0 | Color / NormalGL / Roughness |

## 目录

- `src/` — 渲染与城市流式加载全部 JS 源码
- `textures/real/` — 摄影级材质（webp 压缩版，游戏运行时加载）

## 关键文件

- `src/miami_layer.js` — 六档材质分桶，按楼高选真实立面；UV 按真实物理尺度（12–26m/周期）
- `src/nova_urban.js` — 街面着色器，采样实拍沥青/方砖 + 建筑轮廓距离场
- `src/main.js` — 主程序、时段预设、相机与出生点
