import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const errors = [];

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function dependencyMap(pkg) {
  return {
    ...(pkg.dependencies ?? {}),
    ...(pkg.devDependencies ?? {}),
    ...(pkg.peerDependencies ?? {}),
    ...(pkg.optionalDependencies ?? {}),
  };
}

function requireFile(path) {
  try {
    statSync(join(root, path));
  } catch {
    errors.push(`缺少强制合同或入口文件: ${path}`);
  }
}

function walk(path) {
  const output = [];
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const fullPath = join(path, entry.name);
    if (entry.isDirectory()) output.push(...walk(fullPath));
    else output.push(fullPath);
  }
  return output;
}

const requiredFiles = [
  'AGENTS.md',
  'PRODUCT.md',
  'DESIGN.md',
  'CONTRIBUTING.md',
  'SECURITY.md',
  'docs/contracts/v0.1/design-system.md',
  'docs/contracts/v0.1.1/README.md',
  'docs/contracts/v0.1.1/architecture.md',
  'docs/contracts/v0.1.1/config-and-secrets.md',
  'docs/contracts/v0.1.1/api-and-data.md',
  'docs/contracts/v0.1.1/model-and-paid-task.md',
  'docs/contracts/v0.1.1/testing-and-acceptance.md',
  'docs/contracts/v0.1.1/branching-and-handoffs.md',
  'docs/goals/2026-07-20-v0.1.1-public-release.md',
  'docs/goals/2026-07-15-v0.1-closeout-v0.1.1-design.md',
  'docs/runtime/docker-v0.1.md',
  'scripts/release-amd64.sh',
  'scripts/preflight-v011-ecs.sh',
  'deploy/fetch-secrets.sh',
];
requiredFiles.forEach(requireFile);

function requirePattern(path, pattern, description) {
  const source = readFileSync(join(root, path), 'utf8');
  if (!pattern.test(source)) errors.push(`${path} 缺少正式合同锚点: ${description}`);
}

function forbidPattern(path, pattern, description) {
  const source = readFileSync(join(root, path), 'utf8');
  if (pattern.test(source)) errors.push(`${path} 仍包含已废弃生产口径: ${description}`);
}

const productionContractAnchors = [
  ['AGENTS.md', /shortdrama-prod/, '生产 namespace shortdrama-prod'],
  ['AGENTS.md', /VCI `Deployment`/, 'VCI Deployment'],
  ['AGENTS.md', /HTTPS ALB `Ingress`/, 'HTTPS ALB Ingress'],
  ['AGENTS.md', /私网 RDS PostgreSQL/, '私网 RDS PostgreSQL'],
  ['AGENTS.md', /KMS initContainer/, 'KMS initContainer'],
  ['PRODUCT.md', /VKE 独立 `shortdrama-prod` namespace/, 'VKE 产品部署目标'],
  ['PRODUCT.md', /Docker Compose 仅用于本地开发和 dev\/test/, 'Compose dev/test 边界'],
  ['docs/contracts/v0.1.1/architecture.md', /正式生产清单真源是 `deploy\/k8s\/`/, 'VKE 清单真源'],
  ['docs/contracts/v0.1.1/architecture.md', /Docker Compose.*只保留给本地开发与 dev\/test/s, 'Compose 非生产边界'],
  ['docs/contracts/v0.1.1/config-and-secrets.md', /ConfigMap\/shortdrama-runtime/, '生产非 secret ConfigMap'],
  ['docs/contracts/v0.1.1/config-and-secrets.md', /shortdrama\/production/, '固定 KMS 凭据名'],
  ['docs/contracts/v0.1.1/config-and-secrets.md', /\/run\/shortdrama\/production-secrets\.sh/, '内存 secret 文件'],
  ['docs/contracts/v0.1.1/README.md', /正式生产部署真源/, '合同索引部署真源'],
  ['.env.release.example', /dev\/test Compose 变量兼容样例/, 'dev/test 样例边界'],
  ['README.md', /Docker 服务镜像（本地\/dev\/test）/, '根入口 Compose dev/test 边界'],
  ['deploy/README.md', /正式生产固定为 VKE\/VCI/, '部署入口 VKE 真源'],
  ['docs/goals/2026-07-20-v0.1.1-public-release.md', /^status: superseded$/m, '旧 ECS goal 已 superseded'],
  ['docs/goals/2026-07-20-v0.1.1-public-release.md', /^superseded_by: .+正式生产部署真源/m, '旧 goal 指向新真源'],
  ['docs/goals/2026-07-15-v0.1-closeout-v0.1.1-design.md', /^status: superseded$/m, '更早部署 goal 已 superseded'],
  ['docs/goals/2026-07-15-v0.1-closeout-v0.1.1-design.md', /^superseded_by: .+正式生产部署真源/m, '更早 goal 指向新真源'],
  ['docs/runtime/docker-v0.1.md', /仅用于本地开发和 dev\/test/, '旧 Docker 指南 dev/test 边界'],
  ['scripts/release-amd64.sh', /Local dev\/test only; do not use this command for production/, 'AMD64 脚本 dev/test 输出'],
  ['scripts/preflight-v011-ecs.sh', /This script is not a production readiness or deployment check/, 'ECS preflight 已降为 dev/test'],
  ['deploy/fetch-secrets.sh', /Production VKE uses deploy\/k8s\/secret-init instead/, '旧 secret 脚本非生产边界'],
  ['deploy/fetch-secrets.sh', /FORBIDDEN_PRODUCTION_SECRET="shortdrama\/production"/, '旧 helper 拒绝生产凭据'],
  ['deploy/fetch-secrets.sh', /dev\/test helper refuses output under \/opt/, '旧 helper 拒绝主机生产路径'],
];
for (const [path, pattern, description] of productionContractAnchors) {
  requirePattern(path, pattern, description);
}

