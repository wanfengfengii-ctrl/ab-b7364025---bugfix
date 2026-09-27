# 海岸遗址航拍覆盖认证

航拍组起飞前的覆盖认证工具：在浏览器中录入**逆时针凸多边形工作区**与 **3–12 条旋转矩形覆盖带**（整数中心、宽、高、角度），发起认证后在平面图与明细中查看各带、覆盖结论与风险区域。

判定**完全在本地**进行，采用**连续平面几何**方法（半平面剖分 / 线排列），**不使用栅格化、不使用固定采样**；**边界接触计入覆盖**。

## 认证规则

- 工作区每一点至少被 **1** 条覆盖带覆盖（否则为**漏拍**）；
- 任一点至多被 **2** 条覆盖带覆盖（否则为**三重曝光**，含零面积的接触点/接触线）；
- 草稿一旦改变，旧认证报告**立即撤销**；
- 存在风险时，报告标出**首个风险区域**的类型、面积与边界证据（漏拍优先于三重曝光，同类按最小顶点字典序）。

## 判定方法（连续、非采样）

1. 将工作区凸多边形用全部覆盖带边线逐条**切割**（半平面剖分），得到有限个凸单元；同一单元内覆盖数恒定。
2. 每个单元用**质心**做精确包含计数：0 层 → 漏拍单元；≥3 层 → 三重曝光单元。
3. 全部排列顶点（单元顶点 + 工作区顶点 + 覆盖带角点）做**闭集**计数，捕获零面积的三重接触（点/线段）。
4. 全部计算使用 64 位十进制高精度（decimal.js + 泰勒级数三角函数），容差 1e-24 量级，面积守恒可校验（单元面积和 = 工作区面积）。

## 运行（Docker）

```bash
# 构建并启动 web（宿主机端口默认 8080，可用 WEB_PORT 覆盖）
WEB_PORT=8080 docker compose up --build web

# 一次性验证服务：代码测试 + 前端构建 + 冒烟，退出码即结论
docker compose up --build verify
echo $?   # 0 = 全部通过
```

`web` 服务：nginx 静态站点，容器内 `wget` 健康检查（`/healthz`），`ports` 映射 `${WEB_PORT:-8080}:80`。
`verify` 服务：运行 `scripts/verify.mjs`（测试 → 构建 → 冒烟）后**自行退出**，以退出码报告结果。

## 本地开发

```bash
npm install
npm test          # 单元测试（node:test）
npm run build     # 前端构建（vite → dist/）
npm run smoke     # 冒烟：合格 + 风险场景提交认证模块
npm run verify    # 上述三步总编排（与 Docker verify 服务一致）
npm run dev       # 开发服务器
```

## 目录结构

```
src/geometry/decimal.js   高精度十进制与三角函数
src/geometry/core.js      连续平面几何内核（直线/凸多边形切割/旋转矩形）
src/certify.js            覆盖认证业务模块（剖分、分类、首个风险区域）
src/samples.js            示例场景（UI 与冒烟共用）
src/main.js               前端交互（草稿、撤销、平面图、明细）
test/certify.test.js      单元测试
scripts/smoke.mjs         冒烟脚本
scripts/verify.mjs        verify 编排（测试 + 构建 + 冒烟）
Dockerfile                多阶段：verify（一次性）/ web（nginx 静态）
docker-compose.yml        web（健康检查、WEB_PORT）+ verify（一次性）
docker/nginx.conf         容器内静态服务配置（/healthz）
```
