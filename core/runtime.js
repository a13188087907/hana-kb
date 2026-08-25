// 模块级单例：ES 模块按文件路径隔离，dev 槽位与正式安装各自持有独立实例
let runtime = null;

export function setRuntime(value) {
  runtime = value;
}

export function getRuntime() {
  if (!runtime) throw new Error("hana-kb plugin is not loaded");
  return runtime;
}

export function clearRuntime() {
  runtime = null;
}