const retiredProductionClaims = [
  ['AGENTS.md', /同一 ECS 与 Docker|单 ECS、单 Docker Compose/, 'ECS/Compose 生产运行时'],
  ['PRODUCT.md', /单 ECS \+ Docker 的公网 IP 部署形态/, '单 ECS 产品部署目标'],
  ['docs/contracts/v0.1.1/architecture.md', /部署到单台火山 ECS|Docker Compose 管理应用、PostgreSQL 和反向代理/, 'ECS/Compose 架构'],
  ['docs/contracts/v0.1.1/config-and-secrets.md', /生产 ECS|\/opt\/shortdrama\/production\.env/, '主机 production.env'],
  ['.env.release.example', /生产 ECS|\/opt\/shortdrama\/production\.env/, 'ECS env 样例'],
  ['deploy/README.md', /V0\.1\.1 的目标是单台|获准部署后的顺序/, 'Compose 生产部署说明'],
  ['docs/runtime/docker-v0.1.md', /单 ECS 部署|<ECS-公网-IP>|\/opt\/shortdrama\/runtime\.env/, '旧 Docker 生产运行指南'],
  ['scripts/release-amd64.sh', /after DC authorizes deployment|\/opt\/shortdrama\/runtime\.env/, 'Compose 生产部署提示'],
  ['scripts/preflight-v011-ecs.sh', /release readiness check|\/opt\/shortdrama\/runtime\.env|AMD64 ECS/, 'ECS preflight 生产话术'],
  ['deploy/fetch-secrets.sh', /DEFAULT_OUTPUT|\/opt\/shortdrama\/production\.env/, '生产 secret 输出默认值'],
];
for (const [path, pattern, description] of retiredProductionClaims) {
  forbidPattern(path, pattern, description);
}

const goalFiles = walk(join(root, 'docs/goals')).filter((path) => path.endsWith('.md'));
for (const path of goalFiles) {
  const source = readFileSync(path, 'utf8');
  if (
    /^status:\s*active\s*$/m.test(source) &&
    /单 ECS|AMD64 Docker Compose 应用栈|G7：Docker 与公网/.test(source)
  ) {
    errors.push(`active goal 仍声明已废弃 ECS/Compose 生产目标: ${relative(root, path)}`);
  }
}

const rootPackage = readJson(join(root, 'package.json'));
const frontendPackage = readJson(join(root, 'frontend/shortdrama-rag-demo/package.json'));
const rootDependencies = dependencyMap(rootPackage);
const frontendDependencies = dependencyMap(frontendPackage);

const requiredRootPackages = [
  'fastify',
  'zod',
  'drizzle-orm',
  'pg',
  '@volcengine/tos-sdk',
  '@zilliz/milvus2-sdk-node',
  '@earendil-works/pi-agent-core',
];
const requiredFrontendPackages = ['react', 'react-dom', 'vite'];

for (const name of requiredRootPackages) {
  if (!rootDependencies[name]) errors.push(`根运行时缺少批准依赖: ${name}`);
}
for (const name of requiredFrontendPackages) {
  if (!frontendDependencies[name]) errors.push(`前端缺少批准依赖: ${name}`);
}

const forbiddenPackages = [
  'next',
  'typeorm',
  '@supabase/supabase-js',
  '@volcengine/agentkit',
];
for (const name of forbiddenPackages) {
  if (rootDependencies[name] || frontendDependencies[name]) {
    errors.push(`生产运行时出现未批准依赖: ${name}`);
  }
}
for (const name of [...Object.keys(rootDependencies), ...Object.keys(frontendDependencies)]) {
  if (name.startsWith('@nestjs/')) errors.push(`生产运行时出现未批准依赖: ${name}`);
  if (name.toLowerCase().includes('agentkit')) errors.push(`生产运行时出现 AgentKit 依赖: ${name}`);
}

const productionRoots = [join(root, 'src'), join(root, 'frontend/shortdrama-rag-demo/src')];
const sourceFiles = productionRoots.flatMap((path) => walk(path));
const forbiddenSpecifiers = [
  /^next(?:\/|$)/,
  /^@nestjs(?:\/|$)/,
  /^typeorm$/,
  /^@supabase(?:\/|$)/,
  /agentkit/i,
];
const importPattern = /(?:from\s+|import\s*\(|require\s*\()\s*['"]([^'"]+)['"]/g;

for (const path of sourceFiles) {
  if (extname(path) === '.py') {
    errors.push(`生产源码目录禁止 Python 运行时文件: ${relative(root, path)}`);
    continue;
  }
  if (!['.ts', '.tsx', '.js', '.jsx'].includes(extname(path))) continue;
  const source = readFileSync(path, 'utf8');
  const sourcePath = relative(root, path).replaceAll('\\', '/');
  const isTestSource = /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(sourcePath);
  for (const match of source.matchAll(importPattern)) {
    const specifier = match[1];
    if (specifier && forbiddenSpecifiers.some((rule) => rule.test(specifier))) {
      errors.push(`生产源码引用未批准框架: ${relative(root, path)} -> ${specifier}`);
    }
    if (
      !isTestSource
      && !sourcePath.startsWith('src/integrations/')
      && !sourcePath.startsWith('src/composition/')
      && /(?:^|\/)integrations\/arkAssetRegistry(?:Adapter)?(?:\.js)?$/.test(specifier ?? '')
    ) {
      errors.push(`Ark 素材注册实现只能由 composition root 组装: ${sourcePath} -> ${specifier}`);
    }
    if (
      !isTestSource
      && sourcePath.startsWith('src/modules/')
      && /(?:^|\/)composition(?:\/|$)/.test(specifier ?? '')
    ) {
      errors.push(`业务模块禁止反向依赖 composition root: ${sourcePath} -> ${specifier}`);
    }
  }
  if (
    !isTestSource
    && /^src\/modules\/(?:seedance-assets\/|asset-uploads\/|assets\/volcAsset)/.test(sourcePath)
    && /['"`]ARK_[A-Z0-9_]+['"`]/.test(source)
  ) {
    errors.push(`素材注册业务合同禁止供应商前缀错误码: ${sourcePath}`);
  }
}

const directorRoot = join(root, 'frontend/shortdrama-rag-demo/src/components/director');
try {
  if (statSync(directorRoot).isDirectory()) {
    for (const name of ['three', '@react-three/fiber', 'zustand']) {
      if (!frontendDependencies[name]) errors.push(`3D 导演台已存在但缺少批准依赖: ${name}`);
    }
  }
} catch {
  // 导演台尚未迁入时不阻塞其他工作包；迁入后自动启用依赖检查。
}

if (errors.length > 0) {
  console.error('V0.1.1 架构门禁失败:\n');
  for (const error of [...new Set(errors)]) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`V0.1.1 架构门禁通过：检查 ${sourceFiles.length} 个生产源码文件。`);
